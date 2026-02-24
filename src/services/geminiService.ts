import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateChefComment(orderItems: string[]) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `As a professional chef, give a quick 1-sentence encouraging comment about this order: ${orderItems.join(", ")}`,
    });
    return response.text || "Preparing your delicious meal!";
  } catch (error) {
    return "Preparing your delicious meal!";
  }
}
