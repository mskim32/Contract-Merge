import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = "AIzaSyDw1DlBSpNMxuHGu9-TSPl3HRJHx2mbGcM";
const genAI = new GoogleGenerativeAI(apiKey);

async function run() {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  try {
    // try to list models if possible, wait, SDK doesn't expose listModels directly.
    // Let's just fetch from REST api
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();
    console.log(data.models.map(m => m.name));
  } catch (e) {
    console.log(e);
  }
}

run();
