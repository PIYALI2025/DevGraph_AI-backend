/**
 * Neo4j graph service — full port of Python DevGraphRepository.
 * Covers schema init, batch upserts for all node types,
 * relationship creation, and query helpers.
 */
import neo4j, { Driver, Session } from "neo4j-driver";
import type {
  ServiceNode, FileNode, FunctionNode, ClassNode,
  APIEndpointNode, DBTableNode, CommitNode,
  FunctionCallEdge, FunctionDBEdge, RelationshipModel, RelationshipType,
} from "@/lib/models";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) throw new Error("Neo4j env vars not set.");
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

async function run<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const session = getDriver().session({ database: process.env.NEO4J_DATABASE ?? "neo4j" });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

// Re-export model types for consumers
export type { ServiceNode, FileNode, FunctionNode, ClassNode, APIEndpointNode, DBTableNode, CommitNode, FunctionCallEdge, FunctionDBEdge, RelationshipModel };

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function initSchemaConstraints(): Promise<void> {
  const constraints = [
    "CREATE CONSTRAINT IF NOT EXISTS FOR (s:Service)     REQUIRE s.name IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (f:File)        REQUIRE f.path IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (fn:Function)   REQUIRE fn.signature IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (c:Class)       REQUIRE c.name IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (d:DBTable)     REQUIRE d.table_name IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (cm:Commit)     REQUIRE cm.sha IS UNIQUE",
  ];
  await run(async (s) => {
    for (const c of constraints) {
      try { await s.run(c); } catch { /* already exists */ }
    }
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export async function upsertService(name: string, repoUrl: string, framework: string): Promise<void> {
  await run((s) =>
    s.run(
      "MERGE (s:Service {name: $name}) SET s.repo_url = $repoUrl, s.framework = $framework",
      { name, repoUrl, framework }
    )
  );
}

// ─── Files ────────────────────────────────────────────────────────────────────

export async function batchUpsertFiles(serviceName: string, files: FileNode[]): Promise<void> {
  if (!files.length) return;
  await run((s) =>
    s.run(
      `MERGE (svc:Service {name: $serviceName})
       WITH svc
       UNWIND $batch AS row
       MERGE (f:File {path: row.path})
       ON CREATE SET f.language = row.language, f.lines = row.lines
       ON MATCH  SET f.lines = row.lines
       MERGE (svc)-[:CONTAINS]->(f)`,
      { serviceName, batch: files }
    )
  );
}

// ─── Classes ──────────────────────────────────────────────────────────────────

export async function batchUpsertClasses(filePath: string, classes: ClassNode[]): Promise<void> {
  if (!classes.length) return;
  await run((s) =>
    s.run(
      `MATCH (f:File {path: $filePath})
       UNWIND $batch AS row
       MERGE (c:Class {name: row.name})
       ON CREATE SET c.visibility = row.visibility
       ON MATCH  SET c.visibility = row.visibility
       MERGE (f)-[:CONTAINS]->(c)`,
      { filePath, batch: classes }
    )
  );
}

// ─── Functions ────────────────────────────────────────────────────────────────

export async function batchUpsertFunctions(filePath: string, functions: FunctionNode[]): Promise<void> {
  if (!functions.length) return;
  await run((s) =>
    s.run(
      `MATCH (f:File {path: $filePath})
       UNWIND $batch AS row
       MERGE (fn:Function {signature: row.signature})
       ON CREATE SET fn.docstring = row.docstring, fn.cyclomatic = row.cyclomatic
       ON MATCH  SET fn.cyclomatic = row.cyclomatic
       MERGE (f)-[:CONTAINS]->(fn)`,
      { filePath, batch: functions }
    )
  );
}

// ─── API Endpoints ────────────────────────────────────────────────────────────

export async function batchUpsertEndpoints(endpoints: APIEndpointNode[]): Promise<void> {
  if (!endpoints.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MERGE (a:APIEndpoint {path: row.path, method: row.method})`,
      { batch: endpoints }
    )
  );
}

// ─── DB Tables ────────────────────────────────────────────────────────────────

export async function batchUpsertDBTables(tables: DBTableNode[]): Promise<void> {
  if (!tables.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MERGE (d:DBTable {table_name: row.table_name})
       ON CREATE SET d.engine = row.engine
       ON MATCH  SET d.engine = row.engine`,
      { batch: tables }
    )
  );
}

// ─── Commits ──────────────────────────────────────────────────────────────────

export async function batchUpsertCommits(commits: CommitNode[]): Promise<void> {
  if (!commits.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MERGE (cm:Commit {sha: row.sha})
       ON CREATE SET cm.author = row.author, cm.message = row.message,
                     cm.timestamp = datetime(row.timestamp)
       ON MATCH  SET cm.author = row.author`,
      { batch: commits }
    )
  );
}

// ─── Function call edges ──────────────────────────────────────────────────────

export async function batchLinkFunctionCalls(calls: FunctionCallEdge[]): Promise<void> {
  if (!calls.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MATCH (caller:Function {signature: row.caller_signature})
       MATCH (callee:Function {signature: row.callee_signature})
       MERGE (caller)-[r:CALLS]->(callee)
       ON CREATE SET r.call_site_line = row.call_site_line`,
      { batch: calls }
    )
  );
}

// ─── Function → DB table edges ────────────────────────────────────────────────

export async function batchLinkFunctionDBAccess(edges: FunctionDBEdge[]): Promise<void> {
  if (!edges.length) return;
  await run(async (s) => {
    await s.run(
      `UNWIND $batch AS row
       WITH row WHERE row.access_type IN ['READ','READ_WRITE']
       MATCH (fn:Function {signature: row.function_signature})
       MERGE (db:DBTable {table_name: row.table_name})
       MERGE (fn)-[:READS_FROM]->(db)`,
      { batch: edges }
    );
    await s.run(
      `UNWIND $batch AS row
       WITH row WHERE row.access_type IN ['WRITE','READ_WRITE']
       MATCH (fn:Function {signature: row.function_signature})
       MERGE (db:DBTable {table_name: row.table_name})
       MERGE (fn)-[:WRITES_TO]->(db)`,
      { batch: edges }
    );
  });
}

// ─── Graph node upsert (from LLM analysis response) ──────────────────────────

export interface GraphNodeInput {
  id: string; name: string; type: string;
  file_path?: string | null; ai_analysis?: string | null;
  endpoint_meta?: { method?: string | null; path?: string | null } | null;
  db_table_meta?: { engine?: string | null } | null;
  function_meta?: { signature?: string | null; complexity?: number | null; visibility?: string | null } | null;
  class_meta?: { visibility?: string | null } | null;
  package_meta?: { package_name?: string | null; version?: string | null; registry?: string | null } | null;
  direct_dependencies?: { id?: string | null; name?: string | null; type?: string | null; relationship?: string | null }[];
}

export async function upsertGraphNodes(serviceName: string, nodes: GraphNodeInput[]): Promise<void> {
  for (const node of nodes) {
    try {
      await run(async (s) => {
        switch (node.type) {
          case "Function":
            await s.run(
              `MERGE (fn:Function {signature: $sig})
               SET fn.name = $name, fn.ai_analysis = $ai, fn.file_path = $fp, fn.complexity = $complexity`,
              { sig: node.function_meta?.signature ?? node.name, name: node.name,
                ai: node.ai_analysis ?? "", fp: node.file_path ?? "",
                complexity: node.function_meta?.complexity ?? 1 }
            ); break;
          case "APIEndpoint":
            if (node.endpoint_meta?.path && node.endpoint_meta?.method)
              await s.run(
                `MERGE (a:APIEndpoint {path: $path, method: $method})
                 SET a.name = $name, a.ai_analysis = $ai, a.file_path = $fp`,
                { path: node.endpoint_meta.path, method: node.endpoint_meta.method,
                  name: node.name, ai: node.ai_analysis ?? "", fp: node.file_path ?? "" }
              ); break;
          case "DBTable":
            await s.run(
              `MERGE (d:DBTable {table_name: $name})
               SET d.engine = $engine, d.ai_analysis = $ai`,
              { name: node.name, engine: node.db_table_meta?.engine ?? "", ai: node.ai_analysis ?? "" }
            ); break;
          case "Class":
            await s.run(
              `MERGE (c:Class {name: $name})
               SET c.visibility = $vis, c.ai_analysis = $ai, c.file_path = $fp`,
              { name: node.name, vis: node.class_meta?.visibility ?? "public",
                ai: node.ai_analysis ?? "", fp: node.file_path ?? "" }
            ); break;
          case "ExternalPackage":
            await s.run(
              `MERGE (p:ExternalPackage {name: $name})
               SET p.version = $version, p.registry = $registry`,
              { name: node.package_meta?.package_name ?? node.name,
                version: node.package_meta?.version ?? "", registry: node.package_meta?.registry ?? "" }
            ); break;
          default: // Service
            await s.run(
              `MERGE (svc:Service {name: $name}) SET svc.ai_analysis = $ai`,
              { name: node.name, ai: node.ai_analysis ?? "" }
            );
        }
      });
    } catch { /* skip individual node errors */ }
  }

  // Link service → all child nodes
  for (const node of nodes.filter((n) => n.type !== "Service")) {
    try {
      const labelMap: Record<string, string> = {
        Function: "Function", APIEndpoint: "APIEndpoint",
        DBTable: "DBTable", Class: "Class", ExternalPackage: "ExternalPackage",
      };
      const label = labelMap[node.type];
      if (!label) continue;
      const id = node.type === "Function"
        ? (node.function_meta?.signature ?? node.name)
        : node.type === "APIEndpoint" ? (node.endpoint_meta?.path ?? node.name)
        : node.type === "DBTable" ? node.name : node.name;

      await run((s) =>
        s.run(
          `MATCH (svc:Service {name: $svc})
           MATCH (n:${label}) WHERE n.name = $id OR n.signature = $id OR n.path = $id OR n.table_name = $id
           MERGE (svc)-[:CONTAINS]->(n)`,
          { svc: serviceName, id }
        )
      );
    } catch { /* skip */ }
  }
}

export async function batchLinkImports(
  edges: { from_file: string; to_module: string; names: string[]; is_external: boolean }[]
): Promise<void> {
  if (!edges.length) return;
  // Internal file→file imports
  const internal = edges.filter((e) => !e.is_external);
  if (internal.length) {
    await run((s) =>
      s.run(
        `UNWIND $batch AS row
         MATCH (src:File {path: row.from_file})
         MATCH (tgt:File) WHERE tgt.path CONTAINS row.to_module OR tgt.path = row.to_module
         MERGE (src)-[:IMPORTS]->(tgt)`,
        { batch: internal }
      )
    ).catch(() => {});
  }
  // External package imports
  const external = edges.filter((e) => e.is_external);
  if (external.length) {
    await run((s) =>
      s.run(
        `UNWIND $batch AS row
         MATCH (src:File {path: row.from_file})
         MERGE (pkg:ExternalPackage {name: row.to_module})
         MERGE (src)-[:IMPORTS]->(pkg)`,
        { batch: external }
      )
    ).catch(() => {});
  }
}

export async function batchLinkInheritance(
  edges: { child_class: string; parent_class: string }[]
): Promise<void> {
  if (!edges.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MATCH (child:Class  {name: row.child_class})
       MERGE (parent:Class {name: row.parent_class})
       MERGE (child)-[:INHERITS_FROM]->(parent)`,
      { batch: edges }
    )
  ).catch(() => {});
}

export async function batchLinkDefines(
  edges: { class_name: string; function_signature: string }[]
): Promise<void> {
  if (!edges.length) return;
  await run((s) =>
    s.run(
      `UNWIND $batch AS row
       MATCH (c:Class    {name: row.class_name})
       MATCH (fn:Function {signature: row.function_signature})
       MERGE (c)-[:DEFINES]->(fn)`,
      { batch: edges }
    )
  ).catch(() => {});
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function executeQuery(cypher: string): Promise<unknown[]> {
  return run(async (s) => {
    const result = await s.run(cypher);
    return result.records.map((r: { toObject: () => unknown }) => r.toObject());
  });
}

export async function getNodeWithRelationships(nodeId: string): Promise<unknown> {
  return run(async (s) => {
    const result = await s.run(
      `MATCH (n)
       WHERE n.name = $id OR n.path = $id OR n.signature = $id OR n.table_name = $id
       WITH n, labels(n)[0] AS node_type
       OPTIONAL MATCH (n)-[out_rel]->(dep)
       OPTIONAL MATCH (dependent)-[in_rel]->(n)
       RETURN n AS node, node_type AS type,
         collect(DISTINCT {
           id:           coalesce(dep.name, dep.path, dep.signature, dep.table_name),
           name:         coalesce(dep.name, dep.path, dep.signature, dep.table_name),
           type:         labels(dep)[0],
           relationship: type(out_rel)
         }) AS direct_dependencies,
         collect(DISTINCT {
           id:           coalesce(dependent.name, dependent.path, dependent.signature, dependent.table_name),
           name:         coalesce(dependent.name, dependent.path, dependent.signature, dependent.table_name),
           type:         labels(dependent)[0],
           relationship: type(in_rel)
         }) AS direct_dependents
       LIMIT 1`,
      { id: nodeId }
    );
    return result.records[0]?.toObject() ?? null;
  });
}

export async function getUpstreamDependents(sig: string, depth = 5): Promise<unknown[]> {
  return run(async (s) => {
    const result = await s.run(
      `MATCH path = (fn:Function {signature: $sig})<-[:CALLS*1..${depth}]-(caller:Function)
       OPTIONAL MATCH (endpoint:APIEndpoint)-[:HANDLED_BY]->(caller)
       RETURN caller.signature AS caller_signature,
              length(path)     AS distance,
              endpoint.path    AS endpoint_impacted
       ORDER BY distance ASC`,
      { sig }
    );
    return result.records.map((r: { toObject: () => unknown }) => r.toObject());
  });
}

export async function getCommitsForService(serviceName: string): Promise<unknown[]> {
  return run(async (s) => {
    const result = await s.run(
      `MATCH (cm:Commit)
       RETURN cm.sha AS sha, cm.author AS author,
              toString(cm.timestamp) AS timestamp, cm.message AS message
       ORDER BY cm.timestamp DESC LIMIT 10`
    );
    return result.records.map((r: { toObject: () => unknown }) => r.toObject());
  });
}
