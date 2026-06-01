import {
  getClient,
  getHistory,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
  deleteQueueItem as clientDeleteQueueItem,
  clearQueue as clientClearQueue,
} from "../comfyui/client.js";
import * as cloudClient from "../comfyui/cloud-client.js";
import { isCloudMode } from "../config.js";
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

async function cloudJobStatus(promptId: string): Promise<JobStatus> {
  // Cloud /api/job/<id>/status returns
  //   { status: "pending" | "in_progress" | "completed" | "failed", error?, prompt_id? }
  // Map onto local JobStatus shape so callers don't care about the backend.
  const cloud = await cloudClient.getJobStatus(promptId);
  const done = cloud.status === "completed" || cloud.status === "failed";
  const base: JobStatus = {
    running: cloud.status === "in_progress",
    pending: cloud.status === "pending",
    done,
    status_str: cloud.status,
  };

  if (!done) return base;

  // Try to enrich completed jobs from /api/history_v2/<id>; if that fails,
  // fall back to the bare cloud status (with the error message if present).
  try {
    const history = await getHistory(promptId);
    const entry = history[promptId];
    if (!entry) {
      return cloud.error
        ? {
            ...base,
            error: {
              node_id: "",
              node_type: "",
              exception_message: cloud.error,
            } satisfies ExecutionErrorDetails,
          }
        : base;
    }
    const analysis = analyzeHistoryEntry(entry);
    return {
      ...base,
      status_str: entry.status?.status_str ?? cloud.status,
      error: analysis.error,
      execution_stats: analysis.execution_stats,
    };
  } catch (err) {
    logger.warn("Cloud: could not enrich job status from history", {
      prompt_id: promptId,
      error: err instanceof Error ? err.message : err,
    });
    return cloud.error
      ? {
          ...base,
          error: {
            node_id: "",
            node_type: "",
            exception_message: cloud.error,
          } satisfies ExecutionErrorDetails,
        }
      : base;
  }
}

export async function getJobStatus(
  promptId: string,
): Promise<JobStatus> {
  if (isCloudMode()) return cloudJobStatus(promptId);

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
