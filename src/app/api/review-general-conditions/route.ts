import { NextResponse } from "next/server";
import { getGeminiClient } from "@/lib/gemini-client";
import { loadGeneralConditionsText } from "@/lib/general-conditions-loader";

export const runtime = "nodejs";
export const maxDuration = 300;

function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export async function POST(req: Request) {
  try {
    const { items } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "No items provided" }, { status: 400 });
    }

    console.log(`[REVIEW-GENERAL] Processing ${items.length} items...`);

    const loaded = await loadGeneralConditionsText();
    let generalConditionText = loaded.text;

    if (!loaded.usedFallback) {
      console.log(
        `[REVIEW-GENERAL] 로드 완료: PDF ${loaded.pdfFileNames.length}개, txt/md ${loaded.textFileNames.length}개, 비공백 약 ${loaded.meaningfulCharCount.toLocaleString()}자, 경로 ${loaded.resolvedDir}`
      );
    } else {
      console.warn(
        `[REVIEW-GENERAL] ⚠ 참조 본문 없음(대체 안내 사용) dir=${loaded.resolvedDir}`
      );
    }

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const BATCH_SIZE = 30;
    const itemChunks = chunkArray(items, BATCH_SIZE);

    let allReviews: unknown[] = [];
    const MAX_CONCURRENT = 5;

    for (let i = 0; i < itemChunks.length; i += MAX_CONCURRENT) {
      const batchChunks = itemChunks.slice(i, i + MAX_CONCURRENT);

      const batchPromises = batchChunks.map(async (chunk) => {
        const payloadItems = chunk.map((c: { index?: string; content?: string }) => ({
          itemIndex: c.index !== undefined ? c.index : Math.random().toString(36).slice(2, 11),
          content: c.content,
        }));

        const prompt = `
당신은 건설 계약 분야의 견적조건 대조 전문가 AI입니다.

[역할]
아래 두 가지 데이터가 주어집니다:
1. 「현장 견적조건」: 특정 현장에서 추출·분류된 견적 조건 항목들
2. 「공종별 일반조건」: 해당 공종의 표준/일반 견적조건 원문
   (PDF 또는 텍스트/마크다운 원문을 추출·정규화한 참고 본문)

당신의 임무는 「현장 견적조건」의 각 항목이 「공종별 일반조건」에 이미 포함되어 있는지를 
의미 기반으로 대조하는 것입니다.

[판정 기준]
- "완전중복": 현장 조건의 내용이 일반조건에 문구는 다르더라도 실질적으로 동일한 의미/효력으로 이미 존재
- "부분중복": 일반조건에 유사한 규정이 있으나 현장 조건이 추가 조건을 더 부과하거나 범위가 다름
- "신규(고유)": 일반조건에 대응하는 규정이 전혀 없는 현장 고유 조건

[출력 형식]
반드시 아래 JSON 배열로만 출력하세요:
[
  {
    "itemIndex": "제공된 itemIndex 번호/글자",
    "content": "현장 견적조건 원문",
    "matchType": "완전중복" | "부분중복" | "신규(고유)",
    "matchedGeneralClause": "대응되는 일반조건 원문 발췌 (없으면 null)",
    "explanation": "판정 근거를 1~2문장으로 설명"
  }
]

=== 공종별 일반조건 원문 ===
"""
${generalConditionText}
"""

=== 현장 견적조건 항목 리스트 ===
"""
${JSON.stringify(payloadItems, null, 2)}
"""
`;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          let parsed: unknown[] = [];
          try {
            parsed = JSON.parse(responseText) as unknown[];
          } catch {
            const cleaned = responseText
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim();
            parsed = JSON.parse(cleaned) as unknown[];
          }
          return parsed;
        } catch (e) {
          console.error("[REVIEW-GENERAL] API Error", e);
          return [];
        }
      });

      const results = await Promise.all(batchPromises);
      for (const chunkData of results) {
        if (Array.isArray(chunkData)) {
          allReviews = [...allReviews, ...chunkData];
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: allReviews,
      generalConditionsInfo: {
        usedFallback: loaded.usedFallback,
        resolvedDir: loaded.resolvedDir,
        pdfFiles: loaded.pdfFileNames,
        textFiles: loaded.textFileNames,
        meaningfulCharCount: loaded.meaningfulCharCount,
        warningCount: loaded.warnings.length,
      },
    });
  } catch (error: unknown) {
    console.error("[REVIEW-GENERAL] Fatal:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Backend error: " + message },
      { status: 500 }
    );
  }
}
