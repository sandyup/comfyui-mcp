import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getLogs,
  getHistory,
  type HistoryEntry,
} from "../comfyui/client.js";
import { selectNewestHistoryEntry } from "../services/history-select.js";
import { errorToToolResult } from "../utils/errors.js";

function formatHistoryEntry(
  promptId: string,
  entry: HistoryEntry,
): string {
  const lines: string[] = [];
  const status = entry.status;

  lines.push(`## Execution: ${promptId}`);
  lines.push(`**Status**: ${status.status_str} | Completed: ${status.completed}`);

  // Timing from messages
  const messages = status.messages || [];
  const start = messages.find((m) => m[0] === "execution_start");
  const end = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  if (start && end) {
    const startTs = (start[1] as { timestamp: number }).timestamp;
    const endTs = (end[1] as { timestamp: number }).timestamp;
    const durationSec = ((endTs - startTs) / 1000).toFixed(2);
    lines.push(`**Duration**: ${durationSec}s`);
  }

  // Cached nodes
  const cached = messages.find((m) => m[0] === "execution_cached");
  if (cached) {
    const cachedNodes = (cached[1] as { nodes: string[] }).nodes;
    if (cachedNodes.length > 0) {
      lines.push(`**Cached nodes**: ${cachedNodes.join(", ")}`);
    }
  }

  // Error details
  const errorMsg = messages.find((m) => m[0] === "execution_error");
  if (errorMsg) {
    const errData = errorMsg[1] as Record<string, unknown>;
    lines.push("");
    lines.push("### Error Details");

    if (errData.node_id) {
      lines.push(`**Failed node**: ${errData.node_id} (${errData.node_type || "unknown type"})`);
    }
    if (errData.exception_message) {
      lines.push(`**Exception**: ${errData.exception_message}`);
    }
    if (errData.exception_type) {
      lines.push(`**Type**: ${errData.exception_type}`);
    }
    if (Array.isArray(errData.traceback) && errData.traceback.length > 0) {
      lines.push("");
      lines.push("**Traceback**:");
      lines.push("```");
      lines.push(errData.traceback.join(""));
      lines.push("```");
    }
  }

  // Interrupted
  const interrupted = messages.find((m) => m[0] === "execution_interrupted");
  if (interrupted) {
    lines.push("");
    lines.push("**Execution was interrupted/cancelled**");
  }

  const outputKeys = Object.keys(entry.outputs || {});
  if (outputKeys.length > 0) {
    lines.push("");
    lines.push(`### Outputs (${outputKeys.length} nodes)`);
    for (const nodeId of outputKeys) {
      const raw = entry.outputs[nodeId];
      if (!raw || typeof raw !== "object") {
        lines.push(`- Node ${nodeId}: (no output data)`);
        continue;
      }
      const output = raw as Record<string, unknown>;
      // Expand media filenames so callers can use get_image directly.
      // Video keys ('videos', 'video', 'gifs') adapted from jcd315's fork
      // (jcd315/comfyui-mcp-muse, commit e13342ec).
      const mediaKeys = ["images", "videos", "video", "gifs"] as const;
      const expanded: string[] = [];
      for (const key of mediaKeys) {
        const items = output[key];
        if (!Array.isArray(items)) continue;
        const fileList = (
          items as Array<{ filename: string; subfolder?: string }>
        )
          .map((m) => (m.subfolder ? `${m.subfolder}/${m.filename}` : m.filename))
          .join(", ");
        if (fileList) expanded.push(`${key} → **${fileList}**`);
      }
      if (expanded.length > 0) {
        lines.push(`- Node ${nodeId}: ${expanded.join("; ")}`);
      } else {
        const outputTypes = Object.keys(output);
        lines.push(`- Node ${nodeId}: ${outputTypes.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

export function registerDiagnosticsTools(server: McpServer): void {
  server.tool(
    "get_logs",
    "Get ComfyUI server runtime logs. Useful for debugging execution errors, model loading issues, missing nodes, and Python tracebacks.",
    {
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum number of log lines to return from the end (default: 100)"),
      keyword: z
        .string()
        .optional()
        .describe("Filter log lines containing this keyword (case-insensitive). Examples: 'error', 'warning', 'VRAM', a node name"),
    },
    async (args) => {
      try {
        let lines = await getLogs();

        // Filter by keyword if provided
        if (args.keyword) {
          const kw = args.keyword.toLowerCase();
          lines = lines.filter((line) => line.toLowerCase().includes(kw));
        }

        // Tail to max_lines
        const maxLines = args.max_lines ?? 100;
        if (lines.length > maxLines) {
          lines = lines.slice(-maxLines);
        }

        // Strip ANSI escape codes for readability
        const clean = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

        const text = clean.length === 0
          ? `No log lines found${args.keyword ? ` matching "${args.keyword}"` : ""}.`
          : clean.join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_history",
    "Get execution history for a ComfyUI prompt. Returns status, timing, cached nodes, output details, and full error information including Python tracebacks. Use after a failed enqueue_workflow to diagnose what went wrong.",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Specific prompt ID to look up (returned by enqueue_workflow). If omitted, returns the most recent COMMITTED execution (chosen by ComfyUI's queue number, not dict order). Note: immediately after a run finishes it can briefly lag by one until ComfyUI commits the new entry — pass the prompt_id from enqueue_workflow to get that exact run, and prefer the run-finished event for naming a just-produced output.",
        ),
    },
    async (args) => {
      try {
        const history = await getHistory(args.prompt_id);
        const selected = selectNewestHistoryEntry(history, args.prompt_id);

        if (!selected) {
          return {
            content: [
              {
                type: "text",
                text: args.prompt_id
                  ? `No history found for prompt ${args.prompt_id}.`
                  : "No execution history available.",
              },
            ],
          };
        }

        const [promptId, entry] = selected;
        const text = formatHistoryEntry(promptId, entry);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
