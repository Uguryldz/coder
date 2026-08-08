import { z } from "zod";
import type { StoragePort } from "@maestro/ports";
import type { Clock, FetchInit, FetchLike } from "./deps.js";
import { systemClock } from "./deps.js";
import {
  ObjectLockNotConfiguredError,
  ObjectNotFoundError,
  StorageConfigError,
  StorageRequestError,
} from "./errors.js";
import {
  assertValidKey,
  assertValidPrefix,
  encodeTagging,
  RETENTION_YEARS_DEFAULT,
  retainUntil,
  RetentionClass,
  retentionPolicy,
  retentionTags,
} from "./keys.js";
import {
  canonicalUri,
  EMPTY_BODY_SHA256,
  presignQuery,
  sha256Hex,
  signRequest,
  uriEncode,
} from "./sigv4.js";
import type { SigningContext } from "./sigv4.js";
import { parseErrorCode, parseListObjectsV2 } from "./xml.js";

const MAX_PRESIGN_SECONDS = 604800; // SigV4 hard limit: 7 days.

/**
 * s3-compat driver options (M5 BYOS). The target is a corporate S3-compatible
 * endpoint; MinIO/SeaweedFS are only the dev-compose default.
 */
export const S3StorageOptions = z.object({
  /** Base endpoint, e.g. https://s3.corp.local or https://s3.corp.local:9000/gw */
  endpoint: z.url(),
  region: z.string().min(1).default("us-east-1"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "invalid bucket name"),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  /**
   * Corporate endpoints usually have no wildcard DNS/TLS, so path-style is the
   * default; AWS-style deployments switch to virtual-host.
   */
  addressing: z.enum(["path", "virtual-host"]).default("path"),
  /** Optional tenant prefix prepended to every key. Invisible to callers. */
  keyPrefix: z.string().default(""),
  /**
   * M57 WORM. Absent means the driver cannot honour objectLock puts and will
   * reject them instead of writing an unprotected object.
   */
  objectLock: z
    .object({
      mode: z.enum(["COMPLIANCE", "GOVERNANCE"]),
      years: z.number().int().positive().default(RETENTION_YEARS_DEFAULT),
    })
    .optional(),
  retentionClass: RetentionClass.default("evidence"),
  /** Emit x-amz-tagging on put (M56 lifecycle labelling). */
  tagging: z.boolean().default(true),
  maxPresignSeconds: z.number().int().positive().max(MAX_PRESIGN_SECONDS).default(3600),
});
export type S3StorageOptions = z.output<typeof S3StorageOptions>;

export interface S3StorageDeps {
  fetch: FetchLike;
  now?: Clock | undefined;
}

interface Endpoint {
  origin: string;
  host: string;
  basePath: string;
}

function splitEndpoint(endpoint: string): Endpoint {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  return { origin: url.origin, host: url.host, basePath };
}

export class S3CompatStorage implements StoragePort {
  private readonly endpoint: Endpoint;
  private readonly now: Clock;

