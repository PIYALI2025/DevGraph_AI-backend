import neo4j, { Driver } from "neo4j-driver";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      throw new Error("Neo4j environment variables are not set.");
    }
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

export async function executeQuery(cypher: string): Promise<unknown[]> {
  const d = getDriver();
  const session = d.session({ database: process.env.NEO4J_DATABASE ?? "neo4j" });
  try {
    const result = await session.run(cypher);
    return result.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}
