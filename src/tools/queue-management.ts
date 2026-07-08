import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getQueueSummary,
  getJobStatus,
  getQueuedWorkflow,
  moveQueuedJob,
  editQueuedJob,
  cancelRunningJob,
  cancelQueuedJob,
  clearAllQueued,
} from "../services/queue-manager.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerQueueManagementTools(server: McpServer): void {
  server.tool(
    "get_queue",
    "Get the current ComfyUI execution queue: the job running now plus all pending jobs, each with its prompt_id and position. Read-only; requires a reachable ComfyUI server (works against local or remote --comfyui-url). By default this omits queued workflow payloads to keep output small; set include_workflows:true when you need to inspect or edit the exact pending payload. Use this before cancel_job (running), cancel_queued_job/clear_queue (pending), move_queued_job, or edit_queued_job.",
    {
      include_workflows: z
        .boolean()
        .optional()
        .describe("Include each running/pending job's workflow payload and extra_data. Can be large."),
    },
    async (args) => {
      try {
        const summary = await getQueueSummary({ include_workflows: args.include_workflows });
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
    "get_queued_workflow",
    "Return the full workflow payload for one PENDING queue item by prompt_id. Read-only. This does not work for the currently running job because ComfyUI cannot safely edit a job after execution starts.",
    {
      prompt_id: z.string().describe("The prompt_id of a pending queue item."),
    },
    async (args) => {
      try {
        const item = await getQueuedWorkflow(args.prompt_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(item, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "move_queued_job",
    "Move a PENDING ComfyUI queue item to the front or back by removing it and re-enqueuing its saved workflow payload. The job receives a NEW prompt_id; the old prompt_id is removed. Running jobs cannot be moved.",
    {
      prompt_id: z.string().describe("The prompt_id of a pending queue item."),
      position: z.enum(["front", "back"]).describe("Where to requeue the job."),
    },
    async (args) => {
      try {
        const result = await moveQueuedJob(args.prompt_id, args.position);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "edit_queued_job",
    "Edit a PENDING ComfyUI queue item by removing it and re-enqueuing an updated workflow. Provide either a complete replacement workflow or node_inputs patches keyed by node id. The job receives a NEW prompt_id; the old prompt_id is removed. Running jobs cannot be edited.",
    {
      prompt_id: z.string().describe("The prompt_id of a pending queue item."),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe("Optional complete replacement API-format workflow. If omitted, the existing queued workflow is patched."),
      node_inputs: z
        .record(z.string(), z.record(z.string(), z.any()))
        .optional()
        .describe("Optional input patches keyed by node id, e.g. {\"3\":{\"steps\":30,\"cfg\":7}}."),
      position: z
        .enum(["front", "back"])
        .optional()
        .describe("Where to requeue the edited job. Defaults to back."),
    },
    async (args) => {
      try {
        const result = await editQueuedJob({
          prompt_id: args.prompt_id,
          workflow: args.workflow as WorkflowJSON | undefined,
          node_inputs: args.node_inputs,
          position: args.position,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
