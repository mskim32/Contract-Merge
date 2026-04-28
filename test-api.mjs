import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = "AIzaSyDw1DlBSpNMxuHGu9-TSPl3HRJHx2mbGcM";
const genAI = new GoogleGenerativeAI(apiKey);

async function test() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent("Hello!");
    console.log("Success! Response:", result.response.text());
  } catch(e) {
    console.error("Gemini-2.5 error:", e.message);
  }
}

test();
