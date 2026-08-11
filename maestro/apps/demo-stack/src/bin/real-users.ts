/**
 * Dev launcher: the demo stack, but with the identity/session/user surface
 * pointed at the REAL Postgres (so a DB-seeded `admin`/`admin123` bootstrap
 * account and its must-change-password flow can be exercised in a browser).
 *
 * Everything ELSE stays the demo's in-memory reality — this needs no corporate
 * Jira/ADO/S3/LLM endpoints, unlike the prod `apps/deploy` boot which is
 * fail-closed on them (M6). It exists only to demo the first-run login flow
 * against the real durable user store; it is NOT a production entrypoint.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuditChain, InMemoryAuditStore } from "@maestro/audit";
import { buildServer, LocalIdentityProvider, BcryptPasswordHasher } from "@maestro/bff";
import { createDb } from "@maestro/db";
import { PrismaUserDirectory } from "../../../deploy/src/stores/users.js";
import { PrismaSessionStore } from "../../../deploy/src/stores/sessions.js";
import { PrismaKillSwitchStore } from "../../../deploy/src/stores/killswitch.js";
import { PrismaParamStore } from "../../../deploy/src/stores/params-store.js";
import { PrismaRoutingReader } from "../../../deploy/src/stores/routing.js";
import { PrismaTemplateStore } from "../../../deploy/src/stores/template.js";
import { PrismaJiraProjectBindings } from "../../../deploy/src/stores/bindings.js";
import { liveReadModels } from "../../../deploy/src/stores/read-live.js";
import { PrismaVariantCatalog } from "../../../deploy/src/stores/read-variants.js";
import { PrismaVariantWriter } from "../../../deploy/src/stores/write-variants.js";
import { AuditPiiReader, AuditDecisionReader } from "../../../deploy/src/stores/read-governance.js";
import { PrismaConnectionStore } from "../../../deploy/src/stores/connections.js";
import { EncryptedSecretStore, resolveMasterKey } from "../../../deploy/src/stores/encrypted-secret.js";
import { buildDemoStack } from "../deps.js";
import { listenAddress } from "../address.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://maestro:maestro-local-only@localhost:55432/maestro";

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL);
  const users = new PrismaUserDirectory(db.user);
  const sessions = new PrismaSessionStore(db.session);
  const identity = new LocalIdentityProvider(users, new BcryptPasswordHasher(10));

  // A dev audit chain (in-memory) — the launcher shows real DB rows for every
  // screen that has stored data; the audit trail starts empty here rather than
  // carrying the deploy image's full chain, which is fine for a login/demo box.
  const auditStore = new InMemoryAuditStore();
  const audit = new AuditChain({ store: auditStore });

  // Start from the demo deps for the parts that need a Jira/ADO/runner
  // (work/ci/scm — not exercised by login or the read screens), then swap
  // EVERYTHING that has a Postgres home for the REAL database. This is why the
  // İş akışları screen shows the real (empty) run set, not the demo's 17.
  const demo = await buildDemoStack();
  const read = liveReadModels({ db, audit: auditStore, probes: [] });
  const deps = {
    ...demo.deps,
    users,
    sessions,
    identity,
    audit,
    read,
    killSwitch: new PrismaKillSwitchStore(db.killSwitch),
    params: new PrismaParamStore(db.param, db.paramVersion),
    routing: new PrismaRoutingReader(db.jiraProjectBinding, db.routingRule),
    bindings: new PrismaJiraProjectBindings(db.jiraProjectBinding),
    templates: new PrismaTemplateStore(
      db.analysisTemplateVersion,
      db.jiraProjectBinding,
      db.workflowRun,
    ),
    // Real connector management (Ayarlar > Bağlantılar): the DB-seeded Jira +
    // OpenRouter connections, tokens AES-encrypted under CONNECTOR_MASTER_KEY.
    connections: new PrismaConnectionStore(db.connection),
    connectorSecrets: new EncryptedSecretStore(
      resolveMasterKey({
        envValue: process.env["CONNECTOR_MASTER_KEY"],
        isProduction: false,
      }),
      db.connectorSecret,
    ),
    studio: {
      variants: new PrismaVariantCatalog(db.variant, db.variantVersion),
      // The write side, so an admin can genuinely create/re-version an agent
      // variant from Studio against the real DB — the whole point of this
      // launcher is exercising the real durable stores in a browser.
      variantWriter: new PrismaVariantWriter(db.variant, db.variantVersion),
      pii: new AuditPiiReader(auditStore, db.llmCall),
      decisions: new AuditDecisionReader(auditStore),
    },
  };

  const { host, port } = listenAddress();
  const server = await buildServer(deps);
  await server.listen({ host, port });

  console.log(`\n  BFF (gerçek kullanıcı DB'si) http://${host}:${port}`);
  console.log(`  Giriş: admin / admin123  → ilk girişte parola değiştirme\n`);

  const studioDir = fileURLToPath(new URL("../../../studio", import.meta.url));
  spawn("pnpm", ["dev"], { cwd: studioDir, stdio: "inherit" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
