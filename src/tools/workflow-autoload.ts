import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  discoverWorkflows,
  buildToolSchema,
  applyParams,
  getWorkflowsDir,
  type DiscoveredWorkflow,
} from "../services/workflow-autoload.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Discover workflow JSON files in COMFYUI_WORKFLOWS_DIR (default
 * `~/.comfyui-mcp/workflows`) and register each as its own MCP tool with a
 * schema derived from its PARAM_* placeholders. Failures are logged and do
 * not abort startup.
 */
export async function registerAutoloadedWorkflows(server: McpServer): Promise<void> {
  const dir = getWorkflowsDir();
  let discovered: DiscoveredWorkflow[];
  try {
    discovered = await discoverWorkflows(dir);
  } catch (err) {
    logger.warn("Workflow autoload discovery failed", {
      dir,
      error: err instanceof Error ? err.message : err,
    });
    return;
  }

  if (discovered.length === 0) {
    logger.info("No autoloaded workflows discovered", { dir });
    return;
  }

  for (const wf of discovered) {
    const shape = buildToolSchema(wf.placeholders);
    const paramSummary = wf.placeholders
      .map((p) => `${p.name}:${p.type}`)
      .filter((s, i, a) => a.indexOf(s) === i)
      .join(", ");
    const description =
      `Run the autoloaded workflow "${wf.toolName}" (from ${wf.filePath}). ` +
      `Params: ${paramSummary || "(none)"}`;

    server.tool(wf.toolName, description, shape, async (args) => {
      try {
        const built = applyParams(wf.workflow, wf.placeholders, args as Record<string, unknown>);
        const result = await enqueueWorkflow(built);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: wf.toolName,
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
    });
    logger.info("Registered autoloaded workflow tool", {
      tool: wf.toolName,
      params: wf.placeholders.length,
    });
  }
}
