import { NextResponse } from "next/server";
import { getGeminiClient } from "@/lib/gemini-client";
import {
  clampTradeMajorMinor,
  loadClassificationTaxonomy,
  makeTaxonomyMergeKey,
  splitGroupKeyLoose,
  taxonomyPromptPayload,
} from "@/lib/classification-taxonomy";

export const runtime = "nodejs";
export const maxDuration = 300;

function chunkArray<T>(array: T[], size: number): T[][] {
  const result = [];
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

    const genAI = getGeminiClient();
    const taxonomy = await loadClassificationTaxonomy();
    const taxonomyJson = taxonomyPromptPayload(taxonomy);

    console.log(`[DUPLICATE-API] Processing ${items.length} extracted items...`);

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    // 50개씩 끊어서 병렬 처리 (Output Token Limit 방어)
    const BATCH_SIZE = 50;
    const itemChunks = chunkArray(items, BATCH_SIZE);
    console.log(`[DUPLICATE-API] Split into ${itemChunks.length} chunks of max ${BATCH_SIZE} items.`);

    let allGroupedData: any[] = [];

    const MAX_CONCURRENT = 5;

    for (let i = 0; i < itemChunks.length; i += MAX_CONCURRENT) {
      const batchChunks = itemChunks.slice(i, i + MAX_CONCURRENT);
      console.log(`[DUPLICATE-API] Processing chunks ${i + 1} to ${i + batchChunks.length} (out of ${itemChunks.length}) concurrently...`);
      
      const batchPromises = batchChunks.map(async (chunk, batchIdx) => {
        const absoluteIdx = i + batchIdx + 1;
        const prompt = `
당신은 건설 견적조건 데이터 정리(클렌징) 전문가 AI입니다.

[역할]
아래에는 동일 의미로 묶인 견적조건 그룹들이 주어집니다.
각 그룹 내에서 현장별로 조금씩 다른 변형 문구(variations)가 존재합니다.

당신의 임무는 각 그룹에서 가장 완성도 높고 포괄적인 대표 문구 1개를 선정하고,
나머지를 "중복 제거 추천" 목록으로 분류하는 것입니다.

[대표 문구 선정 기준]
1. 법적으로 가장 안전하고 명확한 표현
2. 구체적인 수치/기준이 포함된 문구 우선
3. 건설업 표준 용어를 사용한 문구 우선
4. 여러 현장에서 반복 등장하는 문구 우선

[분류 체계 — 반드시 준수]
아래 JSON의 trades[].label(공종), 해당 공종 아래 majors[].label(대분류), 해당 대분류 아래 minors[].label(소분류) 값으로만 분류하세요.
허용 목록에 없는 문자열을 임의로 만들지 마세요. 애매하면 JSON의 fallback.trade / fallback.majorCategory / fallback.minorCategory 조합을 사용하세요.

=== 허용 분류 목록 (JSON) ===
${taxonomyJson}

[출력 형식]
반드시 JSON 배열만 반환하세요(코드블록, 설명 문장 금지).
각 객체는 반드시 다음 필드를 포함합니다:
- "trade": 허용 목록의 공종 label 과 정확히 일치하는 문자열
- "majorCategory": 해당 trade 아래 허용 대분류 label 과 정확히 일치하는 문자열
- "minorCategory": 해당 major 아래 허용 소분류 label 과 정확히 일치하는 문자열
- "representativeContent": 선정된 대표 문구
- "representativeSource": 대표 문구의 출처 현장명
- "reason": 이 문구를 대표로 선정한 이유 (1문장)
- "removeCandidates": 아래 형태의 배열

[
  {
    "trade": "…",
    "majorCategory": "…",
    "minorCategory": "…",
    "representativeContent": "선정된 대표 문구",
    "representativeSource": "대표 문구의 출처 현장명",
    "reason": "이 문구를 대표로 선정한 이유 (1문장)",
    "removeCandidates": [
      {
        "sourceFile": "현장명",
        "content": "중복으로 제거 추천되는 문구",
        "similarity": "완전동일" | "의미동일" | "부분중복"
      }
    ]
  }
]

주의사항:
- 모든 항목을 그룹화해서 반환하세요. 누락 금지.
- "groupKey" 필드는 출력하지 마세요(서버에서 생성).
- removeCandidates에는 representativeContent와 중복/유사한 나머지 문구를 넣으세요.

=== 분류화된 그룹 데이터 ===
"""
${JSON.stringify(chunk, null, 2)}
"""
`;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();

          let chunkData = [];
          try {
            chunkData = JSON.parse(responseText);
          } catch (e) {
            let cleanedText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            if (cleanedText && !cleanedText.endsWith("]")) {
              if (cleanedText.endsWith("}")) cleanedText += "]";
              else if (cleanedText.endsWith('"')) cleanedText += "}]";
              else cleanedText += '"}]';
            }
            try {
              chunkData = JSON.parse(cleanedText);
            } catch (e2) {
              console.error(`[DUPLICATE-API] JSON Parse Error for chunk ${absoluteIdx}`);
              return [];
            }
          }
          return chunkData;
        } catch (chunkError) {
          console.error(`[DUPLICATE-API] AI failed for chunk ${absoluteIdx}:`, chunkError);
          return [];
        }
      });

      const results = await Promise.all(batchPromises);
      results.forEach(chunkData => {
        if (Array.isArray(chunkData)) {
          allGroupedData = [...allGroupedData, ...chunkData];
        } else if (chunkData && typeof chunkData === 'object') {
          allGroupedData.push(chunkData);
        }
      });
    }

    // 서버 사이드에서 2차 병합
    // AI 출력이 기존 스키마(trade/major/minor/variations) 또는
    // 신규 스키마(groupKey/representative/removeCandidates) 어느 쪽이든 안전하게 정규화한다.
    const finalMergeMap: Record<string, any> = {};
    allGroupedData.forEach(item => {
      const rawTrade = typeof item.trade === "string" ? item.trade.trim() : "";
      const rawMajor =
        typeof item.majorCategory === "string"
          ? item.majorCategory.trim()
          : typeof item.major === "string"
            ? item.major.trim()
            : "";
      const rawMinor =
        typeof item.minorCategory === "string"
          ? item.minorCategory.trim()
          : typeof item.minor === "string"
            ? item.minor.trim()
            : "";

      const hasExplicit =
        rawTrade.length > 0 || rawMajor.length > 0 || rawMinor.length > 0;

      const loose = hasExplicit
        ? { trade: rawTrade, majorCategory: rawMajor, minorCategory: rawMinor }
        : typeof item.groupKey === "string" && item.groupKey.trim().length > 0
          ? splitGroupKeyLoose(item.groupKey.trim())
          : { trade: "", majorCategory: "", minorCategory: "" };

      const clamped = clampTradeMajorMinor(taxonomy, loose);
      const mergeKey = makeTaxonomyMergeKey(clamped);
      const normalizedGroupKey = `${clamped.trade} — ${clamped.majorCategory} — ${clamped.minorCategory}`;

      const trade = clamped.trade;
      const majorCategory = clamped.majorCategory;
      const minorCategory = clamped.minorCategory;

      const representativeContent = item.representativeContent || "";
      const representativeSource = item.representativeSource || "대표문구";
      const removeCandidates = Array.isArray(item.removeCandidates) ? item.removeCandidates : [];

      // 신규 스키마이면 대표문구 + 제거후보를 variations로 변환해 기존 UI와 호환
      const variationsFromNewSchema =
        representativeContent
          ? [
              { sourceFile: representativeSource, content: representativeContent },
              ...removeCandidates.map((c: any) => ({
                sourceFile: c?.sourceFile || "미상",
                content: c?.content || ""
              }))
            ]
          : [];

      const variations =
        Array.isArray(item.variations) && item.variations.length > 0
          ? item.variations
          : variationsFromNewSchema;

      const normalizedItem = {
        trade,
        majorCategory,
        middleCategory:
          typeof item.middleCategory === "string" && item.middleCategory.trim().length > 0
            ? item.middleCategory.trim()
            : "-",
        minorCategory,
        variations,
        groupKey: normalizedGroupKey,
        representativeContent: item.representativeContent || null,
        representativeSource: item.representativeSource || null,
        reason: item.reason || null,
        removeCandidates
      };

      if (finalMergeMap[mergeKey]) {
        // 이미 있으면 variations 배열만 합쳐주고 중복제거
        finalMergeMap[mergeKey].variations = [...finalMergeMap[mergeKey].variations, ...(normalizedItem.variations || [])];
        finalMergeMap[mergeKey].removeCandidates = [
          ...(finalMergeMap[mergeKey].removeCandidates || []),
          ...(normalizedItem.removeCandidates || [])
        ];
        if (!finalMergeMap[mergeKey].representativeContent && normalizedItem.representativeContent) {
          finalMergeMap[mergeKey].representativeContent = normalizedItem.representativeContent;
          finalMergeMap[mergeKey].representativeSource = normalizedItem.representativeSource;
          finalMergeMap[mergeKey].reason = normalizedItem.reason;
        }
      } else {
        finalMergeMap[mergeKey] = normalizedItem;
      }
    });

    // 병합이 끝난 데이터를 배열로 변환하고, variations 길이(count)를 세팅하여 정렬
    const finalResults = Object.values(finalMergeMap).map((item: any) => {
      // sourceFile과 content가 완전 일치하는 variation의 중복을 제거
      const uniqueVarsMap = new Map();
      item.variations.forEach((v: any) => {
        uniqueVarsMap.set(`${v.sourceFile}||${v.content}`, v);
      });
      const uniqueVars = Array.from(uniqueVarsMap.values());
      return {
        ...item,
        variations: uniqueVars,
        count: uniqueVars.length
      };
    }).sort((a, b) => b.count - a.count);

    console.log(`[DUPLICATE-API] Successfully grouped into ${finalResults.length} overarching categories.`);
    return NextResponse.json({ success: true, data: finalResults });
  } catch (error: any) {
    console.error("[DUPLICATE-API] Error:", error);
    return NextResponse.json({ error: "Backend error: " + (error?.message || String(error)) }, { status: 500 });
  }
}
