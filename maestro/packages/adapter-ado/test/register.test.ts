import type { CiPort, ScmPort } from "@maestro/ports";
import { PortRegistry } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  ADO_DRIVER_ID,
  AdoCiDriver,
  AdoConfigError,
  AdoScmDriver,
  registerAdoDrivers,
} from "../src/index.js";
import { fixture, respondWith } from "./helpers.js";

const deps = {
  resolveToken: (tokenRef: string) => `pat-for-${tokenRef}`,
  issueSecret: () => Promise.resolve({ secret: "s", expiresAt: "2026-08-08T12:00:00.000Z" }),
};

const servicesConfig = { mode: "services", org: "ugurbank", tokenRef: "ado/services/pat" };
const serverConfig = {
  mode: "server",
  baseUrl: "https://tfs.ugurbank.local/tfs",
  collection: "DefaultCollection",
  tokenRef: "ado/server/pat",
};

describe("registerAdoDrivers (M44 registry)", () => {
  it("registers the ado driver under both the scm and the ci port", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);

    expect(registry.drivers("scm")).toEqual([ADO_DRIVER_ID]);
    expect(registry.drivers("ci")).toEqual([ADO_DRIVER_ID]);
    expect(registry.resolve<ScmPort>("scm", "ado")(servicesConfig)).toBeInstanceOf(AdoScmDriver);
    expect(registry.resolve<CiPort>("ci", "ado")(serverConfig)).toBeInstanceOf(AdoCiDriver);
  });

  it("validates the config at construction time, in both modes", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    const scm = registry.resolve<ScmPort>("scm", "ado");
    const ci = registry.resolve<CiPort>("ci", "ado");

    expect(() => scm({ mode: "services" })).toThrow(AdoConfigError);
    expect(() => scm({ ...serverConfig, collection: "" })).toThrow(AdoConfigError);
    expect(() => ci({ mode: "nowhere" })).toThrow(AdoConfigError);
  });

  it("wires the token provider through to the request", async () => {
    const registry = new PortRegistry();
    const http = respondWith(fixture("repo-get"));
    registerAdoDrivers(registry, { ...deps, fetch: http.fetch });

    const scm = registry.resolve<ScmPort>("scm", "ado")(servicesConfig);
    await scm.resolveRepo({
      appId: "ugurpay",
      displayName: "UgurPay",
      adoProject: "UgurPay",
      adoRepo: "ugurpay",
      platform: "linux-node",
      jiraComponent: null,
      maestroYamlPresent: true,
      createdVia: "onboarding",
    });

    const header = http.calls[0]!.headers["authorization"]!;
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe(
      ":pat-for-ado/services/pat",
    );
  });

  it("keeps the two ports independent — a second registration is refused", () => {
    const registry = new PortRegistry();
    registerAdoDrivers(registry, deps);
    expect(() => registerAdoDrivers(registry, deps)).toThrow(/duplicate/);
  });
});
