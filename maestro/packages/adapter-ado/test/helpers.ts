import { fileURLToPath } from "node:url";
import { loadFixture } from "@maestro/test-kit";
import { z } from "zod";
import type { FetchLike } from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("fixtures", import.meta.url));

/**
 * Loads a recorded-style ADO response/event. Shapes follow the documented
 * Azure DevOps REST + Service Hooks payloads for Server 2022 and Services;
 * they are the offline stand-in until corporate access allows live smoke
 * tests (insa-plani §6).
 */
export function fixture(name: string): unknown {
  return loadFixture(FIXTURE_DIR, name, z.unknown());
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, or undefined for bodyless requests. */
  body: unknown;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Deterministic offline transport: records every call, replies per handler. */
export function createFakeHttp(handler: (call: FakeCall) => FakeReply): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = (input, init) => {
    const rawBody = init?.body;
    const call: FakeCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);

    const reply = handler(call);
    const status = reply.status ?? 200;
    const body =
      status === 204
        ? null
        : (reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)));
    return Promise.resolve(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );
  };
  return { fetch, calls };
}

/** Replies with one fixture for every request — the common single-call case. */
export function respondWith(value: unknown, status = 200): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  return createFakeHttp(() => ({ status, json: value }));
}

/** Query string value of a recorded call, or null. */
export function queryOf(call: FakeCall, key: string): string | null {
  return new URL(call.url).searchParams.get(key);
}

/** Path (no query) of a recorded call. */
export function pathOf(call: FakeCall): string {
  const url = new URL(call.url);
  return `${url.origin}${url.pathname}`;
}
