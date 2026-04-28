import { NextResponse } from "next/server";
import mammoth from "mammoth";
import { getGeminiClient } from "@/lib/gemini-client";

export const maxDuration = 300;

function chunkText(text: string, maxLength: number): string[] {
  const chunks = [];
  let currentPos = 0;
  while (currentPos < text.length) {
    chunks.push(text.slice(currentPos, currentPos + maxLength));
    currentPos += maxLength;
  }
  return chunks;
}

export async function POST(req: Request) {
  try {
    const { files } = await req.json();

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    console.log(`[API] Processing ${files.length} files...`);
    let combinedRawText = "";
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buffer = Buffer.from(file.base64, "base64");
      const result = await mammoth.extractRawText({ buffer });
      combinedRawText += `\n--- Document: ${file.name} ---\n${result.value}`;
    }

    console.log(`[API] Extracted total text length: ${combinedRawText.length}`);

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    // [최적화 튜닝 적용] 1단계 추출(단순 리스트화)은 난이도가 매우 낮으므로, 토큰/시간 낭비를 막기 위해 거대 청크(15000자)로 파싱합니다.
    const CHUNK_SIZE = 15000;
    const textChunks = chunkText(combinedRawText, CHUNK_SIZE);
    console.log(`[API] Split into ${textChunks.length} chunks to prevent token limit truncation & improve speed.`);

    let allParsedData: any[] = [];

    const MAX_CONCURRENT = 10; // 유료결제 속도 극대화를 위해 최대 10개 청크 동시 처리

    for (let i = 0; i < textChunks.length; i += MAX_CONCURRENT) {
      const batchChunks = textChunks.slice(i, i + MAX_CONCURRENT);
      console.log(`[API] Processing chunks ${i + 1} to ${i + batchChunks.length} (out of ${textChunks.length}) concurrently...`);

      const batchPromises = batchChunks.map(async (chunk, batchIdx) => {
        const absoluteIdx = i + batchIdx + 1;
        const prompt = `
당신은 최고의 건설 계약서 데이터 추출 AI입니다.
아래 텍스트에서 공사, 자재, 안전, 계약과 관련된 **조건, 지시사항, 특약, 규칙 등**의 문장만 남김없이 찾아내어 리스트화하세요.

반드시 아래의 2개 키값을 가지는 JSON 객체 배열(Array) 형태로만 출력하세요:
- "content" (내용): 원문 내용을 깔끔하게 문장형으로 다듬은 조건 텍스트.
- "sourceFile" (현장명): 제공된 문서 본문의 머리글(표) 등에 기재된 '현장명: OOO' 텍스트를 파악하여 현장명만 정확히 추출. (예: 북오산자이리버블시티(경기))

복잡한 카테고리 분류는 하지 않습니다. 조건문에 해당하는 텍스트만 누락 없이 모두 뽑아내는 것에 집중하세요. 아무런 조건이 없는 목차나 표지일 때만 예외적으로 []을 반환하세요.

미리 아래 구분자를 통해 이 텍스트 조각이 어느 문서에서 왔는지 제시해 드립니다:
=== 분석할 텍스트 조각 ===
"""
${chunk}
"""
`;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();

          if (process.env.NODE_ENV === "development") {
            console.debug(`[analyze-docx] chunk ${absoluteIdx} response (prefix):`, responseText.substring(0, 400));
          }

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
              console.error(`[API] Failed to parse JSON for chunk ${absoluteIdx}.`, cleanedText?.slice(0, 500));
              return [];
            }
          }
          return chunkData;
        } catch (chunkError: any) {
          console.error(`[API] AI generation failed for chunk ${absoluteIdx}:`, chunkError);
          return [];
        }
      });

      const results = await Promise.all(batchPromises);
      results.forEach(chunkData => {
        if (Array.isArray(chunkData)) {
          allParsedData = [...allParsedData, ...chunkData];
        } else if (chunkData && typeof chunkData === 'object' && !Array.isArray(chunkData)) {
          allParsedData.push(chunkData);
        }
      });
    }

    console.log(`[API] Successfully parsed total ${allParsedData.length} items across all chunks.`);
    return NextResponse.json({ success: true, data: allParsedData });
  } catch (error: any) {
    console.error("[API] Error processing documents server-side:", error);
    return NextResponse.json({ error: "Backend error: " + (error?.message || String(error)) }, { status: 500 });
  }
}
