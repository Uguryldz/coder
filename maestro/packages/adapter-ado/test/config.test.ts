import { describe, expect, it } from "vitest";
import {
  ADO_API_VERSIONS,
  AdoConfigError,
  apiRoot,
  apiVersionFor,
  parseAdoConfig,
} from "../src/index.js";

const server = {
  mode: "server",
  baseUrl: "https://tfs.ugurbank.local/tfs",
  collection: "DefaultCollection",
  tokenRef: "ado/server/pat",
};

const services = {
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
};

describe("AdoConfig (M11 dual mode)", () => {
  it("accepts the on-prem shape and builds a collection-scoped API root", () => {
    const config = parseAdoConfig(server);
    expect(apiRoot(config, "UgurPay")).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis",
    );
  });

  it("defaults the Services base URL to dev.azure.com and scopes by org", () => {
    const config = parseAdoConfig(services);
    expect(apiRoot(config, "UgurPay")).toBe("https://dev.azure.com/ugurbank/UgurPay/_apis");
  });

  it("pins api-version per mode: Server 6.0, Services 7.1", () => {
    expect(apiVersionFor(parseAdoConfig(server))).toBe(ADO_API_VERSIONS.server);
    expect(apiVersionFor(parseAdoConfig(services))).toBe("7.1");
    expect(ADO_API_VERSIONS.server).toBe("6.0");
  });

  it("honours an explicit api-version override", () => {
    const config = parseAdoConfig({ ...services, apiVersion: "7.1-preview.1" });
    expect(apiVersionFor(config)).toBe("7.1-preview.1");
  });

  it("rejects an api-version that is not a version string", () => {
    expect(() => parseAdoConfig({ ...services, apiVersion: "latest" })).toThrow(AdoConfigError);
  });

  it("requires a collection in server mode and rejects it being absent", () => {
    const { collection: _collection, ...withoutCollection } = server;
    expect(() => parseAdoConfig(withoutCollection)).toThrow(AdoConfigError);
  });

  it("requires an org in services mode", () => {
    expect(() => parseAdoConfig({ mode: "services", tokenRef: "x" })).toThrow(AdoConfigError);
  });

  it("rejects an unknown mode with a readable issue list", () => {
    try {
      parseAdoConfig({ mode: "github", tokenRef: "x" });
      expect.unreachable("unknown mode must not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoConfigError);
      expect((error as AdoConfigError).issues.join()).toMatch(/mode/);
    }
  });

  it("encodes multi-segment collections and project names with spaces", () => {
    const config = parseAdoConfig({ ...server, collection: "tfs/Banka Koleksiyon" });
    expect(apiRoot(config, "Ugur Pay")).toBe(
      "https://tfs.ugurbank.local/tfs/tfs/Banka%20Koleksiyon/Ugur%20Pay/_apis",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    const config = parseAdoConfig({ ...server, baseUrl: "https://tfs.ugurbank.local/tfs/" });
    expect(apiRoot(config, "UgurPay")).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis",
    );
  });
});
