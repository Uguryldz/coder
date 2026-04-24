import { createHash } from "crypto";

export function knowledgeHashFromFiles(
  files: Array<{ id: string; contentHash: string; version: number }>,
): string {
  const sorted = [...files].sort((a, b) => a.id.localeCompare(b.id));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.id);
    h.update(":");
    h.update(String(f.version));
    h.update(":");
    h.update(f.contentHash);
    h.update("\n");
  }
  return h.digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
