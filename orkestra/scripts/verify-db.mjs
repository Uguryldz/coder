#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const variants = await db.agentVariant.findMany({ include: { activeVersion: true } });
console.log(
  `[verify] ${variants.length} variants, ${variants.filter((v) => v.active).length} active`,
);

const byRole = new Map();
for (const v of variants) {
  const arr = byRole.get(v.role) ?? [];
  arr.push(v.name);
  byRole.set(v.role, arr);
}
for (const [role, names] of byRole.entries()) {
  console.log(`  ${role}: ${names.join(", ")}`);
}

const rules = await db.routingRule.findMany({ include: { variant: true } });
console.log(`\n[verify] ${rules.length} routing rules`);
for (const r of rules) {
  console.log(`  ${r.matchComponent ?? "*"} → ${r.variant.name} [${r.workMode}]`);
}

const settings = await db.setting.findMany();
console.log(`\n[verify] ${settings.length} settings`);
for (const s of settings) console.log(`  ${s.key} = ${JSON.stringify(s.value)}`);

const pii = await db.pIIMaskingConfig.findMany();
console.log(
  `\n[verify] PII config: enabled=${pii[0]?.enabled}, ${Array.isArray(pii[0]?.fieldRules) ? pii[0].fieldRules.length : 0} field rules, ${Array.isArray(pii[0]?.patternRules) ? pii[0].patternRules.length : 0} pattern rules`,
);

const admin = await db.user.findFirst({ where: { role: "admin" } });
console.log(`\n[verify] admin user: ${admin?.email} (${admin?.active ? "active" : "disabled"})`);

await db.$disconnect();
console.log("\n[verify] OK ✅");
