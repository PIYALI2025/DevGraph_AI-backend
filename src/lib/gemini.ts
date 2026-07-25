import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004";

function getClient() {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

export async function generateContent(prompt: string): Promise<string> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });
  return response.text ?? "";
}

export async function getEmbedding(text: string): Promise<number[]> {
  const ai = getClient();
  const response = await ai.models.embedContent({
    model: GEMINI_EMBEDDING_MODEL,
    contents: text,
  });
  // Handle both response shapes
  const emb = (response as unknown as { embedding?: { values: number[] }; embeddings?: { values: number[] }[] });
  if (emb.embedding?.values) return emb.embedding.values;
  if (emb.embeddings?.[0]?.values) return emb.embeddings[0].values;
  throw new Error("Unexpected embedding response format.");
}

export async function generateCypher(question: string, schema: string): Promise<string> {
  const prompt = `You are an expert Cypher query generator for Neo4j.
Given the following database schema, generate a Cypher query to answer the user's question.
Return ONLY the raw Cypher query. Do not include markdown code block syntax and do not write explanations.

Database Schema:
${schema}

User Question:
${question}

Cypher Query:`;
  const raw = await generateContent(prompt);
  return cleanCypherOutput(raw);
}

export async function generateAnswer(question: string, context: string): Promise<string> {
  const prompt = `You are DevGraph AI, an advanced codebase intelligence assistant.
Answer the following question about the codebase using the context retrieved from the code graph and vector database.
If the context is insufficient, explain what is missing.

Retrieved Codebase Context:
${context}

User Question:
${question}

Answer:`;
  return generateContent(prompt);
}

function cleanCypherOutput(text: string): string {
  text = text.trim();
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    const inner = lines[lines.length - 1].trim() === "```" ? lines.slice(1, -1) : lines.slice(1);
    return inner.join("\n").trim();
  }
  return text;
}
