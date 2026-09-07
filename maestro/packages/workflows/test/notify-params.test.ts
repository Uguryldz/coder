import type { Notification } from "@maestro/contracts";
import { renderMessage } from "@maestro/notify";
import { describe, expect, it } from "vitest";
import { escalationParams, gateOpenParams } from "../src/impl/gate.js";
import { notifyEvent } from "../src/impl/record.js";
import { makeFakes } from "./fakes.js";

/**
 * Her bildirim mesajı, kodun GERÇEKTEN gönderdiği parametrelerle çizilebilmeli.
 * `notify.gate_open` `{owner}` isterken kod `group` gönderiyordu; hatırlatma /
 * eskalasyon / devir mesajları `{days}` ve `{delegate}` isterken kod `hours`
 * gönderiyordu — her kapı bildirimi "missing parameter" ile patlıyor, kapı
 * adımı ölüyordu. Bu test katalog ile kodu aynı hizada tutar.
 */
function render(messageKey: string, params: Record<string, string>): string {
  const notification = {
    event: "gate_open",
    channel: "jira",
    to: ["x"],
    locale: "tr",
    messageKey,
    params,
    at: "2026-09-05T09:00:00.000Z",
  } as unknown as Notification;
  return renderMessage(notification).body;
}

describe("notify mesajları kodun gönderdiği parametrelerle çizilir", () => {
  it("kapı açılışı — sahipli ve sahipsiz", () => {
    expect(render("notify.gate_open", gateOpenParams("OTYT-1", "5", "tech-leads"))).toContain("tech-leads");
    expect(render("notify.gate_open", gateOpenParams("OTYT-1", "5", "onay grubu tanımlı değil"))).toContain("OTYT-1");
  });

  it("hatırlatma, eskalasyon ve vekile devir", () => {
    const params = escalationParams({ ticket: "OTYT-1", step: "5", group: "tech-leads", waitingHours: 80, deputies: ["ayse"] });
    for (const key of ["notify.gate_reminder", "notify.escalation", "notify.delegated"]) {
      const text = render(key, params);
      expect(text).toContain("OTYT-1");
      expect(text).not.toMatch(/\{\w+\}/);
    }
    expect(render("notify.delegated", params)).toContain("ayse");
    expect(render("notify.escalation", params)).toContain("3");
  });

  it("vekil yoksa devir mesajı yine çizilir — grup-deputy adıyla", () => {
    const params = escalationParams({ ticket: "OTYT-1", step: "4", group: "product-owners", waitingHours: 5, deputies: [] });
    expect(render("notify.delegated", params)).toContain("product-owners-deputy");
    expect(params["days"]).toBe("1");
  });
});

describe("notify.enabled kapalıyken", () => {
  it("hiçbir kanala gönderilmez, defterde 'bildirim kapalı' kalır", async () => {
    const fakes = makeFakes({ notifyEnabled: false });
    const run = await fakes.deps.runs.get("PAY-101");
    await notifyEvent(fakes.deps, run, {
      event: "gate_open",
      messageKey: "notify.gate_open",
      params: gateOpenParams("PAY-101", "4", "product-owners"),
      to: ["po@bank"],
      key: "open:4",
    });
    expect(fakes.recorded.notifications).toEqual([]);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("bildirim kapalı");
  });
});
