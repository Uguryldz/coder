import { describe, expect, it } from "vitest";
import { JiraDcWorkPort } from "../src/work-port.js";
import { JiraDcConfig } from "../src/config.js";
import { fixture, stubFetch, type FetchStub } from "./helpers.js";

/**
 * Data Center attachments (M44 seam `AttachmentReader`).
 *
 * The bank's tickets say "see the attached analysis document"; before this the
 * DC driver had no way to read it and the analyst never saw it. Three things
 * are pinned: the metadata read asks Jira for ONLY the attachment field, the
 * download carries the PAT to THIS Jira and nowhere else, and a login page
 * is refused rather than handed to the analyst as the document's text.
 */

const SECRET = "whsec_test";
const config = JiraDcConfig.parse({
  baseUrl: "https://jira.internal.bank",
  tokenRef: "kv/jira/pat",
  webhookSecretRef: "kv/jira/webhook",
});

function port(stub: FetchStub): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config,
    token: () => "pat-123",
    webhookSecret: () => SECRET,
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

describe("JiraDcWorkPort attachments", () => {
  it("lists a ticket's attachments with the v2 field read and the normalised shape", async () => {
    const stub = stubFetch([{ body: fixture("issue-attachments") }]);
    const list = await port(stub).readAttachments("UGURPAY-501");

    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501?fields=attachment");
    expect(list.map((a) => a.filename)).toEqual(["kredi-limit-analiz.docx", "notlar.txt", "ekran.png"]);
    expect(list[0]).toMatchObject({
      id: "10201",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 48120,
      contentUrl: "https://jira.internal.bank/secure/attachment/10201/kredi-limit-analiz.docx",
    });
  });

  it("answers [] for an issue with no attachment field rather than throwing", async () => {
    const stub = stubFetch([{ body: { key: "UGURPAY-502", fields: {} } }]);
    expect(await port(stub).readAttachments("UGURPAY-502")).toEqual([]);
  });

  it("downloads bytes from /secure/attachment with the PAT as a bearer header", async () => {
    const stub = stubFetch([{ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }]);
    const bytes = await port(stub).downloadAttachmentBytes(
      "https://jira.internal.bank/secure/attachment/10201/kredi-limit-analiz.docx",
    );

    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(stub.calls[0]!.headers["authorization"]).toBe("Bearer pat-123");
    expect(stub.calls[0]!.headers["accept"]).toBe("*/*");
    // Never the REST JSON accept header, never a body on a GET.
    expect(stub.calls[0]!.body).toBeUndefined();
  });

  it("downloads text as UTF-8", async () => {
    const stub = stubFetch([{ text: "Limit artışı skor servisinden doğrulanır — ş ğ ı" }]);
    const text = await port(stub).downloadAttachment("https://jira.internal.bank/secure/attachment/10202/notlar.txt");
    expect(text).toBe("Limit artışı skor servisinden doğrulanır — ş ğ ı");
  });

  it("refuses to send the PAT to a host that is not this Jira's", async () => {
    const stub = stubFetch([]);
    await expect(
      port(stub).downloadAttachmentBytes("https://files.example.net/secure/attachment/1/x.docx"),
    ).rejects.toThrow(/not this Jira's host/);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a login page: a 200 HTML answer is not the attachment", async () => {
    const stub = stubFetch([
      { text: "<html><body>Log in to Jira</body></html>", headers: { "content-type": "text/html;charset=UTF-8" } },
    ]);
    await expect(
      port(stub).downloadAttachmentBytes("https://jira.internal.bank/secure/attachment/10202/notlar.txt"),
    ).rejects.toThrow(/HTML page instead of the attachment/);
  });

  it("surfaces a non-2xx download as a loud HTTP error", async () => {
    const stub = stubFetch([{ status: 404, text: "not found" }]);
    await expect(
      port(stub).downloadAttachmentBytes("https://jira.internal.bank/secure/attachment/999/x.txt"),
    ).rejects.toThrow(/404/);
  });
});
