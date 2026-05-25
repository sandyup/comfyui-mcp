import {
  getClient,
  getHistory,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
  deleteQueueItem as clientDeleteQueueItem,
  clearQueue as clientClearQueue,
} from "../comfyui/client.js";
import type { QueueItem } from "../comfyui/types.js";
import { logger } from "../utils/logger.js";
import { analyzeHistoryEntry, type ExecutionErrorDetails, type ExecutionStats } from "./job-history.js";

export interface QueueSummary {
  running: number;
  pending: number;
  running_jobs: Array<{ prompt_id: string; number: number }>;
  pending_jobs: Array<{ prompt_id: string; number: number }>;
}

export interface JobStatus {
  running: boolean;
  pending: boolean;
  done: boolean;
  status_str?: string;
  error?: ExecutionErrorDetails;
  execution_stats?: ExecutionStats;
}

function extractJobInfo(items: QueueItem[]): Array<{ prompt_id: string; number: number }> {
  return items.map((item) => ({
    number: item[0],
    prompt_id: item[1],
  }));
}

export async function getQueueSummary(): Promise<QueueSummary> {
  const queue = await clientGetQueue();
  return {
    running: queue.queue_running.length,
    pending: queue.queue_pending.length,
    running_jobs: extractJobInfo(queue.queue_running),
    pending_jobs: extractJobInfo(queue.queue_pending),
  };
}

export async function getJobStatus(
  promptId: string,
): Promise<JobStatus> {
  const client = getClient();
  const status = await client.getPromptStatus(promptId);
  if (!status.done) return status;

  try {
    const history = await getHistory(promptId);
    const entry = history[promptId];
    if (!entry) return status;

    const analysis = analyzeHistoryEntry(entry);
    return {
      ...status,
      status_str: entry.status.status_str,
      error: analysis.error,
      execution_stats: analysis.execution_stats,
    };
  } catch (err) {
    logger.warn("Could not enrich job status from history", {
      prompt_id: promptId,
      error: err instanceof Error ? err.message : err,
    });
    return status;
  }
}

export async function cancelRunningJob(promptId?: string): Promise<void> {
  await clientInterrupt(promptId);
  logger.info("Job interrupted", { prompt_id: promptId ?? "current" });
}

export async function cancelQueuedJob(promptId: string): Promise<void> {
  await clientDeleteQueueItem(promptId);
  logger.info("Queued job removed", { prompt_id: promptId });
}

export async function clearAllQueued(): Promise<void> {
  await clientClearQueue();
  logger.info("All pending queue items cleared");
}
