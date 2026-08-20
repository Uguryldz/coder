import { describe, expect, it } from "vitest";
import {
  connectionModelFrom,
  pickModelRow,
  type ConnectionModelRow,
} from "../src/stores/connection-model.js";

/**
 * The panel's rows, read as the model a run dials (M107).
 *
 * The counterpart of `connection-secrets.test.ts`, which pins the same journey
 * for the API key. What is pinned here is the other three facts — the endpoint,
 * the model id and the on-prem standing — travelling from a row an admin
 * created to the gateway that dials it.
 */

function row(overrides: Partial<ConnectionModelRow> = {}): ConnectionModelRow {
  return {
    id: "model-1",
    kind: "openai_compat",
    baseUrl: "https://gpt-oss.openshift.internal",
    secretRef: "connector:model-1:abc",
    enabled: true,
    onPrem: true,
    isDefault: false,
    configJson: { model: "gpt-oss-120b" },
    ...overrides,
  };
}

function db(rows: ConnectionModelRow[]): { connection: { findMany: () => Promise<ConnectionModelRow[]> } } {
  return { connection: { findMany: () => Promise.resolve(rows) } };
}

describe("pickModelRow", () => {
  it("prefers the row marked as default", () => {
    const picked = pickModelRow([
      row({ id: "a", configJson: { model: "first-by-id" } }),
      row({ id: "b", isDefault: true, configJson: { model: "the-default" } }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("falls back to the first by id when nothing is default", () => {
    // Deterministic rather than arbitrary: an install whose answering model
    // depends on row order is not one a bank can audit.
    const picked = pickModelRow([row({ id: "a" }), row({ id: "b" })]);
    expect(picked?.id).toBe("a");
  });

  it("ignores a disabled row", () => {
    // Disabling a model in the panel must take it out of service, not merely
    // grey it out on the screen.
    expect(pickModelRow([row({ enabled: false })])).toBeNull();
  });

  it("ignores a row that names no model", () => {
    // A connection created without a model id has not been finished. Treating
    // it as active would dial a server with no model name and fail at the
    // provider instead of here.
    expect(pickModelRow([row({ configJson: {} })])).toBeNull();
  });

  it("ignores a kind that does not name an inference endpoint", () => {
    // A Jira or GitHub connection has no authority over which model answers.
    expect(pickModelRow([row({ kind: "jira_cloud" })])).toBeNull();
  });
});

describe("connectionModelFrom", () => {
  it("round-trips a panel row into what the gateway dials", async () => {
    const resolved = await connectionModelFrom(db([row()]))();

    expect(resolved).toEqual({
      baseUrl: "https://gpt-oss.openshift.internal",
      model: "gpt-oss-120b",
      onPrem: true,
      // Deliberately the reference `llmConfig` has always handed the driver, so
      // `ConnectionSecretPort` keeps answering it exactly as it does today.
      apiKeyRef: "kv/llm#api-key",
    });
  });

  it("strips a trailing /v1 the operator pasted", async () => {
    // The driver appends `/v1` itself, so a stored base ending in one produces
    // `/v1/v1/chat/completions` and every call 404s. The panel normalises what
    // was typed; this is the runtime half of the same rule, so the probe and
    // the run address the same server.
    const resolved = await connectionModelFrom(db([row({ baseUrl: "https://llm.local/v1/" })]))();
    expect(resolved?.baseUrl).toBe("https://llm.local");
  });

  it("carries a cloud row's on-prem standing as FALSE", async () => {
    // The flag is the only thing between the confidential class and an outside
    // endpoint (M18), so it must travel exactly as the operator asserted it.
    const resolved = await connectionModelFrom(db([row({ onPrem: false })]))();
    expect(resolved?.onPrem).toBe(false);
  });

  it("answers null when the install has configured no model", async () => {
    // Not an error here: null hands the decision back to the static config, and
    // the gateway is what refuses by name when nothing answers at all.
    expect(await connectionModelFrom(db([]))()).toBeNull();
  });

  it("answers null rather than throwing when the table cannot be read", async () => {
    // A stack that predates the migration, or a database blip. Neither is a
    // reason to fail a call the environment can still answer.
    const broken = { connection: { findMany: () => Promise.reject(new Error("relation does not exist")) } };
    expect(await connectionModelFrom(broken)()).toBeNull();
  });
});
