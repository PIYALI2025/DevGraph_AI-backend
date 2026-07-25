import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "path";

// Load .myenv from workspace root — keeps secrets out of .env.local
config({ path: resolve(process.cwd(), ".myenv") });

const nextConfig: NextConfig = {
  env: {
    GEMINI_API_KEY:          process.env.GEMINI_API_KEY          ?? "",
    GEMINI_MODEL:            process.env.GEMINI_MODEL            ?? "gemini-2.5-flash",
    GEMINI_EMBEDDING_MODEL:  process.env.GEMINI_EMBEDDING_MODEL  ?? "text-embedding-004",
    NEO4J_URI:               process.env.NEO4J_URI               ?? "",
    NEO4J_USERNAME:          process.env.NEO4J_USERNAME          ?? "",
    NEO4J_PASSWORD:          process.env.NEO4J_PASSWORD          ?? "",
    NEO4J_DATABASE:          process.env.NEO4J_DATABASE          ?? "neo4j",
    QDRANT_URL:              process.env.QDRANT_URL              ?? "",
    QDRANT_API_KEY:          process.env.QDRANT_API_KEY          ?? "",
  },
};

export default nextConfig;
