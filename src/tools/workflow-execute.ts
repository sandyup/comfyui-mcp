import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  enqueueWorkflow,
  getSystemInfo,
} from "../services/workflow-executor.js";
import { getHistory } from "../comfyui/client.js";
import {
  selectNewestHistoryEntry,
  extractWorkflowGraph,
} from "../services/history-select.js";
import { applyOverrides } from "../services/asset-registry.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { getTracker } from "../services/generation-tracker.js";
import { extractSettings } from "../services/workflow-settings-extractor.js";
import { logger } from "../utils/logger.js";

export function registerWorkflowExecuteTools(server: McpServer): void {
  server.tool(
    "enqueue_workflow",
    "Submit a ComfyUI workflow for execution and return immediately with the prompt_id and queue position. Does not wait for completion. Use get_job_status to check progress later, or get_history to retrieve results and images after completion.",
    {
      workflow: z
        .record(z.string(), z.any())
        .describe("ComfyUI workflow in API format (node ID -> {class_type, inputs})"),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed values"),
    },
    async (args) => {
      try {
        const result = await enqueueWorkflow(args.workflow, {
          disable_random_seed: args.disable_random_seed,
        });

        // Log generation settings (best-effort, don't fail the response)
        try {
          const tracker = getTracker();
          const settings = await extractSettings(args.workflow, tracker.fileHasher);
          if (settings) {
            const { settingsHash, reuseCount } = tracker.logGeneration(settings);
            logger.info("Generation tracked", { settingsHash, reuseCount });
          }
        } catch (trackErr) {
          logger.warn("Failed to track generation settings", {
            error: trackErr instanceof Error ? trackErr.message : trackErr,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "rerun_generation",
    "Re-run the workflow behind a previous generation. Retrieves the prompt graph from " +
      "execution history (by prompt_id, or the most recent run when omitted — chosen by " +
      "ComfyUI's queue number, same logic as get_history) and re-enqueues it, optionally " +
      "applying `inputs` overrides. Seeds are re-randomized unless disable_random_seed is set. " +
      "Returns the new prompt_id and the source prompt_id it came from. Clear error if no " +
      "matching history exists.",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Prompt ID of the generation to re-run. If omitted, uses the most recent execution.",
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Optional overrides applied to every node with a matching input name " +
            "(e.g. cfg, steps, sampler_name, seed, text).",
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed fields (combine with inputs.seed to reproduce exactly)."),
    },
    async (args) => {
      try {
        const history = await getHistory(args.prompt_id);
        const selected = selectNewestHistoryEntry(history, args.prompt_id);
        if (!selected) {
          throw new ValidationError(
            args.prompt_id
              ? `No execution history found for prompt ${args.prompt_id}.`
              : "No execution history available to re-run.",
          );
        }

        const [sourcePromptId, entry] = selected;
        const workflow = extractWorkflowGraph(entry);
        if (!workflow) {
          throw new ValidationError(
            `History entry ${sourcePromptId} has no usable prompt graph to re-run.`,
          );
        }

        const next = applyOverrides(workflow, args.inputs);
        const result = await enqueueWorkflow(next, {
          disable_random_seed: args.disable_random_seed,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  source_prompt_id: sourcePromptId,
                  overrides_applied: args.inputs ?? {},
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_system_stats",
    "Get system information from the connected ComfyUI server: GPU device(s), total/free VRAM, ComfyUI/Python/PyTorch versions, and OS details. Requires a running ComfyUI server (works against local or remote targets); read-only, takes no parameters. Returns the raw /system_stats JSON. Use to confirm connectivity and check available VRAM before enqueuing large workflows. Errors if the server is unreachable.",
    {},
    async () => {
      try {
        const stats = await getSystemInfo();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