  constructor(
    private readonly options: S3StorageOptions,
    private readonly deps: S3StorageDeps,
  ) {
    if (options.keyPrefix !== "") assertValidPrefix(options.keyPrefix);
    this.endpoint = splitEndpoint(options.endpoint);
    this.now = deps.now ?? systemClock;
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { contentType?: string; objectLock?: boolean },
  ): Promise<void> {
    const full = this.fullKey(key);
    // content-length is intentionally not signed: fetch owns that header and
    // strips caller-supplied values, which would invalidate the signature.
    const headers: Record<string, string> = {
      "content-type": opts?.contentType ?? "application/octet-stream",
    };
    if (this.options.tagging) {
      headers["x-amz-tagging"] = encodeTagging(
        retentionTags(retentionPolicy(this.options.retentionClass)),
      );
    }
    if (opts?.objectLock === true) {
      const lock = this.options.objectLock;
      if (!lock) throw new ObjectLockNotConfiguredError(key);
      headers["x-amz-object-lock-mode"] = lock.mode;
      headers["x-amz-object-lock-retain-until-date"] = retainUntil(
        this.now().toISOString(),
        lock.years,
      );
    }
    const response = await this.send("put", key, {
      method: "PUT",
      objectKey: full,
      headers,
      body: data,
    });
    await drain(response);
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.send("get", key, { method: "GET", objectKey: this.fullKey(key) });
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    assertValidPrefix(prefix);
    const fullPrefix = `${this.options.keyPrefix}${prefix}`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: fullPrefix };
      if (continuationToken !== undefined) query["continuation-token"] = continuationToken;
      const response = await this.send("list", prefix, {
        method: "GET",
        objectKey: "",
        query,
      });
      const page = parseListObjectsV2(await response.text());
      for (const key of page.keys) keys.push(key.slice(this.options.keyPrefix.length));
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys;
  }

  /** Idempotent by contract: deleting an absent key is a no-op on both drivers. */
  async delete(key: string): Promise<void> {
    try {
      const response = await this.send("delete", key, {
        method: "DELETE",
        objectKey: this.fullKey(key),
      });
      await drain(response);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return;
      throw error;
    }
  }

  async presign(key: string, ttlSeconds: number): Promise<string> {
    const full = this.fullKey(key);
    const ttl = z.number().int().positive().max(this.options.maxPresignSeconds).parse(ttlSeconds);
    const { host, path } = this.address(full);
    const query = presignQuery(
      this.signingContext(),
      { method: "GET", path, headers: { host } },
      ttl,
    );
    return `${this.baseUrl(full)}?${queryString(query)}`;
  }

  private fullKey(key: string): string {
    assertValidKey(key);
    return `${this.options.keyPrefix}${key}`;
  }

  private signingContext(): SigningContext {
    return {
      region: this.options.region,
      service: "s3",
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        sessionToken: this.options.sessionToken,
      },
      date: this.now(),
    };
  }

  /** Signed path + Host header for the configured addressing style. */
  private address(objectKey: string): { host: string; path: string } {
    const suffix = objectKey === "" ? "" : `/${objectKey}`;
    if (this.options.addressing === "virtual-host") {
      return {
        host: `${this.options.bucket}.${this.endpoint.host}`,
        path: `${this.endpoint.basePath}${suffix === "" ? "/" : suffix}`,
      };
    }
    return {
      host: this.endpoint.host,
      path: `${this.endpoint.basePath}/${this.options.bucket}${suffix}`,
    };
  }

  private baseUrl(objectKey: string): string {
    const { path } = this.address(objectKey);
    const origin =
      this.options.addressing === "virtual-host"
        ? this.endpoint.origin.replace("://", `://${this.options.bucket}.`)
        : this.endpoint.origin;
    return `${origin}${canonicalUri(path)}`;
  }

  private async send(
    operation: string,
    logicalKey: string,
    request: {
      method: string;
      objectKey: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: Uint8Array;
    },
  ): Promise<Response> {
    const { host, path } = this.address(request.objectKey);
    const payloadSha256 = request.body ? sha256Hex(request.body) : EMPTY_BODY_SHA256;
    const signed = signRequest(this.signingContext(), {
      method: request.method,
      path,
      query: request.query,
      headers: { ...request.headers, host },
      payloadSha256,
    });
    // `host` is signed but never sent explicitly: fetch derives it from the URL
    // and rejects caller-supplied values. The two always agree by construction.
    const { host: _host, ...headers } = signed;
    const query = request.query ? `?${queryString(request.query)}` : "";
    const init: FetchInit = { method: request.method, headers };
    if (request.body) init.body = request.body;
    const response = await this.deps.fetch(`${this.baseUrl(request.objectKey)}${query}`, init);
    if (response.ok) return response;
    const body = await response.text();
    if (response.status === 404 || parseErrorCode(body) === "NoSuchKey") {
      throw new ObjectNotFoundError(logicalKey);
    }
    throw new StorageRequestError(operation, logicalKey, response.status, body);
  }
}

function queryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
}

async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}

export function createS3Storage(options: unknown, deps: S3StorageDeps): StoragePort {
  const parsed = S3StorageOptions.safeParse(options);
  if (!parsed.success) {
    throw new StorageConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return new S3CompatStorage(parsed.data, deps);
}
