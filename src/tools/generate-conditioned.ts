import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  generateWithControlNet,
  generateWithIpAdapter,
  type ConditionedDeps,
} from "../services/generate-conditioned.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

async function resolveFirstModel(type: string): Promise<string | undefined> {
  try {
    const models = await listLocalModels(type);
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

const deps: ConditionedDeps = {
  resolveCheckpoint: () => resolveFirstModel("checkpoints"),
  resolveControlNetModel: () => resolveFirstModel("controlnet"),
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

const commonShape = {
  negative_prompt: z.string().optional().describe("Negative prompt (default: empty / from defaults)"),
  width: z.number().int().positive().optional().describe("Image width in pixels"),
  height: z.number().int().positive().optional().describe("Image height in pixels"),
  steps: z.number().int().positive().optional().describe("Sampling steps"),
  cfg: z.number().positive().optional().describe("CFG scale"),
  sampler: z.string().optional().describe("Sampler name (e.g. euler, dpmpp_2m)"),
  scheduler: z.string().optional().describe("Scheduler (e.g. normal, karras)"),
  seed: z.number().int().optional().describe("Seed (omit to randomize)"),
  checkpoint: z.string().optional().describe("Checkpoint filename; auto-selected if omitted"),
};

function enqueuedResult(result: { prompt_id: string; queue_remaining?: number; checkpoint: string }, tool: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            tool,
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
}

export function registerConditionedGenerationTools(server: McpServer): void {
  server.tool(
    "generate_with_controlnet",
    "Generate an image conditioned by a ControlNet preprocessed image (pose skeleton, depth, canny, normal, etc.) plus a text prompt. Upload the control image first with upload_image, then pass its filename as control_image. Unspecified params fall back to your defaults; checkpoint and controlnet_model auto-resolve from local models. Returns prompt_id immediately; asset_id arrives in the completion notification. control_image must already be a preprocessed map (this tool does not run the preprocessor); requires a running ComfyUI with a matching controlnet model in models/controlnet/.",
    {
      prompt: z.string().describe("Positive text prompt"),
      control_image: z.string().describe("Filename of the (already-uploaded) control image in ComfyUI's input dir"),
      controlnet_model: z.string().optional().describe("ControlNet model file (in models/controlnet/); auto-selected if omitted"),
      strength: z.number().positive().optional().describe("ControlNet conditioning strength, typically 0.0-2.0 (default 1.0); higher = stronger adherence to the control image"),
      ...commonShape,
    },
    async (args) => {
      try {
        return enqueuedResult(await generateWithControlNet(args, deps), "generate_with_controlnet");
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "generate_with_ip_adapter",
    "Generate an image guided by a reference image's style/subject via IP-Adapter, plus a text prompt. Requires the ComfyUI_IPAdapter_plus custom nodes. Upload the reference first with upload_image, then pass its filename as reference_image. Unspecified params fall back to your defaults; checkpoint auto-resolves. Returns prompt_id immediately; asset_id arrives in the completion notification. Requires a running ComfyUI with ComfyUI_IPAdapter_plus and a matching IP-Adapter model installed, or the workflow will fail at execution time.",
    {
      prompt: z.string().describe("Positive text prompt"),
      reference_image: z.string().describe("Filename of the (already-uploaded) reference image in ComfyUI's input dir"),
      weight: z.number().optional().describe("IP-Adapter influence on the output, typically 0.0-1.0 (default 0.8); higher = closer to the reference"),
      preset: z.string().optional().describe("IPAdapterUnifiedLoader preset (default 'PLUS (high strength)')"),
      ...commonShape,
    },
    async (args) => {
      try {
        return enqueuedResult(await generateWithIpAdapter(args, deps), "generate_with_ip_adapter");
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
