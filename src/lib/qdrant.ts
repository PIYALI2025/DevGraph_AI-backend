import { QdrantClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // UUID namespace DNS

let client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!client) {
    const url = process.env.QDRANT_URL;
    if (!url) throw new Error("QDRANT_URL is not set.");
    client = new QdrantClient({
      url,
      apiKey: process.env.QDRANT_API_KEY || undefined,
    });
  }
  return client;
}

export interface VectorMatch {
  node_id: string | null;
  payload: Record<string, unknown> | null;
  score: number;
}

export async function searchSimilar(
  queryVector: number[],
  limit = 5,
  collection = "code_entities"
): Promise<VectorMatch[]> {
  const c = getClient();
  const results = await c.search(collection, {
    vector: queryVector,
    limit,
  });
  return results.map((r) => ({
    node_id: (r.payload?.node_id as string) ?? null,
    payload: r.payload as Record<string, unknown> | null,
    score: r.score,
  }));
}

export async function upsertCodeSnippet(
  nodeId: string,
  vector: number[],
  payload: Record<string, unknown>,
  collection = "code_entities"
): Promise<void> {
  const c = getClient();
  const pointId = uuidv5(nodeId, NAMESPACE);
  await c.upsert(collection, {
    points: [{ id: pointId, vector, payload: { ...payload, node_id: nodeId } }],
  });
}
