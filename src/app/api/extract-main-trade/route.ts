import { NextResponse } from "next/server";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getGeminiClient } from "@/lib/gemini-client";

export const maxDuration = 30;

/** DOCX ZIP 내부 word/header*.xml에서 공백 정리 텍스트만 추출 */
async function extractHeaderXmlPlainText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
      .filter((n) => /^word\/header(\d+)?\.xml$/i.test(n))
      .sort();
    const parts: string[] = [];
    for (const name of names) {
      const f = zip.file(name);
      if (!f) continue;
      const xml = await f.async("string");
      const text = xml
        .replace(/<w:tab[^/]*\/>/g, " ")
        .replace(/<w:br[^/]*\/>/g, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) parts.push(text);
    }
    return parts.join(" | ");
  } catch (e) {
    console.warn("[extract-main-trade] 머리글 XML 파싱 실패:", e);
    return "";
  }
}

export async function POST(req: Request) {
  try {
    const { base64 } = await req.json();

    if (!base64) {
      return NextResponse.json(
        { success: false, mainTrade: "알 수 없음" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(base64, "base64");
    const headerPlain = await extractHeaderXmlPlainText(buffer);
    const bodyResult = await mammoth.extractRawText({ buffer });
    const bodyTop = bodyResult.value.substring(0, 3500);

    const context = `--- 워드 머리글에서 추출한 텍스트 (우선) ---
${headerPlain || "(머리글에서 유효 텍스트 없음 — 아래 본문 앞부분을 참고하세요)"}

--- 본문 맨 앞부분(참고, 공종·표·제목이 있을 수 있음) ---
${bodyTop}
`;

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const prompt = `
당신은 건설 견적/계약 워드 문서의 "주공종(대표 공종)"을 찾는 추출기입니다.

[규칙]
- 이 문서 전체의 검토·입찰 대상이 되는 **주공종 하나**만 골라 한글로 짧게 적으세요.
- 머리글(헤더)에 공종·공사명이 있으면 그것을 최우선으로 따르세요.
- 머리글에 없고 본문 앞부분(표, 제목)에만 있으면 그중 대표에 해당하는 공종을 고르세요.
- 공통/일반/기타만 있고 구체적 공종이 없으면 "알 수 없음"을 반환하세요.
- 여러 공종이 나열되어 있어도 **하나**만 골라야 합니다(가장 핵심·대표로 보이는 것).
- 설명문·따옴표 없이 공종명만 (예: 철근콘크리트공사, 골조공사).

출력은 아래 JSON 한 개만:
{ "mainTrade": "주공종 한 줄" }

[문서 일부]
"""
${context}
"""
`;

    const modelResult = await model.generateContent(prompt);
    const responseText = modelResult.response.text();

    let parsed: { mainTrade?: string } = {};
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    }

    const main = (parsed.mainTrade || "").trim() || "알 수 없음";
    return NextResponse.json({ success: true, mainTrade: main });
  } catch (error) {
    console.error("[extract-main-trade] Error:", error);
    return NextResponse.json(
      { success: false, mainTrade: "알 수 없음 (에러)" },
      { status: 500 }
    );
  }
}
