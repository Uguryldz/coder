import { describe, expect, it } from "vitest";
import {
  assertCatalog,
  BFF_MESSAGE_KEYS,
  COMMAND_DIAGNOSIS_KEYS,
  defaultCatalog,
  MissingCatalogKeysError,
  missingKeys,
  REQUESTED_MESSAGE_KEYS,
  REQUIRED_MESSAGE_KEYS,
  stepTitleKey,
} from "../src/messages.js";
import { harness, PENDING_CATALOG_TEXT, testCatalog } from "./helpers.js";

describe("message catalog (M104)", () => {
  it("resolves every key except the ones still awaiting a catalog edit", () => {
    const outstanding = missingKeys(defaultCatalog, "tr");
    expect(outstanding.sort()).toEqual([...REQUESTED_MESSAGE_KEYS].sort());
  });

  it("resolves the same set in English", () => {
    expect(missingKeys(defaultCatalog, "en").sort()).toEqual([...REQUESTED_MESSAGE_KEYS].sort());
  });

  it("asks for exactly the keys the RAPOR documents", () => {
    expect(Object.keys(PENDING_CATALOG_TEXT).sort()).toEqual([...REQUESTED_MESSAGE_KEYS].sort());
  });

  it("covers the driver's command diagnosis keys", () => {
    expect(missingKeys(defaultCatalog, "tr", COMMAND_DIAGNOSIS_KEYS)).toEqual([]);
  });

  it("covers every step title the gate replies quote", () => {
    expect(missingKeys(defaultCatalog, "tr", [stepTitleKey("5"), stepTitleKey("12")])).toEqual([]);
  });

  it("lists all required keys, including the message set and the step titles", () => {
    for (const key of Object.values(BFF_MESSAGE_KEYS)) {
      expect(REQUIRED_MESSAGE_KEYS).toContain(key);
    }
    expect(REQUIRED_MESSAGE_KEYS).toContain(stepTitleKey("4"));
  });

  it("refuses to start when a key cannot be rendered (M6 fail-closed)", () => {
    expect(() => assertCatalog(defaultCatalog, "tr")).toThrow(MissingCatalogKeysError);
  });

  it("starts once every key resolves", () => {
    expect(() => assertCatalog(testCatalog, "tr")).not.toThrow();
  });

  it("refuses to build a server whose catalog is incomplete", async () => {
    await expect(
      harness({ deps: { messages: defaultCatalog } }),
    ).rejects.toThrow(MissingCatalogKeysError);
  });
});
