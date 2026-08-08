import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  ScanConfigError,
  createFortifyScanPort,
  createSonarQubeScanPort,
  createXrayScanPort,
  parseFortify,
  parseSonarQube,
} from "../src/index.js";
import { WORKSPACE, fakeClock, fixture, stubFetch } from "./helpers.js";

const FORTIFY = { baseUrl: "https://ssc.bank.example/ssc", projectVersionId: 42 };
const SONAR = { baseUrl: "https://sonar.bank.example", projectKey: "ugurpay" };

describe("fortify driver (M77 — the bank already owns this one)", () => {
  it("refuses to exist until it is configured", () => {
    expect(() => createFortifyScanPort(undefined)).toThrow(CapabilityNotSupportedError);
    expect(() => createFortifyScanPort({})).toThrow(CapabilityNotSupportedError);
  });

  it("refuses a configured driver with no token or a plain-http SSC", () => {
    expect(() => createFortifyScanPort(FORTIFY)).toThrow(/deps.token/);
    expect(() => createFortifyScanPort({ ...FORTIFY, baseUrl: "http://ssc.bank.example" }, { token: "t" })).toThrow(
      /not https/,
    );
    expect(() => createFortifyScanPort({ baseUrl: "https://ssc" }, { token: "t" })).toThrow(ScanConfigError);
  });

  it("pulls the issue list of the configured project version with FortifyToken auth", async () => {
    const fetch = stubFetch({ body: fixture("fortify-issues") });
    const port = createFortifyScanPort(FORTIFY, { token: "ssc-token", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("fortify", WORKSPACE);

    expect(fetch.calls[0]?.url).toContain("/api/v1/projectVersions/42/issues");
    expect(fetch.calls[0]?.url).toContain("showsuppressed=false");
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("FortifyToken ssc-token");
    expect(result.outcome).toBe("fail");
    expect(result.imageDigest).toBe("fortify-ssc:projectVersion/42");
  });

  it("maps Fortify priority order onto contract severities", () => {
    const findings = parseFortify(fixture("fortify-issues")).findings;

    expect(findings[0]).toMatchObject({
      tool: "fortify",
      severity: "critical",
      ruleId: "SQL Injection",
      file: "src/main/java/com/bank/pay/PayDao.java",
      line: 88,
    });
    expect(findings[1]?.severity).toBe("medium");
  });

  it("errors — never passes — when SSC refuses or answers with rubbish", async () => {
    const cases = [{ status: 401, body: "" }, { body: "<html>proxy error</html>" }, new Error("ECONNRESET")];

    for (const response of cases) {
      const fetch = stubFetch(response);
      const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

      expect((await port.run("fortify", WORKSPACE)).outcome).toBe("error");
    }
  });

  it("errors when SSC answers 200 with a non-200 responseCode", async () => {
    const fetch = stubFetch({ body: JSON.stringify({ data: [], responseCode: 500 }) });
    const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    expect((await port.run("fortify", WORKSPACE)).outcome).toBe("error");
  });
});

describe("sonarqube driver (M77)", () => {
  it("refuses to exist until it is configured", () => {
    expect(() => createSonarQubeScanPort(undefined)).toThrow(CapabilityNotSupportedError);
  });

  it("reads open issues of the project with bearer auth", async () => {
    const fetch = stubFetch({ body: fixture("sonarqube-issues") });
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("sonarqube", WORKSPACE);

    expect(fetch.calls[0]?.url).toContain("/api/issues/search?componentKeys=ugurpay");
    expect(fetch.calls[0]?.url).toContain("resolved=false");
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sq");
    expect(result.outcome).toBe("fail");
  });

  it("maps sonar severities and strips the project prefix from the component", () => {
    const findings = parseSonarQube(fixture("sonarqube-issues")).findings;

    expect(findings[0]).toMatchObject({
      tool: "sonarqube",
      severity: "high",
      ruleId: "java:S2077",
      file: "src/main/java/com/bank/pay/PayDao.java",
      line: 88,
    });
    expect(findings[1]?.severity).toBe("low");
  });

  it("errors when the server is unreachable", async () => {
    const fetch = stubFetch(new Error("ETIMEDOUT"));
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    expect((await port.run("sonarqube", WORKSPACE)).outcome).toBe("error");
  });
});

describe("xray driver (M77 — which Xray is unresolved)", () => {
  it("refuses even when configuration is supplied, rather than guessing an API", () => {
    expect(() => createXrayScanPort()).toThrow(CapabilityNotSupportedError);
    expect(() => createXrayScanPort({ baseUrl: "https://xray.bank.example" })).toThrow(CapabilityNotSupportedError);
  });
});
