import { createLogger } from "@orkestra/config";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const log = createLogger("sandbox.repo-map");

// Extensions we extract signatures for.
const LANG_BY_EXT: Record<string, "ts" | "js" | "py" | "go" | "java"> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".java": "java",
};

const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
  ".gradle",
  "vendor",
];

/**
 * Load .gitignore patterns — simplified: treats each non-empty non-`#` line
 * as a substring/glob prefix match on relative paths. Full spec is out of
 * scope for the MVP.
 */
function loadGitignore(repoPath: string): string[] {
  const p = path.join(repoPath, ".gitignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^\/+/, "").replace(/\/+$/, ""));
}

function isIgnored(rel: string, patterns: string[]): boolean {
  const segs = rel.split(path.sep);
  if (segs.some((s) => DEFAULT_IGNORES.includes(s))) return true;
  for (const pat of patterns) {
    if (pat.includes("*")) {
      const re = new RegExp(
        "^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (segs.some((s) => re.test(s))) return true;
    } else if (segs.includes(pat)) {
      return true;
    }
  }
  return false;
}

/** Walk repo, respecting default + .gitignore rules, up to maxFiles files. */
function walk(repoPath: string, maxFiles: number, ignores: string[]): string[] {
  const out: string[] = [];
  const stack: string[] = [repoPath];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry);
      const rel = path.relative(repoPath, full);
      if (isIgnored(rel, ignores)) continue;

      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        const ext = path.extname(entry).toLowerCase();
        if (ext in LANG_BY_EXT) out.push(full);
      }
    }
  }
  return out;
}

// TODO: tree-sitter — replace the below regex extractors with a real
// AST for precise class/function bounds and accurate signature strings.
const RE = {
  ts: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)/gm,
    /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[A-Za-z0-9_$.]+)?/gm,
    /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/gm,
    /^\s*export\s+type\s+([A-Za-z0-9_$]+)/gm,
    /^\s{2,}(?:public|private|protected|static|async)\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/gm,
  ],
  js: [
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)/gm,
    /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm,
  ],
  py: [
    /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:->[^:]+)?:/gm,
  ],
  go: [
    /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
    /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/gm,
  ],
  java: [
    /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:[A-Za-z_<>[\],\s]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws [^{]+)?\{/gm,
    /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
  ],
} as const;

function extractSignatures(src: string, lang: "ts" | "js" | "py" | "go" | "java"): string[] {
  const sigs: string[] = [];
  for (const re of RE[lang]) {
    // Fresh regex per pass to reset lastIndex.
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(src)) !== null) {
      const line = src.slice(m.index, m.index + m[0].length).trim();
      sigs.push(line.length > 180 ? line.slice(0, 180) + "…" : line);
    }
  }
  return sigs;
}

/**
 * Produce a compact plain-text repository "skeleton" suitable for
 * injection into a developer agent's prompt. Respects .gitignore and
 * caps the file count to keep tokens predictable.
 */
export function buildRepoSkeleton(repoPath: string, maxFiles = 500): string {
  const ignores = loadGitignore(repoPath);
  const files = walk(repoPath, maxFiles, ignores);
  log.debug({ repoPath, count: files.length }, "scanned files for skeleton");

  const lines: string[] = [];
  lines.push(`# Repo skeleton (${files.length} files, max ${maxFiles})`);
  lines.push("");

  for (const abs of files) {
    const rel = path.relative(repoPath, abs);
    const ext = path.extname(abs).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;

    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (src.length > 512 * 1024) continue; // skip very large files

    const sigs = extractSignatures(src, lang);
    if (sigs.length === 0) continue;

    lines.push(`## ${rel}`);
    for (const s of sigs.slice(0, 60)) lines.push(`  - ${s}`);
    lines.push("");
  }

  return lines.join("\n");
}
