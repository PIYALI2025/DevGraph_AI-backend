/**
 * File-based framework detector ported from Python backend.
 * Scores primary (dependency) and secondary (config file) indicators.
 */

interface FrameworkResult {
  framework: string;
  confidence: number;
}

type Indicator = [string, string | null]; // [filename, packageName | null]

interface FrameworkIndicators {
  primary: Indicator[];
  secondary: Indicator[];
}

const FRAMEWORK_INDICATORS: Record<string, FrameworkIndicators> = {
  express: {
    primary: [["package.json", "express"]],
    secondary: [],
  },
  nextjs: {
    primary: [["package.json", "next"]],
    secondary: [["next.config.js", null], ["next.config.ts", null]],
  },
  nestjs: {
    primary: [["package.json", "@nestjs/core"]],
    secondary: [["nest-cli.json", null]],
  },
  nodejs: {
    primary: [["package.json", null]],
    secondary: [],
  },
  fastapi: {
    primary: [["requirements.txt", "fastapi"], ["pyproject.toml", "fastapi"]],
    secondary: [],
  },
  django: {
    primary: [["requirements.txt", "django"], ["pyproject.toml", "django"]],
    secondary: [["manage.py", null]],
  },
  flask: {
    primary: [["requirements.txt", "flask"], ["pyproject.toml", "flask"]],
    secondary: [],
  },
};

const PRIMARY_SCORE = 0.6;
const SECONDARY_SCORE = 0.2;

/**
 * Detects framework from a map of { filename: content } pairs.
 * Works on cloned repo file contents passed in-memory.
 */
export function detectFramework(files: Record<string, string>): FrameworkResult {
  // Parse package.json once
  let pkgJson: Record<string, unknown> | null = null;
  if (files["package.json"]) {
    try {
      pkgJson = JSON.parse(files["package.json"]);
    } catch {
      pkgJson = null;
    }
  }

  const scores: Record<string, number> = {};
  for (const fw of Object.keys(FRAMEWORK_INDICATORS)) scores[fw] = 0;

  for (const [fw, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
    for (const [filename, pkgName] of indicators.primary) {
      const score = scoreIndicator(filename, pkgName, files, pkgJson);
      scores[fw] = Math.min(1.0, scores[fw] + score * PRIMARY_SCORE);
    }
    for (const [filename, pkgName] of indicators.secondary) {
      const score = scoreIndicator(filename, pkgName, files, pkgJson);
      scores[fw] = Math.min(1.0, scores[fw] + score * SECONDARY_SCORE);
    }
  }

  const best = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a));
  if (best[1] === 0) return { framework: "unknown", confidence: 0 };
  return { framework: best[0], confidence: Math.round(best[1] * 1e10) / 1e10 };
}

function scoreIndicator(
  filename: string,
  pkgName: string | null,
  files: Record<string, string>,
  pkgJson: Record<string, unknown> | null
): number {
  if (filename === "package.json") {
    return checkPackageJson(pkgName, pkgJson);
  }
  if (["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"].includes(filename)) {
    return checkPythonDepFile(files[filename] ?? null, pkgName);
  }
  // Secondary config file: just check presence
  return files[filename] !== undefined ? 1.0 : 0.0;
}

function checkPackageJson(pkgName: string | null, pkgJson: Record<string, unknown> | null): number {
  if (!pkgJson) return 0;
  if (pkgName === null) return 1.0; // bare presence
  const deps = (pkgJson.dependencies as Record<string, string>) ?? {};
  const devDeps = (pkgJson.devDependencies as Record<string, string>) ?? {};
  return pkgName in deps || pkgName in devDeps ? 1.0 : 0.0;
}

function checkPythonDepFile(content: string | null, pkgName: string | null): number {
  if (!content || !pkgName) return 0;
  const target = pkgName.toLowerCase();
  for (const line of content.split("\n") as string[]) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    let normalized = stripped.toLowerCase().split(";")[0].split("[")[0];
    normalized = normalized.split("==")[0].split(">=")[0].split("<=")[0]
      .split("!=")[0].split(">")[0].split("<")[0].split("~")[0].trim();
    if (normalized === target) return 1.0;
  }
  return 0;
}
