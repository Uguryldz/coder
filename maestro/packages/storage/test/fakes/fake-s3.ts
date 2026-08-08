import { createHash } from "node:crypto";
import type { FetchInit, FetchLike } from "../../src/deps.js";

export interface FakeS3Object {
  data: Uint8Array;
  contentType: string;
  tagging: string | undefined;
  objectLockMode: string | undefined;
  retainUntil: string | undefined;
}

export interface FakeS3Request {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
}

export interface FakeS3Options {
  bucket: string;
  /** Server-side page cap; small values exercise the continuation loop. */
  pageSize?: number;
  /** Gateway path the endpoint is mounted under, e.g. "/storage". */
  basePath?: string;
}

/**
 * In-memory S3-compatible endpoint. It re-derives the body hash and refuses
 * unauthenticated or mis-hashed requests, so a driver bug surfaces as a failed
 * request instead of a silently accepted one.
 */
export class FakeS3 {
  readonly objects = new Map<string, FakeS3Object>();
  readonly requests: FakeS3Request[] = [];
  private readonly pageSize: number;

  constructor(private readonly options: FakeS3Options) {
    this.pageSize = options.pageSize ?? 1000;
  }

  readonly fetch: FetchLike = (url, init) => Promise.resolve(this.handle(url, init));

  private handle(url: string, init: FetchInit): Response {
    const parsed = new URL(url);
    const headers = lowerCaseKeys(init.headers);
    this.requests.push({ method: init.method, url, path: parsed.pathname, headers });

    const auth = headers["authorization"];
    if (auth === undefined || !auth.startsWith("AWS4-HMAC-SHA256 Credential=")) {
      return xmlError(403, "AccessDenied", "missing SigV4 authorization header");
    }
    if (!auth.includes("SignedHeaders=") || !auth.includes("Signature=")) {
      return xmlError(403, "AccessDenied", "malformed SigV4 authorization header");
    }
    const declaredHash = headers["x-amz-content-sha256"];
    const bodyHash = sha256Hex(init.body ?? new Uint8Array());
    if (declaredHash !== bodyHash) {
      return xmlError(400, "XAmzContentSHA256Mismatch", "payload hash does not match body");
    }

    const key = this.objectKey(parsed);
    if (key === undefined) return xmlError(404, "NoSuchBucket", "unknown bucket");
    if (init.method === "GET" && parsed.searchParams.get("list-type") === "2") {
      return this.list(parsed);
    }
    if (init.method === "PUT") return this.put(key, headers, init.body ?? new Uint8Array());
    if (init.method === "GET") return this.get(key);
    if (init.method === "DELETE") return this.remove(key);
    return xmlError(405, "MethodNotAllowed", init.method);
  }

  /** Resolves the object key for both path-style and virtual-host addressing. */
  private objectKey(url: URL): string | undefined {
    const basePath = this.options.basePath ?? "";
    const raw = decodeURIComponent(url.pathname);
    if (basePath !== "" && !raw.startsWith(basePath)) return undefined;
    const path = raw.slice(basePath.length).replace(/^\/+/, "");
    if (url.hostname.startsWith(`${this.options.bucket}.`)) return path;
    if (path === this.options.bucket) return "";
    const prefix = `${this.options.bucket}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  private put(key: string, headers: Record<string, string>, body: Uint8Array): Response {
    const existing = this.objects.get(key);
    if (existing?.retainUntil !== undefined && new Date(existing.retainUntil) > new Date()) {
      return xmlError(403, "AccessDenied", "object is protected by an object lock retention");
    }
    this.objects.set(key, {
      data: body,
      contentType: headers["content-type"] ?? "application/octet-stream",
      tagging: headers["x-amz-tagging"],
      objectLockMode: headers["x-amz-object-lock-mode"],
      retainUntil: headers["x-amz-object-lock-retain-until-date"],
    });
    return new Response(null, { status: 200 });
  }

  private get(key: string): Response {
    const object = this.objects.get(key);
    if (!object) return xmlError(404, "NoSuchKey", key);
    return new Response(object.data, {
      status: 200,
      headers: { "content-type": object.contentType },
    });
  }

  private remove(key: string): Response {
    if (!this.objects.has(key)) return xmlError(404, "NoSuchKey", key);
    this.objects.delete(key);
    return new Response(null, { status: 204 });
  }

  private list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("continuation-token");
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = after === null ? 0 : all.indexOf(after);
    const page = all.slice(start, start + this.pageSize);
    const next = all[start + this.pageSize];
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ListBucketResult><Name>${this.options.bucket}</Name>` +
      `<Prefix>${escapeXml(prefix)}</Prefix>` +
      `<KeyCount>${page.length}</KeyCount>` +
      `<IsTruncated>${next !== undefined}</IsTruncated>` +
      (next === undefined
        ? ""
        : `<NextContinuationToken>${escapeXml(next)}</NextContinuationToken>`) +
      page.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`).join("") +
      `</ListBucketResult>`;
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlError(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
      `<Message>${escapeXml(message)}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}
