/**
 * admin hesabının parolasını KESİN olarak admin123'e resetler + zorunlu değişimi
 * kaldırır. (Teşhis: DB'deki hash admin123 ile eşleşmiyordu → giriş 401.)
 *
 * Doğrudan hash yazar (seed no-op'una takılmaz). Kimse silinmez.
 */
import { createDb } from "@maestro/db";
import { BcryptPasswordHasher } from "@maestro/bff";
import { isEntrypoint } from "./lifecycle.js";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL yok");
  const db = createDb(url) as unknown as {
    user: {
      update: (a: unknown) => Promise<{ email: string }>;
      findUnique: (a: unknown) => Promise<{ passwordHash: string } | null>;
    };
    $disconnect: () => Promise<void>;
  };

  const hasher = new BcryptPasswordHasher(10);
  const hash = await hasher.hash("admin123");

  await db.user.update({
    where: { email: "admin" },
    data: { passwordHash: hash, active: true, mustChangePassword: false },
  });

  // Doğrula.
  const row = await db.user.findUnique({ where: { email: "admin" }, select: { passwordHash: true } });
  const ok = row ? await hasher.verify("admin123", row.passwordHash) : false;
  await db.$disconnect();

  console.log(ok
    ? "✅ admin parolası admin123 olarak ayarlandı, doğrulandı. Zorunlu değişim KAPALI."
    : "✗ Reset sonrası verify HÂLÂ yanlış — daha derin bir sorun var.");
  if (!ok) process.exit(1);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
