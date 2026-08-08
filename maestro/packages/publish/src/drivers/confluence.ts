import { z } from "zod";
import { NonEmpty, type PublishReceipt, type PublishRequest, type PublishTarget } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import { PublishConfigError, PublishHttpError, PublishResponseError } from "../errors.js";
import { DOC_TITLE_KEY } from "../keys.js";
import { label } from "../md.js";
import { markdownToStorage } from "../storage-format.js";
import type { FetchLike, PublishStateStore, RunContextResolver, TargetPublisher, Translate } from "../types.js";

export const ConfluencePublishConfig = z
  .object({
    /** e.g. https://confluence.internal.bank (a `/confluence` context path is fine). */
    baseUrl: z.url(),
    spaceKey: z.string().regex(/^[A-Za-z0-9._~-]+$/),
    /** SecretPort reference for the PAT — never the token itself (M80). */
    tokenRef: NonEmpty,
    parentPageId: z.string().regex(/^\d+$/).optional(),
    /** Version conflicts are someone else editing the page at the same time. */
    maxVersionAttempts: z.number().int().min(1).max(5).default(3),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    retryDelayMs: z.number().int().nonnegative().max(10_000).default(250),
  })
  .strict();
export type ConfluencePublishConfig = z.infer<typeof ConfluencePublishConfig>;

const PageVersion = z.object({ number: z.number().int().positive() });
const Page = z.object({
  id: z.string().min(1),
  version: PageVersion,
  body: z.object({ storage: z.object({ value: z.string() }) }).optional(),
});
const SearchResult = z.object({ results: z.array(Page) });
type Page = z.infer<typeof Page>;

export interface ConfluencePublisherDeps {
  secrets: SecretPort;
  state: PublishStateStore;
  runContext: RunContextResolver;
  translate: Translate;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Confluence driver (M47): one page per (run, document), created once and
 * updated afterwards — republishing bumps the page version, it never opens a
 * second page. The page id is remembered so a changed page TITLE (a catalog
 * edit, a renamed ticket) cannot orphan the page and fork the document.
 *
 * Concurrent edits answer 409; the driver re-reads the version and retries a
 * bounded number of times instead of overwriting blindly.
 */
export class ConfluencePublisher implements TargetPublisher {
  readonly target: PublishTarget = "confluence";
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ConfluencePublishConfig,
    private readonly deps: ConfluencePublisherDeps,
  ) {
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new PublishConfigError("the confluence target has no fetch implementation");
    if (typeof deps.secrets?.get !== "function") {
      throw new PublishConfigError("the confluence target needs deps.secrets (SecretPort)");
    }
    this.fetchImpl = fetchImpl;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey } = await this.deps.runContext(req.runId);
    const title = label(this.deps.translate, req.locale, DOC_TITLE_KEY[req.doc], { ticket: ticketKey });
    const storage = markdownToStorage(markdownSource);
    const stateKey = `publish:confluence:${req.runId}:${req.doc}`;

    for (let attempt = 1; attempt <= this.config.maxVersionAttempts; attempt += 1) {
      const existing = await this.locate(stateKey, title);
      if (!existing) {
        const created = await this.create(title, storage);
        await this.deps.state.set(stateKey, created.id);
        return { target: this.target, ref: created.id };
      }

      // Same bytes already on the page: a new version would be noise in the
      // page history and would tell an auditor the document changed.
      if (existing.body?.storage.value === storage) {
        await this.deps.state.set(stateKey, existing.id);
        return { target: this.target, ref: existing.id };
      }

      const updated = await this.update(existing, title, storage);
      if (updated) {
        await this.deps.state.set(stateKey, existing.id);
        return { target: this.target, ref: existing.id };
      }
      await this.sleep(this.config.retryDelayMs * attempt);
    }

    throw new PublishHttpError(409, "PUT", `${this.config.baseUrl}/rest/api/content`, `page "${title}" kept changing under us`);
  }

  /** Remembered page first, then a title lookup in the configured space. */
  private async locate(stateKey: string, title: string): Promise<Page | null> {
    const knownId = await this.deps.state.get(stateKey);
    if (knownId !== null && /^\d+$/.test(knownId)) {
      const page = await this.request("GET", `/rest/api/content/${knownId}`, { expand: "version,body.storage" });
      if (page !== null) return parse(Page, page, "page");
    }
    const found = await this.request("GET", "/rest/api/content", {
      type: "page",
      spaceKey: this.config.spaceKey,
      title,
      expand: "version,body.storage",
    });
    if (found === null) return null;
    return parse(SearchResult, found, "search").results[0] ?? null;
  }

  private async create(title: string, storage: string): Promise<Page> {
    const body = {
      type: "page",
      title,
      space: { key: this.config.spaceKey },
      ...(this.config.parentPageId ? { ancestors: [{ id: this.config.parentPageId }] } : {}),
      body: { storage: { value: storage, representation: "storage" } },
    };
    const created = await this.request("POST", "/rest/api/content", undefined, body);
    return parse(Page, created, "create");
  }

  /** True when the update landed; false on a version conflict worth retrying. */
  private async update(page: Page, title: string, storage: string): Promise<boolean> {
    const body = {
      id: page.id,
      type: "page",
      title,
      space: { key: this.config.spaceKey },
      version: { number: page.version.number + 1, minorEdit: true },
      body: { storage: { value: storage, representation: "storage" } },
    };
    try {
      await this.request("PUT", `/rest/api/content/${page.id}`, undefined, body);
      return true;
    } catch (error) {
      if (error instanceof PublishHttpError && error.status === 409) return false;
      throw error;
    }
  }

  /** Returns null for 404 (nothing there yet); every other failure throws. */
  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(this.config.baseUrl.replace(/\/+$/, "") + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const token = await this.deps.secrets.get(this.config.tokenRef);
    if (typeof token !== "string" || token.trim().length === 0) {
      // An empty PAT would be sent as `Bearer ` and Confluence would answer as
      // the anonymous user — a silent identity downgrade, not a 401.
      throw new PublishConfigError(`the resolved Confluence token (${this.config.tokenRef}) is empty`);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.config.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchImpl(url.toString(), init);
    const text = await res.text().catch(() => "");
    if (res.status === 404) return null;
    if (!res.ok) throw new PublishHttpError(res.status, method, url.toString(), text.slice(0, 500));
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PublishResponseError(method, ["body is not JSON"]);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PublishResponseError(
      what,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return parsed.data;
}
