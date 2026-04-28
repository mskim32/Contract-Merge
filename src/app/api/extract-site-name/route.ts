import { NextResponse } from "next/server";
import mammoth from "mammoth";
import { getGeminiClient } from "@/lib/gemini-client";

export const maxDuration = 30; // 간략한 분석이므로 30초면 충분

export async function POST(req: Request) {
  try {
    const { base64 } = await req.json();

    if (!base64) {
      return NextResponse.json({ siteName: "알 수 없음 (문서 없음)" });
    }

    const buffer = Buffer.from(base64, "base64");
    
    // Mammoth를 사용해 텍스트 추출
    const result = await mammoth.extractRawText({ buffer });
    
    // 현장명은 보통 가장 상단(앞부분)에 존재하므로 3000자까지만 자름
    const headerText = result.value.substring(0, 3000);

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const prompt = `
당신은 현장명/프로젝트명 추출기입니다.
아래의 텍스트는 계약서 문서의 맨 앞부분입니다. 텍스트를 읽고 공사 현장의 이름이나 프로젝트 제목(예: "철산역자이2단지(경기)", "강남 아파트 신축공사" 등)에 해당하는 짧고 명확한 고유명사를 추출하세요.
일반적으로 '현장명:', '프로젝트명:', '제 목:' 주변에 위치합니다.

반드시 이름에 해당하는 문자열 하나만 찾으세요. 없으면 "알 수 없음" 이라고 반환하세요.

출력은 무조건 아래 포맷의 JSON이어야 합니다:
{
  "siteName": "추출한 현장명 문자열"
}

텍스트:
"""
${headerText}
"""
`;

    const modelResult = await model.generateContent(prompt);
    const responseText = modelResult.response.text();
    
    let parsedData = { siteName: "알 수 없음" };
    try {
      parsedData = JSON.parse(responseText);
    } catch (e) {
      const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      parsedData = JSON.parse(cleaned);
    }

    return NextResponse.json({ success: true, siteName: parsedData.siteName || "알 수 없음" });
  } catch (error) {
    console.error("[extract-site-name] Error:", error);
    return NextResponse.json({ success: false, siteName: "알 수 없음 (에러)" }, { status: 500 });
  }
}
