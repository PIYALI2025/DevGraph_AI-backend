/**
 * Code parser — regex-based dependency identification for Next.js runtime.
 * Extracts: functions, classes, imports, function calls, DB accesses,
 * class inheritance, and class→method (DEFINES) relationships.
 */

import type { FunctionCallEdge, FunctionDBEdge } from "@/lib/models";

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ParsedFunction {
  signature: string;
  name: string;
  filePath: string;
  docstring: string | null;
  cyclomatic: number;
  className: string | null; // non-null if this is a method
}

export interface ParsedClass {
  name: string;
  visibility: "public" | "private" | "protected";
  extends: string | null;        // superclass name if any
  filePath: string;
  methods: string[];             // method signatures defined in this class
}

export interface ParsedImport {
  source: string;                // module path or package name
  names: string[];               // what's imported (empty = default/namespace)
  isExternal: boolean;           // true if not a relative import
  filePath: string;
}

export interface ImportEdge {
  from_file: string;             // importer file path
  to_module: string;             // imported module/package
  names: string[];
  is_external: boolean;
}

export interface InheritsEdge {
  child_class: string;
  parent_class: string;
  filePath: string;
}

export interface DefinesEdge {
  class_name: string;
  function_signature: string;
}

export interface ParseResult {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: ParsedImport[];
  calls: FunctionCallEdge[];
  dbEdges: FunctionDBEdge[];
  importEdges: ImportEdge[];
  inheritsEdges: InheritsEdge[];
  definesEdges: DefinesEdge[];
}

// ─── Token types ──────────────────────────────────────────────────────────────

export type TokenType =
  | "DEF" | "SQL_KEYWORD" | "IDENTIFIER" | "STRING_LITERAL"
  | "OPERATOR" | "PUNCTUATION" | "UNKNOWN";

export interface CodeToken {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export function tokenize(source: string): CodeToken[] {
  const patterns: [TokenType, string][] = [
    ["DEF",            String.raw`\b(def|class|async\s+def)\b`],
    ["SQL_KEYWORD",    String.raw`\b(SELECT|FROM|JOIN|INSERT|INTO|UPDATE|DELETE|WHERE)\b`],
    ["STRING_LITERAL", String.raw`(?:f|r|b)?(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`],
    ["IDENTIFIER",     String.raw`[a-zA-Z_]\w*`],
    ["OPERATOR",       String.raw`(?:==|!=|<=|>=|->|=|\+|-|\*|\/)`],
    ["PUNCTUATION",    String.raw`[:(),.\[\]{}]`],
  ];
  const master = new RegExp(
    patterns.map(([t, p]) => `(?<${t}>${p})`).join("|"), "gi"
  );

  const tokens: CodeToken[] = [];
  let lineNum = 1;
  let lineStart = 0;
  let m: RegExpExecArray | null;

