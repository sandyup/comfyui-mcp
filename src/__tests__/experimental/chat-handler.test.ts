import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  buildTools,
  handleChatRequest,
} from "../../experimental/chat-handler.js";

const tools = buildTools(tool);

// ---------------------------------------------------------------------------
// Light test of the experimental chat handler with the model mocked.
// No provider keys, no network — MockLanguageModelV3 emits a canned stream.
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const helloModel = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-delta", id: "t1", delta: ", world!" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
      ],
      chunkDelayInMs: null,
      initialDelayInMs: null,
    }),
  }),
});

describe("handleChatRequest", () => {
  it("streams a UI message response using the (mocked) model", async () => {
    const req = makeRequest({
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
    });

    const res = await handleChatRequest(req, { model: helloModel });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    // UI message stream protocol uses server-sent events.
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // The streamed text deltas should be present in the SSE body.
    expect(text).toContain("Hello");
    expect(text).toContain("world!");
  });

  it("exposes the server-side generate_image tool with an execute fn", async () => {
    const result = await tools.generate_image.execute!(
      { prompt: "a cat", width: 512, height: 512 },
      { toolCallId: "tc1", messages: [] },
    );
    expect(result).toMatchObject({
      status: "stubbed",
      prompt: "a cat",
      width: 512,
      height: 512,
    });
  });

  it("declares the six graph_* tools as client-side (no execute)", () => {
    const graphTools = [
      "graph_get_state",
      "graph_add_node",
      "graph_remove_node",
      "graph_connect",
      "graph_disconnect",
      "graph_set_widget",
    ];
    expect(Object.keys(tools)).toEqual(["generate_image", ...graphTools]);
    for (const name of graphTools) {
      // No execute → the AI SDK forwards the call to the client (the panel)
      // and pauses the stream for the result.
      expect(tools[name as keyof typeof tools].execute).toBeUndefined();
    }
  });

  it("graph tool schemas validate representative inputs", () => {
    const cases: Array<[string, unknown]> = [
      ["graph_get_state", {}],
      ["graph_add_node", { class_type: "KSampler", pos: [100, 200], title: "Sampler" }],
      ["graph_remove_node", { node_id: 4 }],
      ["graph_connect", { from_node_id: 1, from_output: "MODEL", to_node_id: 2, to_input: 0 }],
      ["graph_disconnect", { node_id: 2, input: "model" }],
      ["graph_set_widget", { node_id: 3, widget: "steps", value: 30 }],
    ];
    for (const [name, input] of cases) {
      const schema = (tools[name as keyof typeof tools] as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
      expect(schema.safeParse(input).success, `${name} should accept ${JSON.stringify(input)}`).toBe(true);
    }
    // Negative: bad value type rejected.
    const setWidget = (tools.graph_set_widget as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
    expect(setWidget.safeParse({ node_id: 3, widget: "steps", value: { nested: true } }).success).toBe(false);
  });
});
