import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock history retrieval + enqueue; keep applyOverrides + the queue-number
// selection helper real so we test the actual "pick newest + re-enqueue" path.
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "rerun-prompt-1",
  queue_remaining: 1,
}));
const getSystemInfoMock = vi.fn();
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
  getSystemInfo: (...a: unknown[]) => getSystemInfoMock(...a),
}));

// generation-tracker is imported by workflow-execute (used by enqueue_workflow);
// stub it so registering the tools doesn't pull in real tracker state.
vi.mock("../../services/generation-tracker.js", () => ({
  getTracker: () => ({
    fileHasher: {},
    logGeneration: () => ({ settingsHash: "x", reuseCount: 0 }),
  }),
}));
vi.mock("../../services/workflow-settings-extractor.js", () => ({
  extractSettings: async () => null,
}));

import { registerWorkflowExecuteTools } from "../../tools/workflow-execute.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowExecuteTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

// history entry: prompt tuple is [queueNumber, promptId, graph, extra, outputs].
const entry = (queueNumber: number, id: string, graph: Record<string, unknown>) => ({
  prompt: [queueNumber, id, graph, {}, []],
  outputs: {},
  status: { status_str: "success", completed: true, messages: [] },
});

const GRAPH_A = { "1": { class_type: "KSampler", inputs: { seed: 1, cfg: 7 } } };
const GRAPH_B = { "1": { class_type: "KSampler", inputs: { seed: 2, cfg: 8 } } };

beforeEach(() => {
  getHistoryMock.mockReset();
  enqueueWorkflowMock.mockClear();
});

describe("rerun_generation", () => {
  it("picks the newest run (by queue number) and re-enqueues its graph", async () => {
    getHistoryMock.mockResolvedValue({
      "old-run": entry(41, "old-run", GRAPH_A),
      "new-run": entry(42, "new-run", GRAPH_B),
    });
    const handler = getHandler("rerun_generation");

    const res = await handler({});

    expect(res.isError).toBeFalsy();
    expect(enqueueWorkflowMock).toHaveBeenCalledTimes(1);
    // Re-enqueued GRAPH_B (the newest), not GRAPH_A.
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof GRAPH_B;
    expect(enqueued["1"].inputs.seed).toBe(2);
    const out = JSON.parse(res.content[0].text);
    expect(out.prompt_id).toBe("rerun-prompt-1");
    expect(out.source_prompt_id).toBe("new-run");
  });

  it("re-runs a specific prompt_id when given", async () => {
    getHistoryMock.mockResolvedValue({ "abc-123": entry(7, "abc-123", GRAPH_A) });
    const handler = getHandler("rerun_generation");

    const res = await handler({ prompt_id: "abc-123" });

    expect(getHistoryMock).toHaveBeenCalledWith("abc-123");
    const out = JSON.parse(res.content[0].text);
    expect(out.source_prompt_id).toBe("abc-123");
  });

  it("applies overrides to the re-enqueued workflow", async () => {
    getHistoryMock.mockResolvedValue({ "abc-123": entry(7, "abc-123", GRAPH_A) });
    const handler = getHandler("rerun_generation");

    await handler({ prompt_id: "abc-123", inputs: { cfg: 12 } });

    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof GRAPH_A;
    expect(enqueued["1"].inputs.cfg).toBe(12);
  });

  it("errors clearly when there is no history", async () => {
    getHistoryMock.mockResolvedValue({});
    const handler = getHandler("rerun_generation");

    const res = await handler({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No execution history/i);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("errors when the history entry has no usable graph", async () => {
    getHistoryMock.mockResolvedValue({
      "abc-123": {
        prompt: [7, "abc-123"], // truncated tuple — no graph at index 2
        outputs: {},
        status: { status_str: "success", completed: true, messages: [] },
      },
    });
    const handler = getHandler("rerun_generation");

    const res = await handler({ prompt_id: "abc-123" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no usable prompt graph/i);
  });
});