  while ((m = master.exec(source)) !== null) {
    const before = source.slice(lineStart, m.index);
    const nl = (before.match(/\n/g) ?? []).length;
    lineNum += nl;
    if (nl > 0) lineStart = m.index - (m.index - source.lastIndexOf("\n", m.index - 1) - 1);
    const type = (Object.keys(m.groups ?? {}).find((k) => m!.groups![k] !== undefined) ?? "UNKNOWN") as TokenType;
    tokens.push({ type, value: m[0], line: lineNum, column: m.index - lineStart });
  }
  return tokens;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseCode(source: string, filePath: string): ParseResult {
  const lines = source.split("\n");
  const modulePath = toModulePath(filePath);

  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const imports: ParsedImport[] = [];
  const calls: FunctionCallEdge[] = [];
  const dbEdges: FunctionDBEdge[] = [];
  const importEdges: ImportEdge[] = [];
  const inheritsEdges: InheritsEdge[] = [];
  const definesEdges: DefinesEdge[] = [];

  // ── 1. Imports ──────────────────────────────────────────────────────────────
  extractImports(lines, filePath, imports, importEdges);

  // ── 2. Classes + inheritance ────────────────────────────────────────────────
  // Track active class scopes: { name, indent, extendsClass }
  const classScopes: { name: string; indent: number; extends: string | null }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.search(/\S/);
    if (indent < 0) continue; // blank line

    // Pop stale class scopes
    while (classScopes.length && indent <= classScopes[classScopes.length - 1].indent && line.trim()) {
      classScopes.pop();
    }

    // ── Class definition ──────────────────────────────────────────────────────
    // Python:  class Foo(Bar):
    // TS/JS:   class Foo extends Bar {  /  export class Foo {
    const clsPy = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/);
    const clsTs = line.match(/^(\s*)(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_]\w*))?/);
    const clsMatch = clsPy ?? clsTs;

    if (clsMatch) {
      const clsIndent = clsMatch[1].length;
      const clsName   = clsMatch[2];
      const rawParent = clsMatch[3]?.split(",")[0]?.trim() ?? null;
      const parentClass = rawParent && rawParent !== "object" ? rawParent : null;

      classes.push({
        name: clsName,
        visibility: clsName.startsWith("_") ? "private" : "public",
        extends: parentClass,
        filePath,
        methods: [],
      });

      if (parentClass) {
        inheritsEdges.push({ child_class: clsName, parent_class: parentClass, filePath });
      }

      classScopes.push({ name: clsName, indent: clsIndent, extends: parentClass });
      continue;
    }

    // ── Function / method definition ──────────────────────────────────────────
    const pyFn = line.match(/^([ \t]*)(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(/);
    const tsFn = line.match(/^([ \t]*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_]\w*)\s*\(/);
    const fnMatch = pyFn ?? tsFn;

    if (fnMatch) {
      const fnName = fnMatch[2];
      const currentClass = classScopes.length ? classScopes[classScopes.length - 1] : null;
      const sig = currentClass
        ? `${modulePath}.${currentClass.name}.${fnName}`
        : `${modulePath}.${fnName}`;

      const docstring = extractDocstring(lines, i + 1);
      const body      = extractFunctionBody(lines, i);
      const cyclomatic = calcCyclomatic(body);

      const fn: ParsedFunction = {
        signature: sig,
        name: fnName,
        filePath,
        docstring,
        cyclomatic,
        className: currentClass?.name ?? null,
      };
      functions.push(fn);

      // Register method on its class
      if (currentClass) {
        const cls = classes.find((c) => c.name === currentClass.name && c.filePath === filePath);
        if (cls) cls.methods.push(sig);
        definesEdges.push({ class_name: currentClass.name, function_signature: sig });
      }

      // Extract outgoing calls and DB accesses
      extractCalls(body, sig, i + 1, calls);
      extractDBAccesses(body, sig, dbEdges);
    }
  }

  return { functions, classes, imports, calls, dbEdges, importEdges, inheritsEdges, definesEdges };
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(
  lines: string[],
  filePath: string,
  imports: ParsedImport[],
  edges: ImportEdge[],
): void {
  for (const line of lines) {
    const trimmed = line.trim();

    // Python: import foo  /  import foo.bar  /  from foo import bar, baz
    const pyFrom = trimmed.match(/^from\s+(\.{0,3}[\w.]*)\s+import\s+(.+)$/);
    if (pyFrom) {
      const source = pyFrom[1];
      const names  = pyFrom[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const isExt  = !source.startsWith(".");
      imports.push({ source, names, isExternal: isExt, filePath });
      edges.push({ from_file: filePath, to_module: source, names, is_external: isExt });
      continue;
    }
    const pyImport = trimmed.match(/^import\s+([\w.,\s]+)$/);
    if (pyImport) {
      for (const raw of pyImport[1].split(",")) {
        const source = raw.trim().split(/\s+as\s+/)[0].trim();
        imports.push({ source, names: [], isExternal: true, filePath });
        edges.push({ from_file: filePath, to_module: source, names: [], is_external: true });
      }
      continue;
    }

    // TS/JS: import { a, b } from 'module'  /  import x from 'module'  /  require('module')
    const tsImport = trimmed.match(/^import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/);
    if (tsImport) {
      const named1  = tsImport[1] ?? "";
      const named2  = tsImport[4] ?? "";
      const source  = tsImport[5];
      const names   = [...named1.split(","), ...named2.split(",")]
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (tsImport[2]) names.push(tsImport[2]);
      const isExt   = !source.startsWith(".") && !source.startsWith("@/");
      imports.push({ source, names, isExternal: isExt, filePath });
      edges.push({ from_file: filePath, to_module: source, names, is_external: isExt });
      continue;
    }

    // require('module')
    const req = trimmed.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (req) {
      const source = req[1];
      const isExt  = !source.startsWith(".") && !source.startsWith("@/");
      imports.push({ source, names: [], isExternal: isExt, filePath });
      edges.push({ from_file: filePath, to_module: source, names: [], is_external: isExt });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toModulePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/\.(py|ts|js|tsx|jsx)$/, "")
    .replace(/\//g, ".");
}

function extractDocstring(lines: string[], startLine: number): string | null {
  const next = lines[startLine]?.trim();
  if (!next) return null;
  if (next.startsWith('"""') || next.startsWith("'''")) {
    const delim = next.slice(0, 3);
    if (next.slice(3).includes(delim)) return next.slice(3, next.lastIndexOf(delim)).trim();
    const parts = [next.slice(3)];
    for (let j = startLine + 1; j < lines.length; j++) {
      if (lines[j].includes(delim)) { parts.push(lines[j].split(delim)[0]); break; }
      parts.push(lines[j]);
    }
    return parts.join(" ").trim();
  }
  return null;
}

function extractFunctionBody(lines: string[], fnStart: number): string {
  const baseIndent = lines[fnStart].search(/\S/);
  const body: string[] = [];
  for (let i = fnStart + 1; i < lines.length && i < fnStart + 200; i++) {
    const indent = lines[i].search(/\S/);
    if (indent >= 0 && indent <= baseIndent && lines[i].trim()) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function calcCyclomatic(body: string): number {
  let n = 1;
  const branches = /\b(if|elif|else|for|while|try|except|catch|finally|switch|case|&&|\|\|)\b/g;
  let m: RegExpExecArray | null;
  while ((m = branches.exec(body)) !== null) n++;
  return n;
}

const CALL_SKIP = new Set([
  "if","for","while","return","print","len","range","str","int","float","bool",
  "list","dict","set","tuple","super","type","isinstance","hasattr","getattr",
  "setattr","console","require","import","export","await","async","new","delete",
  "typeof","void","throw","catch","finally","switch","case","break","continue",
]);

function extractCalls(body: string, callerSig: string, lineOffset: number, calls: FunctionCallEdge[]): void {
  const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRegex.exec(body)) !== null) {
    if (!CALL_SKIP.has(m[1])) {
      calls.push({ caller_signature: callerSig, callee_signature: m[1], call_site_line: lineOffset });
    }
  }
}

function extractDBAccesses(body: string, fnSig: string, dbEdges: FunctionDBEdge[]): void {
  const strRegex = /['"`]([^'"`]{0,500})['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = strRegex.exec(body)) !== null) {
    const text = m[1].toLowerCase();
    const tableMatch = text.match(/(?:from|join|into|update)\s+([a-zA-Z0-9_]+)/);
    if (tableMatch) {
      const isWrite = /\b(insert|update|delete)\b/.test(text);
      const isRead  = /\b(select|from)\b/.test(text);
      const access_type: "READ" | "WRITE" | "READ_WRITE" =
        isRead && isWrite ? "READ_WRITE" : isWrite ? "WRITE" : "READ";
      dbEdges.push({ function_signature: fnSig, table_name: tableMatch[1], access_type });
    }
  }
}
