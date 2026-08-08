import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD, envVarName, parseScope, parseSecretKey, SecretKeyError } from "../src/index.js";

describe("secret key grammar", () => {
  it("splits <mount>/<path>#<field>", () => {
    expect(parseSecretKey("kv/jira/pat#token")).toEqual({ mount: "kv", path: "jira/pat", field: "token" });
  });

  it("falls back to the default field", () => {
    expect(parseSecretKey("kv/jira/pat")).toEqual({ mount: "kv", path: "jira/pat", field: DEFAULT_FIELD });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSecretKey("  kv/jira/pat  ").path).toBe("jira/pat");
  });

  it.each([
    ["", "empty key"],
    ["jira", "no mount separator"],
    ["kv/", "empty trailing segment"],
    ["/jira/pat", "empty mount"],
    ["kv/../../etc/passwd", "path traversal"],
    ["kv/jira/pat#", "empty field"],
    ["kv/jira/pat#a#b", "two field separators"],
    ["kv/jira pat", "space in a segment"],
    ["kv/jira/pat#../x", "traversal in the field"],
  ])("rejects %j (%s)", (key) => {
    expect(() => parseSecretKey(key)).toThrow(SecretKeyError);
  });

  it("rejects a scope that tries to escape its prefix", () => {
    expect(() => parseScope("../../auth/token/root")).toThrow(SecretKeyError);
    expect(() => parseScope("repo/x#field")).toThrow(SecretKeyError);
    expect(() => parseScope("")).toThrow(SecretKeyError);
  });

  it("accepts a well-formed scope unchanged", () => {
    expect(parseScope(" repo/ugurpay-core/push ")).toBe("repo/ugurpay-core/push");
  });

  it("maps a key to a stable environment variable name", () => {
    const key = parseSecretKey("kv/jira/pat#token");
    expect(envVarName(key, "MAESTRO_SECRET_")).toBe("MAESTRO_SECRET_KV_JIRA_PAT__TOKEN");
    expect(envVarName(parseSecretKey("kv/jira/pat"), "MAESTRO_SECRET_")).toBe("MAESTRO_SECRET_KV_JIRA_PAT__VALUE");
  });

  it("keeps distinct keys on distinct variable names", () => {
    const a = envVarName(parseSecretKey("kv/a/b#c"), "P_");
    const b = envVarName(parseSecretKey("kv/a/b#d"), "P_");
    expect(a).not.toBe(b);
  });
});
