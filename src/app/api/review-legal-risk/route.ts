import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGeminiClient } from "@/lib/gemini-client";

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

    console.log(`[REVIEW-LEGAL] Processing ${items.length} items...`);

    // 1. Read Legal Standards MD files
    const dirPath = path.join(process.cwd(), "reference-data", "legal-standards");
    let legalStandardsText = "";
    try {
      const files = await fs.readdir(dirPath);
      const mdFiles = files.filter(f => f.toLowerCase().endsWith(".md") || f.toLowerCase().endsWith(".txt"));
      
      for (const file of mdFiles) {
        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, "utf-8");
        legalStandardsText += `\n\n--- [법령/지침: ${file}] ---\n${content}`;
      }
    } catch (e) {
      console.warn("[REVIEW-LEGAL] Could not read legal standards directory", e);
    }
    
    if (!legalStandardsText || legalStandardsText.trim().length === 0) {
      legalStandardsText = "참조 가능한 법령 데이터가 없습니다. 법령 위반 내용을 판단할 수 없습니다.";
    }

    if (legalStandardsText.length > 300000) {
        legalStandardsText = legalStandardsText.substring(0, 300000) + "\n...[TEXT TRUNCATED]";
    }

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const BATCH_SIZE = 30;
    const itemChunks = chunkArray(items, BATCH_SIZE);
    
    let allReviews: any[] = [];
    const MAX_CONCURRENT = 5;

    for (let i = 0; i < itemChunks.length; i += MAX_CONCURRENT) {
      const batchChunks = itemChunks.slice(i, i + MAX_CONCURRENT);
      
      const batchPromises = batchChunks.map(async (chunk) => {
        const payloadItems = chunk.map((c: any, index: number) => ({
             itemIndex: c.index !== undefined ? c.index : Math.random().toString(36).substr(2, 9),
             content: c.content
        }));

        const prompt = `
당신은 대한민국 건설 하도급 계약법 분야의 법률 자문 전문가 AI입니다.

[역할]
아래에 제공되는 「현장 견적조건 항목들」을 검토하여,
관련 법령(하도급법, 건설산업기본법, 부당특약 심사지침 등)에 위반되거나
위반 가능성이 있는 조항을 탐지하세요.

[검토 대상 법령 및 지침]
"""
${legalStandardsText}
"""

[판정 등급]
- "🔴 위반(고위험)": 해당 법령의 특정 조항에 명백히 저촉되는 경우
- "🟡 주의(중위험)": 법 위반 가능성이 있거나, 분쟁 시 불리하게 해석될 수 있는 경우
- "🟢 적법(저위험)": 관련 법령상 문제없음

[출력 형식]
반드시 아래 JSON 배열로만 출력하세요:
[
  {
    "itemIndex": 0,
    "content": "견적조건 원문",
    "riskLevel": "🔴 위반(고위험)" | "🟡 주의(중위험)" | "🟢 적법(저위험)",
    "violatedLaw": "위반 근거 법령명 및 조항 (예: 하도급법 제13조 제1항)",
    "riskDescription": "구체적으로 어떤 점이 법적 리스크인지 2~3문장으로 설명",
    "suggestedFix": "법적 리스크가 있는 경우, 적법하게 수정한 대체 문구를 제안. 적법한 경우 null"
  }
]

주의사항:
- 모든 항목에 대해 검토 결과를 빠짐없이 출력해야 합니다.
- 적법한 조항이라도 반드시 "🟢 적법(저위험)"으로 포함시키세요.
- suggestedFix는 원문의 의도를 최대한 살리되, 법적으로 안전한 문구로 수정하세요.
- 판정은 반드시 제공된 법령/지침 텍스트에 근거해야 하며, 근거 없는 추론은 금지합니다.

=== 검토 대상 견적조건 항목 ===
"""
${JSON.stringify(payloadItems)}
"""
`;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          let parsed = [];
          try {
              parsed = JSON.parse(responseText);
          } catch(e) {
              const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
              parsed = JSON.parse(cleaned);
          }
          return parsed;
        } catch (e) {
          console.error("[REVIEW-LEGAL] API Error", e);
          return [];
        }
      });

      const results = await Promise.all(batchPromises);
      results.forEach(chunkData => {
        if (Array.isArray(chunkData)) {
          allReviews = [...allReviews, ...chunkData];
        }
      });
    }

    return NextResponse.json({ success: true, data: allReviews });
  } catch (error: any) {
    console.error("[REVIEW-LEGAL] Fatal:", error);
    return NextResponse.json({ error: "Backend error: " + (error?.message || String(error)) }, { status: 500 });
  }
}
