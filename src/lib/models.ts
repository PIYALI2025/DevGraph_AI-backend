/**
 * TypeScript port of backend/app/models/nodes.py and relationships.py.
 * These are the structured graph entity models used for Neo4j ingestion
 * and relationship edge creation.
 */

// ─── Node Models (nodes.py) ───────────────────────────────────────────────────

/** Framework detection result with a confidence score between 0.0 and 1.0 */
export interface FrameworkResult {
  framework: string;
  confidence: number; // 0.0 – 1.0
}

/** A microservice / top-level repository node */
export interface ServiceNode {
  name: string;       // unique service identifier, e.g. "payment-service"
  repo_url: string;
  framework: string;  // detected backend framework, default "unknown"
}

/** A source file within a repository */
export interface FileNode {
  path: string;       // relative path, e.g. "src/utils.py"
  language: string;   // e.g. "python", "typescript"
  lines: number;      // total line count (must be > 0)
}

/** A function or method extracted from source */
export interface FunctionNode {
  signature: string;      // fully qualified, e.g. "auth.login_user(user_id: str)"
  docstring?: string | null;
  cyclomatic: number;     // cyclomatic complexity score, min 1
}

/** A class or interface extracted from source */
export interface ClassNode {
  name: string;
  visibility: "public" | "private" | "protected";
}

/** An HTTP API endpoint */
export interface APIEndpointNode {
  path: string;    // e.g. "/api/v1/checkout"
  method: string;  // GET | POST | PUT | DELETE | PATCH
}

/** A database table */
export interface DBTableNode {
  table_name: string;
  engine: string;   // e.g. "PostgreSQL", "MongoDB"
}

/** A git commit */
export interface CommitNode {
  sha: string;         // min 7 chars
  author: string;
  timestamp: string;   // ISO 8601
  message?: string;
  ai_analysis?: string | null;
}

// ─── Relationship Models (relationships.py) ───────────────────────────────────

/** Valid relationship types between graph nodes */
export type RelationshipType =
  | "CONTAINS"
  | "CALLS"
  | "IMPORTS"
  | "INHERITS_FROM"
  | "DEFINES"
  | "HANDLED_BY"
  | "READS_FROM"
  | "WRITES_TO";

/** Generic relationship edge between any two nodes */
export interface RelationshipModel {
  from_id: string;       // source node identifier
  to_id: string;         // target node identifier
  type: RelationshipType;
  properties?: Record<string, unknown>;
}

/** Directed function → function call edge */
export interface FunctionCallEdge {
  caller_signature: string;  // fully qualified caller
  callee_signature: string;  // fully qualified callee
  call_site_line: number;    // line number of the call site
}

/** Function → database table access edge */
export interface FunctionDBEdge {
  function_signature: string;
  table_name: string;
  access_type: "READ" | "WRITE" | "READ_WRITE";
}
