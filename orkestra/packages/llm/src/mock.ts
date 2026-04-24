import type { AgentRole } from "@orkestra/contracts";

/**
 * Deterministic mock LLM for tests and offline runs.
 * Produces schema-valid JSON output for each agent role.
 */
export class MockLLM {
  static output(role: AgentRole, userInput: string): string {
    switch (role) {
      case "intake": {
        const hasDesc = userInput.length > 40;
        return JSON.stringify({
          complete: hasDesc,
          missingFields: hasDesc ? [] : ["description"],
          questions: hasDesc ? [] : ["Ticket açıklamasını detaylandırır mısın?"],
          workMode: "full_auto",
          reasoning: hasDesc ? "ticket complete" : "description too short",
        });
      }
      case "analyst":
        return JSON.stringify({
          analysisDoc: `# Sepet Kupon Uygulama — Fonksiyonel Analiz

## Problem
Kullanıcı sepet ekranında kupon kodu girip anında indirim görsün.

## Kapsam
- Kupon kodu girişi (UI tarafı mevcut, backend yok)
- Validasyon: expired, used, min-cart, not-found, already-applied
- Transactional kupon kullanımı (aynı kupon 2x kullanılamaz)

## Edge Case'ler (2. analiz turunda eklenen)
1. **Vadesi dolmuş kupon** — net mesaj + indirim uygulama yok
2. **Tek kullanımlık kupon** — 2x girişte ret
3. **Çoklu kupon** — bir sepete yalnız bir kupon; yenisi girilirse ret
4. **Minimum sepet tutarı** — kupon şart karşılanmıyorsa ret
5. **Yüzde/sabit indirim** — her iki tip de desteklenir

## Kullanıcı Akışı
1. Sepet ekranında "Kupon kodu" input'u
2. "Uygula" butonu → POST /api/cart/coupon/apply
3. Geçerliyse indirim satırı görünür, toplam güncellenir
4. Geçersizse kullanıcıya spesifik hata mesajı`,
          technicalDesign: {
            approach:
              "Yeni CouponService (stateless), REST controller, Prisma migration. Kupon kullanımı atomik transaction (coupon.usedAt + cart_coupon insert tek commit). Zod ile input validation. Mevcut cart servisine entegrasyon.",
            filesToChange: [
              {
                path: "src/coupon/coupon.service.ts",
                action: "create",
                rationale: "iş mantığı — edge case'lerin hepsi tek sınıfta",
              },
              {
                path: "src/coupon/coupon.controller.ts",
                action: "create",
                rationale: "REST endpoint + Zod validation",
              },
              {
                path: "prisma/migrations/20260422_coupon/migration.sql",
                action: "create",
                rationale: "Coupon ve CartCoupon tabloları",
              },
              {
                path: "prisma/schema.prisma",
                action: "modify",
                rationale: "model tanımları (Coupon, CartCoupon)",
              },
            ],
            alternatives: [
              "Redis-cached validation — read-heavy senaryoda; MVP'de gereksiz",
              "Stored procedure — DB'ye iş mantığı gömme; test zorluğu",
            ],
            migrations: ["20260422_coupon/migration.sql"],
            infraChanges: [],
          },
          acceptanceCriteria: [
            "Geçerli kupon sepete %X veya sabit tutar indirim uygular",
            "Expired kupon reddedilir, kullanıcıya 'vadesi doldu' mesajı gösterilir",
            "Kullanılmış kupon 2. kullanımda reddedilir",
            "Minimum sepet tutarı karşılanmıyorsa kupon uygulanmaz",
            "Aynı sepete 2. kupon eklenmesi reddedilir",
            "Kupon kaldırma endpoint'i çalışır (DELETE /api/cart/:cartId/coupon)",
          ],
          risks: [
            {
              severity: "medium",
              description: "Race condition: aynı kupon 2 request ile eş zamanlı",
              mitigation: "DB-level unique + transaction + retry",
            },
            {
              severity: "low",
              description: "KVKK: kupon kullanım geçmişi kullanıcıya bağlı",
              mitigation: "CartCoupon.cartId anonim, user_id değil",
            },
          ],
          estimationHours: 6,
        });
      case "developer":
        return JSON.stringify({
          patch: `diff --git a/src/coupon/coupon.service.ts b/src/coupon/coupon.service.ts
new file mode 100644
--- /dev/null
+++ b/src/coupon/coupon.service.ts
@@ -0,0 +1,68 @@
+import { PrismaClient } from "@prisma/client";
+
+export interface ApplyCouponResult {
+  valid: boolean;
+  discountAmount: number;
+  finalPrice: number;
+  reason?: "expired" | "used" | "not_found" | "already_applied" | "min_cart";
+}
+
+export class CouponService {
+  constructor(private readonly db: PrismaClient) {}
+
+  async applyCoupon(
+    cartId: string,
+    code: string,
+    cartTotal: number,
+  ): Promise<ApplyCouponResult> {
+    const normalized = code.trim().toUpperCase();
+    const coupon = await this.db.coupon.findUnique({
+      where: { code: normalized },
+    });
+    if (!coupon) {
+      return { valid: false, discountAmount: 0, finalPrice: cartTotal, reason: "not_found" };
+    }
+    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
+      return { valid: false, discountAmount: 0, finalPrice: cartTotal, reason: "expired" };
+    }
+    if (coupon.usedAt) {
+      return { valid: false, discountAmount: 0, finalPrice: cartTotal, reason: "used" };
+    }
+    if (cartTotal < coupon.minCartAmount) {
+      return { valid: false, discountAmount: 0, finalPrice: cartTotal, reason: "min_cart" };
+    }
+
+    // Çoklu kupon engelleme — aynı sepete zaten kupon uygulanmış mı?
+    const existing = await this.db.cartCoupon.findFirst({ where: { cartId } });
+    if (existing) {
+      return { valid: false, discountAmount: 0, finalPrice: cartTotal, reason: "already_applied" };
+    }
+
+    const discountAmount =
+      coupon.discountType === "percent"
+        ? Math.round((cartTotal * coupon.discountValue) / 100)
+        : coupon.discountValue;
+    const finalPrice = Math.max(0, cartTotal - discountAmount);
+
+    await this.db.$transaction([
+      this.db.cartCoupon.create({
+        data: { cartId, couponId: coupon.id, discountAmount },
+      }),
+      this.db.coupon.update({
+        where: { id: coupon.id },
+        data: { usedAt: new Date() },
+      }),
+    ]);
+
+    return { valid: true, discountAmount, finalPrice };
+  }
+
+  async removeCoupon(cartId: string): Promise<void> {
+    await this.db.cartCoupon.deleteMany({ where: { cartId } });
+  }
+}
diff --git a/src/coupon/coupon.controller.ts b/src/coupon/coupon.controller.ts
new file mode 100644
--- /dev/null
+++ b/src/coupon/coupon.controller.ts
@@ -0,0 +1,28 @@
+import type { FastifyInstance, FastifyRequest } from "fastify";
+import { z } from "zod";
+import { CouponService } from "./coupon.service.js";
+
+const ApplyBody = z.object({
+  cartId: z.string().min(1),
+  code: z.string().min(1).max(32),
+  cartTotal: z.number().int().positive(),
+});
+
+export async function couponRoutes(app: FastifyInstance, svc: CouponService) {
+  app.post(
+    "/api/cart/coupon/apply",
+    async (req: FastifyRequest<{ Body: unknown }>, reply) => {
+      const body = ApplyBody.parse(req.body);
+      const result = await svc.applyCoupon(body.cartId, body.code, body.cartTotal);
+      if (!result.valid) return reply.status(400).send(result);
+      return result;
+    },
+  );
+
+  app.delete("/api/cart/:cartId/coupon", async (req) => {
+    const { cartId } = req.params as { cartId: string };
+    await svc.removeCoupon(cartId);
+    return { ok: true };
+  });
+}
diff --git a/prisma/migrations/20260422_coupon/migration.sql b/prisma/migrations/20260422_coupon/migration.sql
new file mode 100644
--- /dev/null
+++ b/prisma/migrations/20260422_coupon/migration.sql
@@ -0,0 +1,18 @@
+CREATE TABLE "Coupon" (
+  "id" TEXT PRIMARY KEY,
+  "code" TEXT UNIQUE NOT NULL,
+  "discountType" TEXT NOT NULL CHECK ("discountType" IN ('percent','fixed')),
+  "discountValue" INTEGER NOT NULL,
+  "minCartAmount" INTEGER NOT NULL DEFAULT 0,
+  "expiresAt" TIMESTAMP,
+  "usedAt" TIMESTAMP,
+  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
+);
+
+CREATE TABLE "CartCoupon" (
+  "id" TEXT PRIMARY KEY,
+  "cartId" TEXT NOT NULL,
+  "couponId" TEXT NOT NULL REFERENCES "Coupon"("id"),
+  "discountAmount" INTEGER NOT NULL,
+  "appliedAt" TIMESTAMP NOT NULL DEFAULT now()
+);
`,
          filesChanged: [
            "src/coupon/coupon.service.ts",
            "src/coupon/coupon.controller.ts",
            "prisma/migrations/20260422_coupon/migration.sql",
          ],
          explanation:
            "Sepete kupon uygulama akışı eklendi. CouponService, edge case'leri (expired, used, min_cart, already_applied, not_found) kapsıyor. Transactional — kupon kullanımı ile cart-coupon kaydı atomik. Controller Zod ile input validation yapıyor. DB migration: Coupon ve CartCoupon tabloları.",
          prDescription: `## Özet

Sepet ekranına **indirim kuponu uygulama** özelliği.

## Değişiklikler
- \`CouponService.applyCoupon\` — kupon geçerliliği, edge case kontrolleri
- \`CouponService.removeCoupon\` — kupon kaldırma
- \`POST /api/cart/coupon/apply\` — REST endpoint
- \`DELETE /api/cart/:cartId/coupon\` — REST endpoint
- Prisma migration: \`Coupon\` + \`CartCoupon\` tabloları

## Kabul Kriterleri
- [x] Geçerli kupon indirim uygular
- [x] Expired kupon reddedilir (reason: "expired")
- [x] Kullanılmış kupon reddedilir (reason: "used")
- [x] Min sepet tutarı kontrol edilir (reason: "min_cart")
- [x] Çoklu kupon engellenir (reason: "already_applied")
- [x] Atomik transaction (kupon.usedAt + cart_coupon insert)

## Test
- Unit: CouponService tüm edge case'ler
- Integration: REST endpoint + DB
- E2E: Checkout akışında kupon uygulama

Refs: SHOP-DEMO
🤖 AI-generated via Orkestra`,
          baseCommit: "abc123def456",
          newDependencies: [],
        });
      case "dev_reviewer":
        return JSON.stringify({
          verdict: "approve",
          comments: [],
          breaking: false,
          severity: "low",
          summary: "Mock reviewer: patch temiz görünüyor.",
        });
      case "test_designer":
        return JSON.stringify({
          scenarios: [
            {
              title: "applyCoupon: geçerli yüzde kuponu indirim uygular",
              gherkin: `Feature: Kupon Uygulama
Scenario: Geçerli kupon sepete indirim ekler
  Given 200 TL sepet "cart-1" ve "SAVE20" kuponu (20% indirim, geçerli)
  When applyCoupon çağrılır
  Then result.valid true olmalı
  And discountAmount 40 TL olmalı
  And finalPrice 160 TL olmalı`,
              code: `import { describe, it, expect, beforeEach, vi } from "vitest";
import { CouponService } from "./coupon.service.js";

describe("CouponService.applyCoupon — happy path", () => {
  let db: any;
  let svc: CouponService;
  beforeEach(() => {
    db = {
      coupon: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c1", code: "SAVE20", discountType: "percent",
          discountValue: 20, minCartAmount: 0, expiresAt: null, usedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      cartCoupon: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (ops) => ops),
    };
    svc = new CouponService(db);
  });
  it("geçerli kuponda indirim uygulanır", async () => {
    const r = await svc.applyCoupon("cart-1", "SAVE20", 200);
    expect(r.valid).toBe(true);
    expect(r.discountAmount).toBe(40);
    expect(r.finalPrice).toBe(160);
  });
});`,
              codeLanguage: "typescript",
              framework: "vitest",
              type: "unit",
              negative: false,
              tags: ["coupon", "happy-path"],
            },
            {
              title: "applyCoupon: expired kupon reddedilir",
              gherkin: `Scenario: Vadesi geçmiş kupon
  Given vadesi 2020'de dolmuş "OLD2020" kuponu
  When applyCoupon çağrılır
  Then result.valid false ve reason "expired"`,
              code: `import { describe, it, expect, vi } from "vitest";
import { CouponService } from "./coupon.service.js";

describe("CouponService.applyCoupon — expired", () => {
  it("vadesi geçmişse reddeder", async () => {
    const db: any = {
      coupon: { findUnique: vi.fn().mockResolvedValue({
        id: "c2", code: "OLD2020", discountType: "fixed",
        discountValue: 10, minCartAmount: 0,
        expiresAt: new Date("2020-01-01"), usedAt: null,
      })},
      cartCoupon: { findFirst: vi.fn() },
    };
    const r = await new CouponService(db).applyCoupon("cart-1", "OLD2020", 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("expired");
    expect(r.discountAmount).toBe(0);
  });
});`,
              codeLanguage: "typescript",
              framework: "vitest",
              type: "unit",
              negative: true,
              tags: ["coupon", "edge-case"],
            },
            {
              title: "integration: POST /api/cart/coupon/apply — gerçek DB",
              gherkin: `Scenario: Endpoint gerçek DB ile kupon uygular
  Given test DB'de SAVE10 kuponu seed edildi
  When POST /api/cart/coupon/apply body {cartId, code: "SAVE10", cartTotal: 100}
  Then HTTP 200 ve response.valid true`,
              code: `import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { build } from "../../test/fastify-helper.js";

describe("POST /api/cart/coupon/apply — integration", () => {
  const db = new PrismaClient();
  let app: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    app = await build();
    await db.coupon.create({
      data: { id: "int-1", code: "SAVE10", discountType: "fixed",
              discountValue: 10, minCartAmount: 0 },
    });
  });
  afterAll(async () => { await app.close(); await db.\$disconnect(); });

  it("geçerli kupon uygular", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/coupon/apply",
      payload: { cartId: "int-cart-1", code: "SAVE10", cartTotal: 100 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.finalPrice).toBe(90);
  });
});`,
              codeLanguage: "typescript",
              framework: "vitest",
              type: "integration",
              negative: false,
              tags: ["coupon", "api"],
            },
            {
              title: "e2e: kullanıcı sepette kupon uygular ve indirim görür",
              gherkin: `Scenario: E2E sepet + kupon akışı
  Given kullanıcı sepete 200 TL ürün ekledi
  When "SAVE20" kupon koduyla "Uygula" butonu tıklanır
  Then toplam tutar 160 TL görünür
  And "20 TL indirim uygulandı" mesajı belirir`,
              code: `import { test, expect } from "@playwright/test";

test("sepet kuponu e2e akışı", async ({ page }) => {
  await page.goto("/shop");
  await page.getByRole("button", { name: /ürünü sepete ekle/i }).first().click();
  await page.goto("/cart");

  await expect(page.getByTestId("cart-total")).toHaveText("200 ₺");

  await page.getByPlaceholder(/kupon kodu/i).fill("SAVE20");
  await page.getByRole("button", { name: /uygula/i }).click();

  await expect(page.getByText(/20 ₺ indirim uygulandı/i)).toBeVisible();
  await expect(page.getByTestId("cart-total")).toHaveText("160 ₺");
});`,
              codeLanguage: "typescript",
              framework: "playwright",
              type: "e2e",
              negative: false,
              tags: ["coupon", "e2e"],
            },
            {
              title: "negative: aynı sepete 2. kupon eklenmez",
              gherkin: `Scenario: Çoklu kupon engelleme
  Given sepete bir kupon zaten uygulandı
  When ikinci kupon uygulanmaya çalışılır
  Then reddedilir (reason: "already_applied")`,
              code: `import { describe, it, expect, vi } from "vitest";
import { CouponService } from "./coupon.service.js";

describe("CouponService.applyCoupon — already_applied", () => {
  it("sepete zaten kupon varsa reddeder", async () => {
    const db: any = {
      coupon: { findUnique: vi.fn().mockResolvedValue({
        id: "c3", code: "NEW", discountType: "fixed",
        discountValue: 5, minCartAmount: 0, expiresAt: null, usedAt: null,
      })},
      cartCoupon: { findFirst: vi.fn().mockResolvedValue({ id: "existing" }) },
    };
    const r = await new CouponService(db).applyCoupon("cart-1", "NEW", 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("already_applied");
  });
});`,
              codeLanguage: "typescript",
              framework: "vitest",
              type: "unit",
              negative: true,
              tags: ["coupon", "edge-case"],
            },
          ],
        });
      case "test_reviewer":
        return JSON.stringify({
          verdict: "approve",
          coverage: {
            pyramidSatisfied: true,
            hasNegative: true,
            hasUnit: true,
            hasIntegration: true,
            hasE2e: true,
            gaps: [],
          },
          comments: [],
        });
      case "test_runner":
        return JSON.stringify({
          results: [
            {
              scenarioTitle: "example returns greeting",
              passed: true,
              durationMs: 12,
              output: "PASS",
            },
            {
              scenarioTitle: "integration: db connection",
              passed: true,
              durationMs: 34,
              output: "PASS",
            },
            { scenarioTitle: "e2e: happy path", passed: true, durationMs: 240, output: "PASS" },
            {
              scenarioTitle: "negative: invalid input",
              passed: true,
              durationMs: 8,
              output: "PASS",
            },
          ],
          coveragePct: 82,
          flaky: [],
          overallPassed: true,
        });
    }
  }

  static tokens(text: string): { input: number; output: number } {
    // Rough estimate: 4 chars/token
    return { input: Math.ceil(text.length / 4), output: 500 };
  }
}
