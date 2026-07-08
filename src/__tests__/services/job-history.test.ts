import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import {
  analyzeHistoryEntry,
  extractExecutionError,
  extractExecutionStats,
} from "../../services/job-history.js";

function historyEntry(messages: unknown): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: "error",
      completed: true,
      messages,
    },
  } as HistoryEntry;
}

describe("job-history malformed message parsing", () => {
  it("ignores non-array status messages", () => {
    const entry = historyEntry({ type: "execution_error" });

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });

  it("ignores malformed message tuples and missing data objects", () => {
    const entry = historyEntry([
      "execution_start",
      ["execution_start"],
      ["execution_error", null],
      ["executed", "not-an-object"],
      [123, { timestamp: 1 }],
      ["execution_success", ["not-an-object"]],
    ]);

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });
});
