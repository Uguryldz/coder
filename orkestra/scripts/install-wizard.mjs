#!/usr/bin/env node
/**
 * Interactive install wizard for Jira AI Orkestra.
 * Collects: admin credentials, Jira URL/token, Bitbucket URL/token, Claude API key.
 * Writes .env and runs initial setup commands.
 */
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const ENV_PATH = path.join(ROOT, ".env");
const EXAMPLE_PATH = path.join(ROOT, ".env.example");

function banner() {
  console.log("\n" + "=".repeat(64));
  console.log(" Jira AI Orkestra — Install Wizard");
  console.log("=".repeat(64) + "\n");
}

async function ask(rl, q, def) {
  const a = await rl.question(def ? `${q} [${def}]: ` : `${q}: `);
  return a.trim() || def || "";
}

async function askPassword(rl, q) {
  // Minimal hidden input (not perfect but acceptable for wizard)
  process.stdout.write(`${q}: `);
  process.stdin.setRawMode?.(true);
  let buf = "";
  for await (const chunk of process.stdin) {
    const s = chunk.toString();
    if (s === "\r" || s === "\n") break;
    if (s === "") process.exit(1);
    if (s === "\b" || s.charCodeAt(0) === 127) {
      buf = buf.slice(0, -1);
      continue;
    }
    buf += s;
  }
  process.stdin.setRawMode?.(false);
  process.stdout.write("\n");
  return buf;
}

async function main() {
  banner();

  if (!fs.existsSync(EXAMPLE_PATH)) {
    console.error("Missing .env.example — run from project root.");
    process.exit(1);
  }

  if (fs.existsSync(ENV_PATH)) {
    console.log(".env zaten var. Üzerine yazmak için sil veya taşı.");
    process.exit(0);
  }

  const template = fs.readFileSync(EXAMPLE_PATH, "utf8");
  const rl = readline.createInterface({ input, output });

  const answers = {};
  console.log("Jira bağlantısı:");
  answers.JIRA_BASE_URL = await ask(rl, "  Jira DC base URL", "http://localhost:8080");
  answers.JIRA_USERNAME = await ask(rl, "  Jira username");
  answers.JIRA_API_TOKEN = await askPassword(rl, "  Jira API token");
  answers.JIRA_WEBHOOK_SECRET = await ask(rl, "  Jira webhook secret", crypto.randomUUID());

  console.log("\nBitbucket bağlantısı:");
  answers.BITBUCKET_BASE_URL = await ask(rl, "  Bitbucket DC base URL", "http://localhost:7990");
  answers.BITBUCKET_USERNAME = await ask(rl, "  Bitbucket username");
  answers.BITBUCKET_APP_PASSWORD = await askPassword(rl, "  Bitbucket app password");
  answers.BITBUCKET_WEBHOOK_SECRET = await ask(
    rl,
    "  Bitbucket webhook secret",
    crypto.randomUUID(),
  );

  console.log("\nClaude:");
  answers.ANTHROPIC_API_KEY = await askPassword(
    rl,
    "  Anthropic API key (boş bırakabilirsin — mock mod)",
  );
  answers.LLM_MODE = answers.ANTHROPIC_API_KEY ? "real" : "mock";

  console.log("\nSlack (opsiyonel):");
  answers.SLACK_WEBHOOK_URL = await ask(rl, "  Slack webhook URL (ENTER: atla)");

  console.log("\nAuth:");
  answers.NEXTAUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();

  await rl.close();

  let out = template;
  for (const [k, v] of Object.entries(answers)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, `${k}="${v.replace(/"/g, '\\"')}"`);
    } else {
      out += `\n${k}="${v}"`;
    }
  }

  fs.writeFileSync(ENV_PATH, out, { mode: 0o600 });
  console.log("\n✅ .env yazıldı (chmod 600).");

  console.log("\nŞimdi şu komutları çalıştır:");
  console.log("  pnpm install");
  console.log("  pnpm db:generate");
  console.log("  pnpm docker:up");
  console.log("  # ilk migration için:");
  console.log("  docker compose -f deploy/compose/docker-compose.yml exec api pnpm db:migrate");
  console.log("  # demo data için:");
  console.log("  docker compose -f deploy/compose/docker-compose.yml exec api pnpm db:seed");
  console.log("\nAgent Studio: http://localhost:3001  (admin@orkestra.local / orkestra-admin)");
  console.log("Temporal UI:  http://localhost:8233");
  console.log("MinIO UI:     http://localhost:9001");
}

main().catch((e) => {
  console.error("install wizard failed:", e);
  process.exit(1);
});
