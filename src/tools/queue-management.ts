import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getQueueSummary,
  getJobStatus,
  cancelRunningJob,
  cancelQueuedJob,
  clearAllQueued,
} from "../services/queue-manager.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerQueueManagementTools(server: McpServer): void {
  server.tool(
    "get_queue",
    "Get the current ComfyUI execution queue: the job running now plus all pending jobs, each with its prompt_id and position. Read-only; requires a reachable ComfyUI server (works against local or remote --comfyui-url). Returns JSON with running and pending arrays. Use this to see what is in flight before cancel_job (running) or cancel_queued_job/clear_queue (pending); use get_job_status or get_history for the outcome of one specific prompt_id.",
    {},
    async () => {
      try {
        const summary = await getQueueSummary();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_job_status",
    "Check the status of ONE ComfyUI job by its prompt_id (the id returned by enqueue_workflow). Queries the connected ComfyUI server; requires it to be running. Returns JSON with running, pending, and done booleans, plus optional status_str, error details, and execution_stats from ComfyUI history once the job is done. Use get_queue to see the whole queue at once, and get_history for full output filenames.",
    {
      prompt_id: z.string().describe("The prompt ID returned by enqueue_workflow"),
    },
    async (args) => {
      try {
        const status = await getJobStatus(args.prompt_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "cancel_job",
    "Interrupt the CURRENTLY RUNNING ComfyUI job, optionally only when its prompt_id matches. Stops in-progress execution — the partial result is discarded and not recoverable — and does NOT remove pending/queued jobs. Requires a reachable ComfyUI server. Use this for the job actively executing now; use cancel_queued_job to remove one specific PENDING job, or clear_queue to drop ALL pending jobs. Returns a confirmation (or a no-op status when nothing is running).",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Optional. If given, only interrupts the running job when its prompt_id matches; omit to interrupt whatever is currently running.",
        ),
    },
    async (args) => {
      try {
        await cancelRunningJob(args.prompt_id);
        const target = args.prompt_id ?? "current";
        return {
          content: [
            {
              type: "text" as const,
              text: `Job cancelled successfully (target: ${target}).`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "cancel_queued_job",
    "Remove a specific pending job from the ComfyUI queue by prompt_id. Does not affect running jobs.",
    {
      prompt_id: z
        .string()
        .describe("The prompt_id of the pending job to remove from the queue"),
    },
    async (args) => {
      try {
        await cancelQueuedJob(args.prompt_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued job ${args.prompt_id} removed successfully.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "clear_queue",
    "Clear all pending jobs from the ComfyUI queue. Does not affect the currently running job.",
    {},
    async () => {
      try {
        await clearAllQueued();
        return {
          content: [
            {
              type: "text" as const,
              text: "All pending queue items cleared successfully.",
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
