import { describe, expect, it } from "vitest";
import { ContainerScanConfig, ScanConfigError, parsePinnedImage } from "../src/index.js";
import { IMAGES } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("digest pinning (M27)", () => {
  it("accepts a plain digest reference", () => {
    const image = parsePinnedImage(`zricethezav/gitleaks@${DIGEST}`);

    expect(image.name).toBe("zricethezav/gitleaks");
    expect(image.digest).toBe(DIGEST);
  });

  it("accepts a private registry with a port and a nested path", () => {
    expect(parsePinnedImage(IMAGES.trivy).digest).toBe(`sha256:${"3".repeat(64)}`);
  });

  it("refuses a tag-only reference — the whole point of M27", () => {
    expect(() => parsePinnedImage("aquasec/trivy:0.53.0")).toThrow(/not digest-pinned/);
  });

  it("refuses :latest even when a digest is present", () => {
    expect(() => parsePinnedImage(`aquasec/trivy:latest@${DIGEST}`)).toThrow(/mutable tag/);
    expect(() => parsePinnedImage(`aquasec/trivy:main@${DIGEST}`)).toThrow(/mutable tag/);
  });

  it("keeps an immutable tag next to the digest", () => {
    expect(parsePinnedImage(`aquasec/trivy:0.53.0@${DIGEST}`).digest).toBe(DIGEST);
  });

  it("refuses digests that are not sha256:<64 hex>", () => {
    expect(() => parsePinnedImage("tool@sha256:abc")).toThrow(ScanConfigError);
    expect(() => parsePinnedImage(`tool@sha256:${"A".repeat(64)}`)).toThrow(/not sha256/);
    expect(() => parsePinnedImage(`tool@md5:${"a".repeat(32)}`)).toThrow(/not sha256/);
  });

  it("refuses empty, whitespaced and double-@ references", () => {
    expect(() => parsePinnedImage("   ")).toThrow(/empty/);
    expect(() => parsePinnedImage(`tool @${DIGEST}`)).toThrow(/whitespace/);
    expect(() => parsePinnedImage(`tool@other@${DIGEST}`)).toThrow(/more than one/);
    expect(() => parsePinnedImage(`@${DIGEST}`)).toThrow(/no repository name/);
  });

  it("is enforced by the config schema, not only by the helper", () => {
    const rejected = ContainerScanConfig.safeParse({ image: "aquasec/trivy:latest" });

    expect(rejected.success).toBe(false);
    expect(JSON.stringify(rejected.error?.issues)).toMatch(/digest-pinned/);
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy }).success).toBe(true);
  });
});

describe("container configuration defaults", () => {
  it("mirrors the platform-wide scan.block_level default (M71)", () => {
    expect(ContainerScanConfig.parse({ image: IMAGES.trivy }).blockLevel).toBe("high");
  });

  it("keeps scanners offline and read-only by default", () => {
    const config = ContainerScanConfig.parse({ image: IMAGES.trivy });

    expect(config.networkMode).toBe("none");
    expect(config.workspaceMountPath).toBe("/workspace");
    expect(config.includeStderrInError).toBe(false);
    expect(config.secretSeverity).toBe("critical");
  });

  it("refuses a relative mount path and a hostile env key", () => {
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, workspaceMountPath: "ws" }).success).toBe(false);
    expect(ContainerScanConfig.safeParse({ image: IMAGES.trivy, env: { "bad-key": "x" } }).success).toBe(false);
  });
});
