import fs from "fs/promises";
import path from "path";

export type GeneralConditionsLoadResult = {
  text: string;
  usedFallback: boolean;
  /** 추출 본문 전체의 비공백 문자 수(참조 데이터가 실제로 있는지 판단) */
  meaningfulCharCount: number;
  resolvedDir: string;
  /** PDF 로드는 사용하지 않음(서버 환경 호환). 항상 빈 배열. */
  pdfFileNames: string[];
  /** 로드에 사용한 `.md` / `.markdown` 파일명 */
  markdownFileNames: string[];
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

function isMarkdownFileName(file: string): boolean {
  const l = file.toLowerCase();
  return l.endsWith(".md") || l.endsWith(".markdown");
}

const FALLBACK_MESSAGE =
  "참조 가능한 공종별 일반조건 데이터가 존재하지 않습니다. 모든 항목을 [신규(고유)] 상태로 분류하세요.";

const MAX_GENERAL_CHARS = 300_000;

/**
 * `reference-data/general-conditions` (또는 `GENERAL_CONDITIONS_DIR`)에서
 * **Markdown(.md / .markdown)만** 읽어 프롬프트용 본문을 만듭니다.
 * PDF는 Node 서버(pdfjs DOMMatrix 등) 이슈를 피하기 위해 로드하지 않습니다.
 */
export async function loadGeneralConditionsText(): Promise<GeneralConditionsLoadResult> {
  const warnings: string[] = [];
  const resolvedDir = process.env.GENERAL_CONDITIONS_DIR?.trim()
    ? path.resolve(process.env.GENERAL_CONDITIONS_DIR.trim())
    : path.join(process.cwd(), "reference-data", "general-conditions");

  const sections: string[] = [];
  const markdownFileNames: string[] = [];
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
      markdownFileNames: [],
      warnings,
    };
  }

  const entries = await fs.readdir(resolvedDir);
  const visible = entries.filter((f) => !f.startsWith("~$") && f !== ".gitkeep");

  const ignoredPdfs = visible.filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (ignoredPdfs.length > 0) {
    warnings.push(
      `PDF ${ignoredPdfs.length}개는 로드하지 않습니다. 내용을 Markdown(.md)으로 두세요. (${ignoredPdfs.join(", ")})`
    );
  }

  const mdFiles = visible.filter(isMarkdownFileName).sort((a, b) => a.localeCompare(b));

  console.log(
    `[general-conditions-loader] dir=${resolvedDir} markdown=${mdFiles.length} (pdf ignored=${ignoredPdfs.length})`
  );

  for (const file of mdFiles) {
    const filePath = path.join(resolvedDir, file);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const normalized = markdownToComparableText(raw);
      const meaningful = normalized.replace(/\s/g, "").length;
      if (meaningful === 0) {
        warnings.push(`빈 Markdown 파일: ${file}`);
        continue;
      }
      bodyCharTotal += meaningful;
      markdownFileNames.push(file);
      sections.push(`--- [${file}] ---\n${normalized}`);
      console.log(
        `[general-conditions-loader] markdown OK "${file}" → 비공백 약 ${meaningful.toLocaleString()}자`
      );
    } catch (err) {
      warnings.push(
        `Markdown 읽기 실패: ${file} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const usedFallback = bodyCharTotal === 0;

  let text: string;
  if (usedFallback) {
    text = FALLBACK_MESSAGE;
    if (mdFiles.length > 0) {
      warnings.push(
        "Markdown 파일은 있으나 본문이 비어 대체만 사용합니다. 파일 내용을 확인해 주세요."
      );
    } else if (ignoredPdfs.length > 0) {
      warnings.push(
        "폴더에 PDF만 있습니다. 일반조건 본문은 .md/.markdown 파일로 추가해 주세요."
      );
    } else {
      warnings.push("일반조건 폴더에 .md / .markdown 파일이 없습니다.");
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
    pdfFileNames: [],
    markdownFileNames,
    warnings,
  };
}
