import type { WorkPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { commentReaderFor } from "../src/stores/comment-reader.js";

/**
 * `WorkPort` DONMUŞ ve `listComments` bilerek onun dışında; yetenek somut Jira
 * sürücülerinde duruyor. Bu dosya, seam'in yapısal tespitini ölçüyor —
 * `doc-attacher`/`status-mover` testlerinin ölçtüğü şeyin aynısı.
 */

/** Yalnızca testin dokunduğu metotlar gerçek; gerisi çağrılırsa patlar. */
function workPort(over: Partial<Record<string, unknown>> = {}): WorkPort {
  const notWired = (name: string) => (): never => {
    throw new Error(`work port: ${name} bu testte bağlı değil`);
  };
  return {
    verifyWebhook: notWired("verifyWebhook"),
    getTicket: notWired("getTicket"),
    addComment: notWired("addComment"),
    updateComment: notWired("updateComment"),
    setLabels: notWired("setLabels"),
    assign: notWired("assign"),
    createLinkedIssue: notWired("createLinkedIssue"),
    parseCommand: notWired("parseCommand"),
    verifyMembership: notWired("verifyMembership"),
    transition: notWired("transition"),
    ...over,
  } as unknown as WorkPort;
}

describe("commentReaderFor", () => {
  it("yorum okuyabilen bir sürücüde seam'i verir ve çağrıyı ona iletir", async () => {
    const asked: string[] = [];
    const reader = commentReaderFor(
      workPort({
        listComments: (ticket: string) => {
          asked.push(ticket);
          return Promise.resolve([{ id: "1" }]);
        },
      }),
      "bot-1",
    );
    expect(reader).toBeDefined();
    expect(await reader?.listComments("PAY-101")).toEqual([{ id: "1" }]);
    expect(asked).toEqual(["PAY-101"]);
    expect(reader?.botUserId).toBe("bot-1");
  });

  it("yorum API'si olmayan sürücüde `undefined` — desteklenen bir cevap, arıza değil", () => {
    expect(commentReaderFor(workPort())).toBeUndefined();
  });

  it("bot kimliği verilmemişse alan HİÇ olmaz (boş string değil)", () => {
    const reader = commentReaderFor(workPort({ listComments: () => Promise.resolve([]) }));
    expect(reader).toBeDefined();
    expect("botUserId" in (reader ?? {})).toBe(false);
  });

  it("boş/boşluk bir bot kimliği de yok sayılır", () => {
    const reader = commentReaderFor(workPort({ listComments: () => Promise.resolve([]) }), "   ");
    expect("botUserId" in (reader ?? {})).toBe(false);
  });

  it("`this` bağlanır: metot sürücünün kendi durumunu kullanabilir", async () => {
    class Driver {
      private readonly rows = [{ id: "42" }];
      listComments(): Promise<unknown[]> {
        return Promise.resolve(this.rows);
      }
    }
    const driver = new Driver();
    const reader = commentReaderFor(workPort({ listComments: driver.listComments.bind(driver) }));
    expect(await reader?.listComments("PAY-101")).toEqual([{ id: "42" }]);
  });
});
