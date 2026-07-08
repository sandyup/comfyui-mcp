import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateImage } from "../services/generate-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

async function resolveCheckpoint(): Promise<string | undefined> {
  try {
    const models = await listLocalModels("checkpoints");
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt — the high-level entry point. Builds a txt2img workflow, " +
      "filling any unspecified parameter from your configured defaults (set_defaults / COMFYUI_DEFAULT_* / config file), " +
      "auto-selecting a local checkpoint when none is given. Returns the prompt_id immediately; the resulting " +
      "asset_id arrives in the completion notification and can be passed to view_image or regenerate. " +
      "For full control over the node graph, use create_workflow + enqueue_workflow instead.",
    {
      prompt: z.string().describe("Positive text prompt"),
      negative_prompt: z.string().optional().describe("Negative prompt (default: empty / from defaults)"),
      width: z.number().int().positive().optional().describe("Image width"),
      height: z.number().int().positive().optional().describe("Image height"),
      steps: z.number().int().positive().optional().describe("Sampling steps"),
      cfg: z.number().positive().optional().describe("CFG scale"),
      sampler: z.string().optional().describe("Sampler name (e.g. euler, dpmpp_2m)"),
      scheduler: z.string().optional().describe("Scheduler (e.g. normal, karras)"),
      seed: z.number().int().optional().describe("Seed (omit to randomize)"),
      checkpoint: z
        .string()
        .optional()
        .describe("Checkpoint filename; auto-selected from local models if omitted"),
      batch_size: z.number().int().positive().optional().describe("Number of images to generate"),
    },
    async (args) => {
      try {
        const result = await generateImage(args, {
          resolveCheckpoint,
          enqueue: (workflow) => enqueueWorkflow(workflow),
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
                  checkpoint: result.checkpoint,
                  note: "asset_id will be available in the completion notification; use view_image or regenerate with it.",
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
}
