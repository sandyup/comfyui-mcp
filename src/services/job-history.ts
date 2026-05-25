import { z } from "zod";
import type { HistoryEntry } from "../comfyui/client.js";

export const TRACEBACK_MAX_CHARS = 2000;

export interface ExecutionErrorDetails {
  node_id: string;
  node_type: string;
  exception_message: string;
  exception_type?: string;
  traceback?: string;
  traceback_truncated?: boolean;
  current_inputs?: unknown;
  is_oom?: boolean;
}

export interface ExecutionStats {
  total_duration_ms?: number;
  nodes: Record<string, { duration_ms: number }>;
}

export interface HistoryAnalysis {
  error?: ExecutionErrorDetails;
  execution_stats?: ExecutionStats;
}

export type HistoryStatusMessage = readonly [string, Record<string, unknown>];

const executionErrorSchema = z.object({
  node_id: z.union([z.string(), z.number()]).optional(),
  node_type: z.string().optional(),
  exception_message: z.string().optional(),
  exception_type: z.string().optional(),
  traceback: z.union([z.string(), z.array(z.string())]).optional(),
  current_inputs: z.unknown().optional(),
}).passthrough();

export function normalizeHistoryMessages(
  entry: HistoryEntry,
): HistoryStatusMessage[] {
  const rawMessages = entry.status.messages;
  if (!Array.isArray(rawMessages)) return [];

  const messages: HistoryStatusMessage[] = [];
  for (const rawMessage of rawMessages) {
    if (!Array.isArray(rawMessage) || rawMessage.length < 2) continue;
    const [type, data] = rawMessage;
    if (typeof type !== "string") continue;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    messages.push([type, data as Record<string, unknown>]);
  }
  return messages;
}

function messageData(
  entry: HistoryEntry,
  type: string,
): Record<string, unknown> | undefined {
  const msg = normalizeHistoryMessages(entry).find((m) => m[0] === type);
  return msg?.[1];
}

function timestamp(data: Record<string, unknown> | undefined): number | undefined {
  const raw = data?.timestamp;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function durationMs(start: number, end: number): number | undefined {
  const delta = end - start;
  if (!Number.isFinite(delta) || delta < 0) return undefined;

  // ComfyUI history commonly uses epoch seconds; some websocket/event docs use
  // epoch milliseconds. Infer the unit from absolute magnitude, then fall back
  // to seconds for short relative durations.
  if (start > 1_000_000_000_000 || end > 1_000_000_000_000) {
    return Math.round(delta);
  }
  if (start > 1_000_000_000 || end > 1_000_000_000 || delta < 1000) {
    return Math.round(delta * 1000);
  }
  return Math.round(delta);
}

function tracebackText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((line) => String(line)).join("");
  return undefined;
}

function truncateTraceback(text: string): { text: string; truncated: boolean } {
  if (text.length <= TRACEBACK_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, TRACEBACK_MAX_CHARS), truncated: true };
}

function isOomError(error: ExecutionErrorDetails): boolean {
  const haystack = [
    error.exception_type,
    error.exception_message,
    error.traceback,
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes("out of memory") || haystack.includes("cuda oom");
}

export function extractExecutionError(
  entry: HistoryEntry,
): ExecutionErrorDetails | undefined {
  const parsed = executionErrorSchema.safeParse(messageData(entry, "execution_error"));
  if (!parsed.success) return undefined;

  const data = parsed.data;
  const rawTraceback = tracebackText(data.traceback);
  const traceback = rawTraceback ? truncateTraceback(rawTraceback) : undefined;
  const error: ExecutionErrorDetails = {
    node_id: data.node_id === undefined ? "" : String(data.node_id),
    node_type: data.node_type ?? "",
    exception_message: data.exception_message ?? "",
    exception_type: data.exception_type,
    traceback: traceback?.text,
    traceback_truncated: traceback?.truncated || undefined,
    current_inputs: data.current_inputs,
  };

  if (isOomError(error)) error.is_oom = true;
  return error;
}

export function extractExecutionStats(
  entry: HistoryEntry,
): ExecutionStats | undefined {
  const messages = normalizeHistoryMessages(entry);
  const startTs = timestamp(messageData(entry, "execution_start"));
  const endMsg = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  const endTs = timestamp(endMsg?.[1]);
  const nodes: ExecutionStats["nodes"] = {};

  let previousTs = startTs;
  for (const [type, data] of messages) {
    if (type !== "executed") continue;
    const executedTs = timestamp(data);
    const nodeId = data.node ?? data.node_id ?? data.display_node;
    if (executedTs === undefined || nodeId === undefined) continue;

    if (previousTs !== undefined) {
      const nodeDuration = durationMs(previousTs, executedTs);
      if (nodeDuration !== undefined) {
        nodes[String(nodeId)] = { duration_ms: nodeDuration };
      }
    }
    previousTs = executedTs;
  }

  const totalDuration =
    startTs !== undefined && endTs !== undefined
      ? durationMs(startTs, endTs)
      : undefined;

  if (totalDuration === undefined && Object.keys(nodes).length === 0) {
    return undefined;
  }
  return {
    total_duration_ms: totalDuration,
    nodes,
  };
}

export function analyzeHistoryEntry(entry: HistoryEntry): HistoryAnalysis {
  return {
    error: extractExecutionError(entry),
    execution_stats: extractExecutionStats(entry),
  };
}
