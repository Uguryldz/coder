import { createLogger } from "@orkestra/config";
import type { KnowledgePack } from "@orkestra/contracts";
import { getDb, type KnowledgeCategory } from "@orkestra/db";
import crypto from "node:crypto";
import { getObjectSafe } from "./storage.js";

const log = createLogger("knowledge");

/**
 * Load the full knowledge pack for a variant:
 * - variant's own KnowledgeFile records
 * - shared files attached via VariantKnowledgeLink
 * Files are fetched from MinIO in parallel.
 */
export async function loadKnowledgePack(variantId: string): Promise<KnowledgePack | null> {
  const db = getDb();
  const variant = await db.agentVariant.findUnique({
    where: { id: variantId },
    include: {
      knowledgeLinks: { include: { knowledgeFile: true } },
    },
  });
  if (!variant) return null;

  // Direct variant-scoped files
  const ownFiles = await db.knowledgeFile.findMany({
    where: { scope: "variant", ownerId: variantId },
  });

  const allFiles = [
    ...ownFiles.map((f) => ({ ...f, _linked: false })),
    ...variant.knowledgeLinks.map((l) => ({ ...l.knowledgeFile, _linked: true })),
  ];

  const fetched = await Promise.all(
    allFiles.map(async (f) => {
      const content = await getObjectSafe(f.contentKey);
      if (content === null) {
        log.warn({ key: f.contentKey, file: f.filename }, "knowledge file missing from storage");
        return null;
      }
      return {
        id: f.id,
        filename: f.filename,
        category: f.category as KnowledgeCategory,
        content,
        scope: f.scope as "variant" | "shared",
        version: f.version,
      };
    }),
  );

  const files = fetched.filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    variantId: variant.id,
    variantName: variant.name,
    role: variant.role as KnowledgePack["role"],
    files,
  };
}

export function hashKnowledgePack(pack: KnowledgePack | null): string {
  if (!pack) return "none";
  const sorted = [...pack.files].sort((a, b) => a.id.localeCompare(b.id));
  const h = crypto.createHash("sha256");
  h.update(pack.variantId);
  for (const f of sorted) {
    h.update("\x1f");
    h.update(f.id);
    h.update("\x1f");
    h.update(f.version.toString());
  }
  return h.digest("hex");
}
