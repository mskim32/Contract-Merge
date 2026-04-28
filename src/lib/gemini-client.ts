import { GoogleGenerativeAI } from "@google/generative-ai";

let cached: GoogleGenerativeAI | null = null;

/** 서버 전용. `.env.local`에 `GEMINI_API_KEY`를 설정하세요. */
export function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY가 설정되지 않았습니다. 프로젝트 루트에 .env.local 파일을 만들고 GEMINI_API_KEY=... 를 추가하세요."
    );
  }
  if (!cached) {
    cached = new GoogleGenerativeAI(apiKey);
  }
  return cached;
}
