import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";
import { runHealthCheck } from "../services/health-check.js";

export function registerHealthCheckTools(server: McpServer): void {
  server.tool(
    "health_check",
    "Pre-flight diagnostic for the connected ComfyUI: one call that aggregates the signals an agent should check before dispatching a batch. Reports ComfyUI version/Python/PyTorch, GPU name + VRAM free/total, system RAM free, queue depth (running + pending), per-category /models populations (catches empty dropdowns from a misconfigured extra_model_paths.yaml), and recent errors from /internal/logs. Read-only — no mutation. Use this when a job fails for an unexpected reason, before a long batch run, or to confirm a remote ComfyUI is healthy. Originally contributed by github.com/joaolvivas.",
    {
      model_categories: z
        .array(z.string())
        .optional()
        .describe(
          "Override the model categories to poll (defaults to checkpoints, diffusion_models, loras, vae, text_encoders, controlnet).",
        ),
      recent_errors: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe(
          "How many recent error/traceback lines to include from /internal/logs (default 20, max 200).",
        ),
    },
    async (args) => {
      try {
        const text = await runHealthCheck({
          modelCategories: args.model_categories,
          recentErrors: args.recent_errors,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
