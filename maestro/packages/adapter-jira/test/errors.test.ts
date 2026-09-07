import { describe, expect, it } from "vitest";
import { JiraHttpError } from "../src/errors.js";

describe("JiraHttpError message", () => {
  it("carries Jira's own reason from the body — the panel must say WHICH field, not only 'HTTP 400'", () => {
    const error = new JiraHttpError(400, "POST", "https://jira/rest/api/2/issue", '{"errors":{"issuetype":"The issue type selected is invalid"}}');
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain("issuetype");
    expect(new JiraHttpError(500, "GET", "https://jira/x", "").message).toBe("Jira GET https://jira/x failed with HTTP 500");
  });
});
