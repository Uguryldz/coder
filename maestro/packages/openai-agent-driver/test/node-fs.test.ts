import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeWorkspaceFs, globToRegExp } from "../src/index.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maestro-fs-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\nconsole.log(answer);\n");
  await writeFile(join(root, "README.md"), "# demo\nanswer here\n");
  await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  return root;
}

describe("NodeWorkspaceFs", () => {
  it("reads, lists and searches inside the root", async () => {
    const fs = new NodeWorkspaceFs(await fixture());
    const file = await fs.readFile("src/index.ts", 512 * 1024);
    expect(file.content).toContain("answer = 42");
    expect(file.truncated).toBe(false);
    const entries = await fs.listDir(".");
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["file:README.md", "file:bin.dat", "dir:src"]);
    const hits = await fs.search({ text: "answer", glob: undefined, limit: 10 });
    expect(hits.map((h) => `${h.path}:${String(h.line)}`)).toEqual(["README.md:2", "src/index.ts:1", "src/index.ts:2"]);
    const narrowed = await fs.search({ text: "answer", glob: "**/*.ts", limit: 10 });
    expect(narrowed.every((h) => h.path.endsWith(".ts"))).toBe(true);
  });

  it("truncates at the byte budget", async () => {
    const fs = new NodeWorkspaceFs(await fixture());
    const file = await fs.readFile("src/index.ts", 10);
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(10);
    expect(file.bytes).toBeGreaterThan(10);
  });

  it("writes new files, creating directories, and reports bytes", async () => {
    const root = await fixture();
    const fs = new NodeWorkspaceFs(root);
    const out = await fs.writeFile("src/new/dir/file.ts", "export {};\n");
    expect(out.bytes).toBe(11);
    const back = await fs.readFile("src/new/dir/file.ts", 1024);
    expect(back.content).toBe("export {};\n");
  });

  it("refuses a symlink that points outside the root, for reads and writes", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "maestro-outside-"));
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const fs = new NodeWorkspaceFs(root);
    await expect(fs.readFile("escape/secret.txt", 1024)).rejects.toMatchObject({ rule: "path_escape" });
    await expect(fs.readFile("link.txt", 1024)).rejects.toMatchObject({ rule: "path_escape" });
    await expect(fs.writeFile("link.txt", "x")).rejects.toMatchObject({ rule: "path_escape" });
    await expect(fs.writeFile("escape/new.txt", "x")).rejects.toMatchObject({ rule: "path_escape" });
    // Symlinked entries are not even listed.
    const entries = await fs.listDir(".");
    expect(entries.some((e) => e.path === "escape" || e.path === "link.txt")).toBe(false);
  });

  it("refuses paths that resolve above the root and reports missing ones", async () => {
    const fs = new NodeWorkspaceFs(await fixture());
    await expect(fs.readFile("../etc/passwd", 1024)).rejects.toMatchObject({ rule: "path_escape" });
    await expect(fs.readFile("src/missing.ts", 1024)).rejects.toMatchObject({ rule: "not_found" });
    await expect(fs.readFile("src", 1024)).rejects.toMatchObject({ rule: "not_a_file" });
  });

  it("skips binary files and vendored directories when searching", async () => {
    const root = await fixture();
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "answer\n");
    const fs = new NodeWorkspaceFs(root);
    const hits = await fs.search({ text: "answer", glob: undefined, limit: 50 });
    expect(hits.some((h) => h.path.startsWith("node_modules"))).toBe(false);
    expect(hits.some((h) => h.path === "bin.dat")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["*.ts", "src/a.ts", true],
    ["*.ts", "src/a.tsx", false],
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "deep/er/a.ts", true],
    ["src/**", "src/x/y.js", true],
    ["src/**", "lib/x.js", false],
    ["src/*.{ts,js}", "src/a.js", true],
    ["src/*.{ts,js}", "src/a.md", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
  ])("%s vs %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
