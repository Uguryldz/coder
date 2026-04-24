import { db } from "@/lib/db";
import { SharedLibraryClient } from "./shared-library-client";

export const dynamic = "force-dynamic";

export default async function SharedLibraryPage() {
  const files = await db.knowledgeFile.findMany({
    where: { scope: "shared" },
    orderBy: [{ category: "asc" }, { filename: "asc" }],
    include: {
      links: { select: { variantId: true } },
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Paylaşılan Bilgi Kütüphanesi</h1>
        <p className="text-sm text-muted-foreground">
          Birden çok varyant tarafından kullanılan markdown dosyaları.
        </p>
      </div>
      <SharedLibraryClient
        files={files.map((f) => ({
          id: f.id,
          filename: f.filename,
          category: f.category,
          version: f.version,
          usedBy: f.links.length,
        }))}
      />
    </div>
  );
}
