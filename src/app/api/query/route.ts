import { NextRequest, NextResponse } from "next/server";
import { generateCypher, generateAnswer, getEmbedding } from "@/lib/gemini";
import { executeQuery } from "@/lib/neo4j";
import { searchSimilar } from "@/lib/qdrant";
import type { QueryResponse } from "@/lib/types";

const GRAPH_SCHEMA = `
Node Labels:
- Service {name: STRING, repo_url: STRING}
- File {path: STRING, language: STRING, lines: INTEGER}
- Class {name: STRING, visibility: STRING}
- Function {signature: STRING, docstring: STRING, cyclomatic: INTEGER}
- APIEndpoint {path: STRING, method: STRING}
- DBTable {table_name: STRING, engine: STRING}
- Commit {sha: STRING, author: STRING, timestamp: DATETIME}

Relationship Types:
- (:Service)-[:CONTAINS]->(:File)
- (:File)-[:CONTAINS]->(:Class)
- (:File)-[:CONTAINS]->(:Function)
- (:Class)-[:DEFINES]->(:Function)
- (:Class)-[:INHERITS_FROM]->(:Class)
- (:Function)-[:CALLS]->(:Function)
- (:Function)-[:READS_FROM]->(:DBTable)
- (:Function)-[:WRITES_TO]->(:DBTable)
`;

export async function POST(req: NextRequest) {
  const { question, limit = 5 } = await req.json();
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  let cypherQuery: string | null = null;
  let graphContext: unknown[] = [];
  let vectorContext: unknown[] = [];

  // 1. Neo4j graph context via NL-to-Cypher
  try {
    cypherQuery = await generateCypher(question, GRAPH_SCHEMA);
    if (cypherQuery) {
      graphContext = await executeQuery(cypherQuery);
    }
  } catch (e) {
    console.warn("Neo4j retrieval skipped:", String(e));
  }

  // 2. Qdrant semantic vector search
  try {
    const queryVector = await getEmbedding(question);
    vectorContext = await searchSimilar(queryVector, limit);
  } catch (e) {
    console.warn("Qdrant search skipped:", String(e));
  }

  // 3. Consolidate context
  const contextParts: string[] = [];
  if (graphContext.length) {
    contextParts.push("--- NEO4J GRAPH CONTEXT ---");
    contextParts.push(JSON.stringify(graphContext, null, 2));
  }
  if (vectorContext.length) {
    contextParts.push("--- SEMANTIC CODE CONTEXT ---");
    for (const match of vectorContext as { node_id: string; payload: Record<string, unknown>; score: number }[]) {
      contextParts.push(
        `Entity ID: ${match.node_id}\nName: ${match.payload?.name}\nType: ${match.payload?.type}\nFile: ${match.payload?.file_path}\nSimilarity Score: ${match.score}`
      );
    }
  }

  // 4. Generate answer
  let answer: string;
  try {
    answer = await generateAnswer(question, contextParts.join("\n\n"));
  } catch (e) {
    return NextResponse.json({ error: `Failed to generate answer: ${String(e)}` }, { status: 500 });
  }

  const response: QueryResponse = {
    answer,
    cypher_query: cypherQuery,
    graph_context: graphContext.length ? graphContext : null,
    vector_context: vectorContext.length ? vectorContext : null,
  };

  return NextResponse.json(response);
}
