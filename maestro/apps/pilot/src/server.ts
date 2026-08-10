import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TicketKey } from "@maestro/contracts";
import { DOC_CONTENT_TYPE, type DocKind, type DocStore } from "./docs.js";
import { headerValue, readRawBody, requestUrl, sendJson, sendText } from "./http.js";
import type { PilotRun } from "./run.js";
import type { PilotState, StateStore } from "./state.js";

/**
 * The single page the pilot is watched from, plus the ADO Service Hook endpoint
 * the FAKE ADO delivers to. Unlike the demo there is NO Jira webhook route:
 * Atlassian Cloud cannot reach localhost, so gates are resolved by polling
 * (see run.ts). `node:http` only, no framework, no new dependency.
 */

const PAGE = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

export interface UiServerOptions {
  store: StateStore;
  run: PilotRun;
  /** Holds the generated analysis .docx/.pdf the download route streams. */
  docs: DocStore;
  /** Starts the flow for the chosen ticket; rejects if one is already running. */
  start: (ticketKey: TicketKey) => Promise<void>;
}

function isDocKind(value: string): value is DocKind {
  return value === "pdf" || value === "docx";
}

export function createUiServer(options: UiServerOptions): Server {
  const clients = new Set<ServerResponse>();

  const broadcast = (state: PilotState): void => {
    const frame = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  options.store.subscribe(broadcast);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const method = req.method ?? "GET";

    if (url.pathname === "/" && method === "GET") {
      sendText(res, 200, PAGE, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/state" && method === "GET") {
      sendJson(res, 200, options.store.snapshot());
      return;
    }

    // Download the generated analysis document. `/api/doc/pdf` or `/api/doc/docx`;
    // 404 until the analysis step has produced them for the current run.
    const docMatch = /^\/api\/doc\/([a-z]+)$/.exec(url.pathname);
    if (docMatch && method === "GET") {
      const kind = docMatch[1] ?? "";
      if (!isDocKind(kind)) {
        sendText(res, 404, "not found");
        return;
      }
      const generated = options.docs.get(kind);
      if (generated === null) {
        sendJson(res, 404, { error: "belge henüz üretilmedi" });
        return;
      }
      res.writeHead(200, {
        "content-type": DOC_CONTENT_TYPE[kind],
        "content-disposition": `attachment; filename="${generated.fileName}"`,
        "content-length": String(generated.bytes.byteLength),
        "cache-control": "no-store",
      });
      res.end(Buffer.from(generated.bytes));
      return;
    }

    if (url.pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(options.store.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Pick a discovered ticket and start the flow for it.
    if (url.pathname === "/api/start" && method === "POST") {
      const raw = await readRawBody(req);
      if (options.store.snapshot().running) {
        sendJson(res, 409, { error: "akış zaten çalışıyor" });
        return;
      }
      const body = safeJson(raw);
      const parsed = TicketKey.safeParse(body?.["ticketKey"]);
      if (!parsed.success) {
        sendJson(res, 400, { error: "geçerli bir ticketKey gerekli" });
        return;
      }
      sendJson(res, 202, { ok: true });
      void options.start(parsed.data);
      return;
    }

    if (url.pathname === "/webhooks/ado" && method === "POST") {
      const raw = await readRawBody(req);
      try {
        const body: unknown = JSON.parse(raw);
        await options.run.handleAdoWebhook(
          { authorization: headerValue(req, "authorization") ?? "" },
          body,
        );
        sendJson(res, 200, { ok: true });
      } catch (error) {
        options.store.log("err", `✗ ado service hook reddedildi: ${String(error)}`);
        sendJson(res, 401, { error: String(error) });
      }
      return;
    }

    sendText(res, 404, "not found");
  }

  return server;
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
