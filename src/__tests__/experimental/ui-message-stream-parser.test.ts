import { describe, expect, it } from "vitest";

import { parseUiMessageStream } from "../../experimental/ui-message-stream-parser.js";

// ---------------------------------------------------------------------------
// Canned-stream tests for the UI message stream parser. No network — we just
// hand the parser literal SSE strings (the same shape `toUIMessageStreamResponse`
// emits) and assert the decoded chunk sequence.
// ---------------------------------------------------------------------------

describe("parseUiMessageStream", () => {
  it("decodes a full hello/world text stream", () => {
    const sse =
      'data: {"type":"text-start","id":"t1"}\n\n' +
      'data: {"type":"text-delta","id":"t1","delta":"Hello"}\n\n' +
      'data: {"type":"text-delta","id":"t1","delta":", world!"}\n\n' +
      'data: {"type":"text-end","id":"t1"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";

    const { chunks, remainder, done } = parseUiMessageStream(sse);

    expect(remainder).toBe("");
    expect(done).toBe(true);
    expect(chunks.map((c) => c.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[1]).toMatchObject({ type: "text-delta", delta: "Hello" });
    expect(chunks[2]).toMatchObject({ type: "text-delta", delta: ", world!" });
  });

  it("holds an unterminated trailing frame in remainder", () => {
    const sse =
      'data: {"type":"text-start","id":"t1"}\n\n' +
      'data: {"type":"text-delta","id":"t1","delta":"Hel';

    const { chunks, remainder, done } = parseUiMessageStream(sse);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text-start");
    expect(done).toBe(false);
    expect(remainder).toContain('"text-delta"');
    expect(remainder).toContain('"Hel'); // partial JSON
  });

  it("resumes correctly when remainder is prepended to the next slice", () => {
    const first = parseUiMessageStream(
      'data: {"type":"text-delta","id":"t1","delta":"He',
    );
    expect(first.chunks).toEqual([]);
    expect(first.done).toBe(false);

    const second = parseUiMessageStream(
      first.remainder + 'llo"}\n\ndata: [DONE]\n\n',
    );
    expect(second.chunks).toEqual([
      { type: "text-delta", id: "t1", delta: "Hello" },
    ]);
    expect(second.done).toBe(true);
    expect(second.remainder).toBe("");
  });

  it("decodes a tool-output-available chunk", () => {
    const sse =
      'data: {"type":"tool-output-available","toolCallId":"tc1","output":{"status":"stubbed","prompt":"a cat"}}\n\n';
    const { chunks } = parseUiMessageStream(sse);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "tool-output-available",
      toolCallId: "tc1",
    });
  });

  it("tolerates CRLF line endings", () => {
    const sse =
      'data: {"type":"text-start","id":"t1"}\r\n\r\n' +
      'data: {"type":"finish","finishReason":"stop"}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const { chunks, done } = parseUiMessageStream(sse);
    expect(chunks.map((c) => c.type)).toEqual(["text-start", "finish"]);
    expect(done).toBe(true);
  });

  it("ignores malformed JSON frames without throwing", () => {
    const sse =
      "data: not-json\n\n" +
      'data: {"type":"text-delta","id":"t1","delta":"ok"}\n\n';
    const { chunks } = parseUiMessageStream(sse);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "text-delta", delta: "ok" });
  });
});
