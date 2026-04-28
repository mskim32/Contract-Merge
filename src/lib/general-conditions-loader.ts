import fs from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";

export type GeneralConditionsLoadResult = {
  text: string;
  usedFallback: boolean;
  /** 추출 본문 전체의 비공백 문자 수(참조 데이터가 실제로 있는지 판단) */
  meaningfulCharCount: number;
  resolvedDir: string;
  pdfFileNames: string[];
  textFileNames: string[];
  warnings: string[];
};

function normalizeTextContent(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * 마크다운(.md/.markdown)을 AI 대조용 평문으로 정리
 * - 제목/목록/강조 등 문법 기호를 줄여 의미 텍스트만 남김
 */
function markdownToComparableText(markdown: string): string {
  return normalizeTextContent(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPdfMagic(buf: Buffer): boolean {
  if (buf.length < 5) return false;
  return buf.subarray(0, 5).toString("ascii").startsWith("%PDF");
}

/**
 * pdf-parse@2: Node에서 Uint8Array 복사 + 폰트 옵션으로 추출 안정화
 */
export async function extractPdfTextRobust(buffer: Buffer): Promise<string> {
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);
  const parser = new PDFParse({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const result = await parser.getText();
    let t = result.text ?? "";
    if (!t.trim()) {
      const p2 = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const r2 = await p2.getText();
        t = r2.text ?? "";
      } finally {
        await p2.destroy?.();
      }
    }
    return t;
  } finally {
    await parser.destroy?.();
  }
}

const FALLBACK_MESSAGE =
  "참조 가능한 공종별 일반조건 데이터가 존재하지 않습니다. 모든 항목을 [신규(고유)] 상태로 분류하세요.";

const MAX_GENERAL_CHARS = 300_000;

/**
 * `reference-data/general-conditions` (또는 `GENERAL_CONDITIONS_DIR`)에서
 * PDF 텍스트 + 선택적 .txt / .md 를 읽어 프롬프트용 본문을 만듭니다.
 */
export async function loadGeneralConditionsText(): Promise<GeneralConditionsLoadResult> {
  const warnings: string[] = [];
  const resolvedDir = process.env.GENERAL_CONDITIONS_DIR?.trim()
    ? path.resolve(process.env.GENERAL_CONDITIONS_DIR.trim())
    : path.join(process.cwd(), "reference-data", "general-conditions");

  const sections: string[] = [];
  const pdfFileNames: string[] = [];
  const textFileNames: string[] = [];
  let bodyCharTotal = 0;

  try {
    await fs.access(resolvedDir);
  } catch (e) {
    warnings.push(
      `일반조건 폴더에 접근할 수 없습니다: ${resolvedDir} (${e instanceof Error ? e.message : String(e)})`
    );
    console.warn("[general-conditions-loader]", warnings[0]);
    return {
      text: FALLBACK_MESSAGE,
      usedFallback: true,
      meaningfulCharCount: 0,
      resolvedDir,
      pdfFileNames: [],
      textFileNames: [],
      warnings,
    };
  }

  const entries = await fs.readdir(resolvedDir);
  const visible = entries.filter((f) => !f.startsWith("~$") && f !== ".gitkeep");

  const pdfs = visible
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b));
  const textFiles = visible
    .filter((f) => {
      const l = f.toLowerCase();
      return l.endsWith(".txt") || l.endsWith(".md") || l.endsWith(".markdown");
    })
    .sort((a, b) => a.localeCompare(b));

  console.log(
    `[general-conditions-loader] dir=${resolvedDir} pdf=${pdfs.length} txt/md=${textFiles.length}`
  );

  for (const file of pdfs) {
    const filePath = path.join(resolvedDir, file);
    try {
      const dataBuffer = await fs.readFile(filePath);
      if (dataBuffer.byteLength === 0) {
        warnings.push(`0바이트 PDF 건너뜀: ${file}`);
        continue;
      }
      if (!isPdfMagic(dataBuffer)) {
        warnings.push(
          `PDF 서명이 아님(손상·다른 형식을 .pdf로 둔 경우): ${file}`
        );
      }
      const text = await extractPdfTextRobust(dataBuffer);
      const meaningful = text.replace(/\s/g, "").length;
      bodyCharTotal += meaningful;
      if (meaningful === 0) {
        warnings.push(
          `텍스트 0자(스캔/이미지 PDF 가능): ${file} (${(dataBuffer.byteLength / 1024).toFixed(1)}KB)`
        );
      } else {
        console.log(
          `[general-conditions-loader] PDF OK "${file}" → 비공백 약 ${meaningful.toLocaleString()}자`
        );
      }
      pdfFileNames.push(file);
      sections.push(`--- [${file}] ---\n${text}`);
    } catch (err) {
      warnings.push(
        `PDF 읽기/파싱 실패: ${file} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const file of textFiles) {
    const filePath = path.join(resolvedDir, file);
    try {
      const text = await fs.readFile(filePath, "utf-8");
      const isMarkdown =
        file.toLowerCase().endsWith(".md") || file.toLowerCase().endsWith(".markdown");
      const normalized = isMarkdown
        ? markdownToComparableText(text)
        : normalizeTextContent(text);
      const meaningful = normalized.replace(/\s/g, "").length;
      if (meaningful === 0) {
        warnings.push(`빈 텍스트 파일: ${file}`);
        continue;
      }
      bodyCharTotal += meaningful;
      textFileNames.push(file);
      sections.push(`--- [${file}] ---\n${normalized}`);
      console.log(
        `[general-conditions-loader] ${isMarkdown ? "markdown" : "text"} OK "${file}" → 비공백 약 ${meaningful.toLocaleString()}자`
      );
    } catch (err) {
      warnings.push(
        `텍스트 파일 읽기 실패: ${file} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const usedFallback = bodyCharTotal === 0;

  let text: string;
  if (usedFallback) {
    text = FALLBACK_MESSAGE;
    if (pdfs.length + textFiles.length > 0) {
      warnings.push(
        "파일은 있으나 본문이 비어 대체만 사용합니다. 스캔 PDF는 OCR 후 .txt로 두거나 본문만 .txt에 저장하세요."
      );
    } else {
      warnings.push("일반조건 폴더에 .pdf / .txt / .md 가 없습니다.");
    }
  } else {
    text = sections.join("\n\n");
  }

  if (!usedFallback && text.length > MAX_GENERAL_CHARS) {
    text = text.substring(0, MAX_GENERAL_CHARS) + "\n...[TEXT TRUNCATED]";
    warnings.push(
      `일반조건 본문 ${MAX_GENERAL_CHARS.toLocaleString()}자 상한으로 잘림`
    );
  }

  for (const w of warnings) {
    console.warn("[general-conditions-loader]", w);
  }

  return {
    text,
    usedFallback,
    meaningfulCharCount: usedFallback ? 0 : bodyCharTotal,
    resolvedDir,
    pdfFileNames,
    textFileNames,
    warnings,
  };
}
