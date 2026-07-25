export interface LineRange {
  start?: number | null;
  end?: number | null;
}

export interface CommitDetail {
  sha?: string | null;
  author?: string | null;
  timestamp?: string | null;
  message?: string | null;
  ai_commit_analysis?: string | null;
}

export interface NodeRelation {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  relationship?: string | null;
}

export interface ServiceMeta {
  language?: string | null;
  port?: number | null;
  git_repo?: string | null;
}

export interface FunctionMeta {
  signature?: string | null;
  visibility?: string | null;
  complexity?: number | null;
  tested_by?: string[];
}

export interface APIEndpointMeta {
  method?: string | null;
  path?: string | null;
}

export interface ColumnMeta {
  name?: string | null;
  data_type?: string | null;
}

export interface DBTableMeta {
  engine?: string | null;
  columns?: ColumnMeta[];
}

export interface ClassMeta {
  visibility?: string | null;
  extends?: string | null;
}

export interface ExternalPackageMeta {
  package_name?: string | null;
  version?: string | null;
  registry?: string | null;
}

export interface GraphNode {
  id: string;
  name: string;
  type: "Service" | "Function" | "APIEndpoint" | "DBTable" | "Class" | "ExternalPackage";
  file_path?: string | null;
  line_range?: LineRange | null;
  ai_analysis?: string | null;
  commit_history?: CommitDetail[];
  direct_dependents?: NodeRelation[];
  direct_dependencies?: NodeRelation[];
  service_meta?: ServiceMeta | null;
  function_meta?: FunctionMeta | null;
  endpoint_meta?: APIEndpointMeta | null;
  db_table_meta?: DBTableMeta | null;
  class_meta?: ClassMeta | null;
  package_meta?: ExternalPackageMeta | null;
}

export interface RepoAnalyseResponse {
  repo_url: string;
  detected_framework: string;
  nodes: GraphNode[];
}

export interface QueryRequest {
  question: string;
  limit?: number;
}

export interface QueryResponse {
  answer: string;
  cypher_query?: string | null;
  graph_context?: unknown[] | null;
  vector_context?: unknown[] | null;
}
