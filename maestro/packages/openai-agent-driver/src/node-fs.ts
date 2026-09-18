import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceEntry, WorkspaceFileContent, WorkspaceFs, WorkspaceMatch } from "@maestro/mcp-servers";
import { ToolPolicyError } from "@maestro/mcp-servers";

/**
 * A `WorkspaceFs` over a real directory: the run's clone in the worker.
 *
 * Confinement is the whole point. Every path the model names is resolved
 * against the root AND checked after symlink resolution, so a link inside
 * the repo pointing at `/etc` or at another run's clone resolves outside and
 * is refused. The caller has already passed the path through
 * `guardWorkspacePath` (deny-list, `..`, absolute); this class is the second
 * fence, the one the filesystem itself enforces.
 *
 * Directories the search never enters (`.git`, `node_modules`, build output)
 * are the ones no engineer greps either; they would only bury real hits.
 */
export class NodeWorkspaceFs implements WorkspaceFs {
  private realRoot: string | null = null;

  constructor(
    private readonly root: string,
    private readonly options: { readonly maxFileBytesForSearch?: number } = {},
  ) {}

  async readFile(path: string, maxBytes: number): Promise<WorkspaceFileContent> {
    const abs = await this.confine("read_file", path);
    const info = await stat(abs);
    if (!info.isFile()) throw new ToolPolicyError("read_file", "not_a_file", `read_file: "${path}" is not a file`);
    const buffer = await readFile(abs);
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return { path, content: slice.toString("utf8"), bytes: buffer.byteLength, truncated };
  }

  async writeFile(path: string, content: string): Promise<{ bytes: number }> {
    const abs = await this.confine("write_file", path, { allowMissing: true });
    // A symlink at the target would let a write land elsewhere; refuse it.
    const existing = await lstat(abs).catch(() => null);
    if (existing !== null && existing.isSymbolicLink()) {
      throw new ToolPolicyError("write_file", "path_escape", `write_file: "${path}" is a symbolic link`);
    }
    if (existing !== null && existing.isDirectory()) {
      throw new ToolPolicyError("write_file", "not_a_file", `write_file: "${path}" is a directory`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { bytes: Buffer.byteLength(content, "utf8") };
  }

  async listDir(path: string): Promise<readonly WorkspaceEntry[]> {
    const abs = await this.confine("list_dir", path);
    const entries = await readdir(abs, { withFileTypes: true });
    const out: WorkspaceEntry[] = [];
    for (const entry of entries.sort(byName)) {
      const rel = path === "." ? entry.name : `${path.replace(/\/$/, "")}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push({ path: rel, kind: "dir", bytes: 0 });
      } else if (entry.isFile()) {
        const info = await stat(join(abs, entry.name)).catch(() => null);
        out.push({ path: rel, kind: "file", bytes: info?.size ?? 0 });
      }
      // Symlinks and specials are neither listed nor followed.
    }
    return out;
  }

  async search(query: { text: string; glob: string | undefined; limit: number }): Promise<readonly WorkspaceMatch[]> {
    const root = await this.rootPath();
    const matcher = query.glob === undefined ? null : globToRegExp(query.glob);
    const needle = query.text;
    const maxBytes = this.options.maxFileBytesForSearch ?? 1024 * 1024;
    const hits: WorkspaceMatch[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= query.limit) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort(byName)) {
        if (hits.length >= query.limit) return;
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).split(sep).join("/");
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue;
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        if (matcher !== null && !matcher.test(rel)) continue;
        const info = await stat(abs).catch(() => null);
        if (info === null || info.size > maxBytes) continue;
        const buffer = await readFile(abs).catch(() => null);
        if (buffer === null || looksBinary(buffer)) continue;
        const lines = buffer.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && hits.length < query.limit; i += 1) {
          const line = lines[i] ?? "";
          if (line.includes(needle)) hits.push({ path: rel, line: i + 1, text: line.slice(0, 400) });
        }
      }
    };
    await walk(root);
    return hits;
  }

  /** Root after symlink resolution; computed once, the clone does not move. */
  private async rootPath(): Promise<string> {
    if (this.realRoot === null) this.realRoot = await realpath(this.root);
    return this.realRoot;
  }

  /**
   * Resolve a workspace-relative path to an absolute one INSIDE the root.
   * With `allowMissing` the nearest existing ancestor is what gets resolved,
   * so a new file in a new directory is still fenced by where it would land.
   */
  private async confine(tool: string, path: string, opts: { allowMissing?: boolean } = {}): Promise<string> {
    const root = await this.rootPath();
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ToolPolicyError(tool, "path_escape", `${tool}: "${path}" resolves outside the workspace`);
    }
    let probe = abs;
    let resolved: string | null = null;
    while (resolved === null) {
      try {
        resolved = await realpath(probe);
      } catch {
        if (opts.allowMissing !== true) {
          throw new ToolPolicyError(tool, "not_found", `${tool}: "${path}" does not exist`);
        }
        const parent = dirname(probe);
        if (parent === probe) {
          throw new ToolPolicyError(tool, "path_escape", `${tool}: "${path}" has no reachable ancestor`);
        }
        probe = parent;
      }
    }
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new ToolPolicyError(tool, "path_escape", `${tool}: "${path}" links outside the workspace`);
    }
    return abs;
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "bin", "obj", ".next", "coverage", ".turbo"]);

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8000);
  for (const byte of probe) if (byte === 0) return true;
  return false;
}

/**
 * The glob subset `assertSearchGlob` admits: `**`, `*`, `?`, `{a,b}`, `[...]`.
 * A pattern with no slash matches a basename anywhere (the way `git ls-files`
 * users expect `*.ts` to behave); one with a slash is anchored at the root.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` swallows zero or more directories; a bare `**` swallows anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) re += "\\{";
      else {
        const alternatives = glob
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += `(?:${alternatives.join("|")})`;
        i = close;
      }
    } else if (ch === "[") {
      const close = glob.indexOf("]", i);
      if (close === -1) re += "\\[";
      else {
        re += glob.slice(i, close + 1).replace(/^\[!/, "[^");
        i = close;
      }
    } else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
    i += 1;
  }
  const anchored = glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`;
  return new RegExp(anchored);
}

/** Stable id for a session's conversation cache key. */
export function sessionKey(workspacePath: string, vendorSessionId: string): string {
  return createHash("sha256").update(`${workspacePath}\0${vendorSessionId}`).digest("hex").slice(0, 32);
}
