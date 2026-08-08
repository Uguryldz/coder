import { describe, expect, it } from "vitest";
import { ClaudeCliProtocolError } from "../src/errors.js";
import { parseStreamJson, splitLines } from "../src/stream-json.js";
import { assistantLine, initLine, OTHER_SESSION_ID, resultLine, SESSION_ID, stream } from "./helpers.js";

describe("parseStreamJson", () => {
  it("reads session, text and usage out of a normal turn", () => {
    const parsed = parseStreamJson(stream(initLine(), assistantLine("working"), resultLine()));
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.finalText).toBe("done");
    expect(parsed.numTurns).toBe(2);
    expect(parsed.isError).toBe(false);
    expect(parsed.progressMessages).toBe(2);
  });

  it("counts cached input as input, so a cached turn still burns quota (M55)", () => {
    const parsed = parseStreamJson(stream(initLine(), resultLine()));
    expect(parsed.tokensIn).toBe(125);
    expect(parsed.tokensOut).toBe(40);
  });

  it("treats a missing result message as an error, not an empty answer", () => {
    expect(() => parseStreamJson(stream(initLine(), assistantLine("hi")))).toThrow(ClaudeCliProtocolError);
  });

  it("refuses to pick one of two result messages", () => {
    expect(() => parseStreamJson(stream(initLine(), resultLine(), resultLine()))).toThrow(/exactly one result/);
  });

  it("fails when the result carries no session id — the turn could never resume", () => {
    expect(() => parseStreamJson(stream(resultLine({ session_id: "" })))).toThrow(/session_id/);
  });

  it("fails when init and result disagree about the session", () => {
    expect(() => parseStreamJson(stream(initLine(), resultLine({ session_id: OTHER_SESSION_ID })))).toThrow(
      /belongs to/,
    );
  });

  it("reports an error result instead of returning its text", () => {
    const parsed = parseStreamJson(
      stream(
        initLine(),
        resultLine({ subtype: "error_during_execution", is_error: true, errors: ["Sandbox required but unavailable"] }),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.errors).toEqual(["Sandbox required but unavailable"]);
  });

  it("treats a non-success subtype as an error even when is_error is absent", () => {
    const parsed = parseStreamJson(stream(resultLine({ subtype: "error_during_execution", is_error: undefined })));
    expect(parsed.isError).toBe(true);
    expect(parsed.errors).toEqual(["error_during_execution"]);
  });

  it("counts unparsable lines instead of dropping them silently", () => {
    const parsed = parseStreamJson(stream("Warning: something", "[]", initLine(), resultLine()));
    expect(parsed.unparsedLines).toBe(2);
  });

  it("ignores negative or non-numeric usage rather than emitting a negative token count", () => {
    const parsed = parseStreamJson(
      stream(resultLine({ usage: { input_tokens: -5, output_tokens: "many" }, num_turns: -1 })),
    );
    expect(parsed.tokensIn).toBe(0);
    expect(parsed.tokensOut).toBe(0);
    expect(parsed.numTurns).toBe(0);
  });

  it("falls back to the init session id when the result omits it", () => {
    const parsed = parseStreamJson(stream(initLine(), resultLine({ session_id: undefined })));
    expect(parsed.sessionId).toBe(SESSION_ID);
  });
});

describe("splitLines", () => {
  it("drops blank lines and trims, keeping only real records", () => {
    expect(splitLines("a\n\n  b  \n")).toEqual(["a", "b"]);
  });
});
