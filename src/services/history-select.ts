import type { HistoryEntry } from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";

/**
 * Pick "the most recent" execution from a /history response.
 *
 * When `promptId` is given, /history is already scoped to that prompt, so we just
 * take the single entry. Otherwise we choose by ComfyUI's MONOTONIC queue number
 * (`history[*].prompt[0]`) rather than object iteration order — /history is keyed
 * by prompt_id and its order is not guaranteed newest-last, which otherwise made
 * callers return the PRIOR run (off-by-one). `prompt` is the tuple
 * `[queueNumber, promptId, graph, extra, outputs]`; `prompt[0]` is the order key.
 *
 * Shared by get_history and rerun_generation so both agree on "the latest run".
 */
export function selectNewestHistoryEntry(
  history: Record<string, HistoryEntry>,
  promptId?: string,
): [string, HistoryEntry] | undefined {
  const entries = Object.entries(history);
  if (entries.length === 0) return undefined;
  if (promptId) return entries[0];

  const queueNumberOf = ([, e]: [string, HistoryEntry]): number => {
    const p = e?.prompt as unknown;
    return Array.isArray(p) ? Number(p[0]) || 0 : 0;
  };
  return [...entries].sort((a, b) => queueNumberOf(b) - queueNumberOf(a))[0];
}

/**
 * Extract the API-format prompt graph that produced a history entry.
 * `entry.prompt` is the tuple `[queueNumber, promptId, graph, extra, outputs]`;
 * the graph at index 2 is the node dict we can re-enqueue. Returns null when the
 * entry has no usable graph.
 */
export function extractWorkflowGraph(entry: HistoryEntry): WorkflowJSON | null {
  const p = entry?.prompt as unknown;
  if (!Array.isArray(p) || p.length < 3) return null;
  const graph = p[2];
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
  if (Object.keys(graph as Record<string, unknown>).length === 0) return null;
  return graph as WorkflowJSON;
}
