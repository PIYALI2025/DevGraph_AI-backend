import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateContent } from "@/lib/gemini";
import type { RepoAnalyseResponse } from "@/lib/types";

const READABLE_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
  ".cs", ".cpp", ".c", ".h", ".rb", ".php", ".swift", ".kt",
  ".json", ".yaml", ".yml", ".toml", ".md", ".html", ".css", ".sql",
]);
const MAX_FILE_SIZE = 50_000;
const MAX_TOTAL_CHARS = 300_000;
const SKIP_DIRS = new Set(["node_modules", "venv", "__pycache__", ".git", "dist", "build", ".next"]);

function cloneRepo(repoUrl: string, targetDir: string): { ok: boolean; error: string } {
  try {
    const result = spawnSync("git", ["clone", "--depth=1", repoUrl, targetDir], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) return { ok: false, error: result.stderr ?? "" };
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function readRepoFiles(repoDir: string): string {
  const collected: string[] = [];
  let totalChars = 0;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!READABLE_EXTENSIONS.has(ext)) continue;
        const filePath = path.join(dir, entry.name);
        const relPath = path.relative(repoDir, filePath);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(filePath, "utf8");
          const entry2 = `\n\n### FILE: ${relPath} ###\n${content}`;
          if (totalChars + entry2.length > MAX_TOTAL_CHARS) {
            collected.push("\n\n[... truncated ...]");
            return;
          }
          collected.push(entry2);
          totalChars += entry2.length;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(repoDir);
  return collected.join("\n");
}

function getGitCommits(repoDir: string): { sha: string; author: string; timestamp: string; message: string }[] {
  try {
    const result = spawnSync(
      "git",
      ["log", "-n", "10", "--pretty=format:%H|%an|%cI|%s"],
      { cwd: repoDir, encoding: "utf8" }
    );
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, timestamp, ...rest] = line.split("|");
        return { sha, author, timestamp, message: rest.join("|") };
      });
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const { repo_url } = await req.json();
  if (!repo_url) {
    return NextResponse.json({ error: "repo_url is required" }, { status: 400 });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devgraph_"));
  try {
    const cloneResult = cloneRepo(repo_url, tmpDir);
    if (!cloneResult.ok) {
      return NextResponse.json({ error: `Failed to clone: ${cloneResult.error}` }, { status: 400 });
    }

    const repoContent = readRepoFiles(tmpDir);
    if (!repoContent.trim()) {
      return NextResponse.json({ error: "No readable source files found." }, { status: 400 });
    }

    const commits = getGitCommits(tmpDir);
    const commitsText = commits
      .map((c) => `- ${c.sha.slice(0, 7)} by ${c.author} at ${c.timestamp}: ${c.message}`)
      .join("\n");

    const prompt = `You are DevGraph AI. Analyse this repository and return a JSON object ONLY — no markdown, no explanation.

Repository URL: ${repo_url}

Recent Commits:
${commitsText}

Source Code:
${repoContent}

Return a JSON object with this exact structure:
{
  "detected_framework": "string (e.g. fastapi, express, django, unknown)",
  "nodes": [
    {
      "id": "unique id like srv-1, fn-1, api-1, db-1, cls-1, pkg-1",
      "name": "display name",
      "type": "Service | Function | APIEndpoint | DBTable | Class | ExternalPackage",
      "file_path": "relative file path or null for ExternalPackage",
      "line_range": {"start": 0, "end": 0},
      "ai_analysis": "AI-generated summary of purpose/behavior",
      "commit_history": [
        {
          "sha": "full sha",
          "author": "author name",
          "timestamp": "ISO 8601",
          "message": "raw commit message",
          "ai_commit_analysis": "what changed and why"
        }
      ],
      "direct_dependents": [
        {"id": "node-id", "name": "name", "type": "node type", "relationship": "CALLS|HANDLES|USES|HAS_METHOD|READS_FROM|WRITES_TO"}
      ],
      "direct_dependencies": [
        {"id": "node-id", "name": "name", "type": "node type", "relationship": "CALLS|HANDLES|USES|HAS_METHOD|READS_FROM|WRITES_TO"}
      ],
      "service_meta": {"language": "string", "port": null, "git_repo": "string"},
      "function_meta": {"signature": "string", "visibility": "public|private", "complexity": 1, "tested_by": []},
      "endpoint_meta": {"method": "GET|POST|PUT|DELETE|PATCH", "path": "/path"},
      "db_table_meta": {"engine": "string", "columns": [{"name": "col", "data_type": "string"}]},
      "class_meta": {"visibility": "public|private", "extends": null},
      "package_meta": {"package_name": "string", "version": "string", "registry": "npm|pip|go modules"}
    }
  ]
}

Only populate the metadata field that matches the node type. Set others to null.
Include all significant services, functions, API endpoints, database tables, classes, and external packages.
Attach the commit history to the Service node only.`;

    let raw: string;
    try {
      raw = await generateContent(prompt);
    } catch (e) {
      return NextResponse.json({ error: `Gemini API error: ${String(e)}` }, { status: 500 });
    }

    // Strip markdown fences
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      const lines = cleaned.split("\n");
      const inner = lines[lines.length - 1].trim() === "```" ? lines.slice(1, -1) : lines.slice(1);
      cleaned = inner.join("\n").trim();
    }

    let data: { detected_framework: string; nodes: unknown[] };
    try {
      data = JSON.parse(cleaned);
    } catch (e) {
      return NextResponse.json({ error: `LLM returned invalid JSON: ${String(e)}` }, { status: 500 });
    }

    const response: RepoAnalyseResponse = {
      repo_url,
      detected_framework: data.detected_framework ?? "unknown",
      nodes: (data.nodes ?? []) as RepoAnalyseResponse["nodes"],
    };

    return NextResponse.json(response);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
