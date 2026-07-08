import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import { buildCompletionNotification } from "../../services/job-watcher.js";

const PROMPT_ID = "prompt-complete";
const START = 1_705_505_423_000;

function historyEntry(
  messages: HistoryEntry["status"]["messages"],
  statusStr = "success",
): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: statusStr,
      completed: true,
      messages,
    },
  };
}

describe("buildCompletionNotification", () => {
  it("includes failure details and execution stats from history", () => {
    const notification = buildCompletionNotification(
      PROMPT_ID,
      historyEntry([
        ["execution_start", { prompt_id: PROMPT_ID, timestamp: START }],
        ["executed", { prompt_id: PROMPT_ID, node: "4", timestamp: START + 250 }],
        ["execution_error", {
          prompt_id: PROMPT_ID,
          node_id: "9",
          node_type: "VAEDecode",
          exception_message: "CUDA out of memory while decoding",
          exception_type: "RuntimeError",
          traceback: ["Traceback line 1\n", "Traceback line 2\n"],
          current_inputs: { samples: ["8", 0] },
          timestamp: START + 900,
        }],
      ], "error"),
      START,
    );

    expect(notification).toMatchObject({
      prompt_id: PROMPT_ID,
      status: "error",
      duration_ms: 900,
      error: {
        node_id: "9",
        node_type: "VAEDecode",
        exception_message: "CUDA out of memory while decoding",
        exception_type: "RuntimeError",
        traceback: "Traceback line 1\nTraceback line 2\n",
        current_inputs: { samples: ["8", 0] },
        is_oom: true,
      },
      execution_stats: {
        total_duration_ms: 900,
        nodes: {
          "4": { duration_ms: 250 },
        },
      },
    });
  });

  it("ignores malformed history messages while building completion notifications", () => {
    const notification = buildCompletionNotification(
      PROMPT_ID,
      {
        prompt: {},
        outputs: {},
        status: {
          status_str: "error",
          completed: true,
          messages: [
            "execution_error",
            ["execution_error"],
            ["execution_error", null],
            ["executed", "not-an-object"],
          ],
        },
      } as HistoryEntry,
      START,
    );

    expect(notification).toMatchObject({
      prompt_id: PROMPT_ID,
      status: "success",
      outputs: [],
      cached_nodes: [],
    });
    expect(notification.error).toBeUndefined();
    expect(notification.execution_stats).toBeUndefined();
  });
});
