import { NextResponse } from "next/server";
import { getGeminiClient } from "@/lib/gemini-client";

export const maxDuration = 120;

type RevisePayload = {
  originalContent: string;
  violatedLaw: string | null;
  riskDescription: string;
  previousSuggestedFix: string | null;
  userRequest: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<RevisePayload>;
    const {
      originalContent,
      violatedLaw,
      riskDescription,
      previousSuggestedFix,
      userRequest,
    } = body;

    if (!originalContent || !riskDescription || !userRequest) {
      return NextResponse.json(
        {
          error:
            "Missing required fields. Required: originalContent, riskDescription, userRequest",
        },
        { status: 400 }
      );
    }

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const prompt = `
당신은 건설 계약서 문구 수정 전문가 AI입니다.

[역할]
아래 견적조건 원문에 법적 리스크가 발견되었습니다.
사용자가 추가 요구사항을 제시했으므로, 이를 반영하여 수정 문구를 재작성하세요.

[원문]
"""
${originalContent}
"""

[법적 리스크 사항]
- 위반 법령: ${violatedLaw || "명시되지 않음"}
- 리스크 설명: ${riskDescription}

[기존 AI 제안 문구]
"""
${previousSuggestedFix || ""}
"""

[사용자 추가 요구사항]
"""
${userRequest}
"""

[출력 형식]
{
  "revisedContent": "사용자 요구를 반영하여 재수정한 문구",
  "changeExplanation": "어떤 부분을 왜 수정했는지 설명 (2~3문장)"
}

주의사항:
- 원문의 사업적 의도는 최대한 보존하되, 법적 안전성을 확보하세요.
- 건설업 표준 용어를 사용하세요.
- 수정 문구는 실무에서 바로 계약서에 삽입할 수 있을 정도로 완성도 높게 작성하세요.
- 반드시 JSON 객체만 출력하세요(코드블록/설명문 금지).
`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let data: { revisedContent: string; changeExplanation: string } | null = null;
    try {
      data = JSON.parse(responseText);
    } catch {
      const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      data = JSON.parse(cleaned);
    }

    if (!data || !data.revisedContent || !data.changeExplanation) {
      return NextResponse.json(
        { error: "Model response is missing required fields." },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error("[REVISE-LEGAL-CLAUSE] Error:", error);
    return NextResponse.json(
      { error: "Backend error: " + (error?.message || String(error)) },
      { status: 500 }
    );
  }
}
