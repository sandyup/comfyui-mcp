import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerDefaultsTools(server: McpServer): void {
  server.tool(
    "get_defaults",
    "Return the merged view of generation defaults with per-source attribution. " +
      "Precedence (lowest → highest): config file → COMFYUI_DEFAULT_* env vars → runtime overrides via set_defaults. " +
      "Per-call MCP tool args always win over these defaults when consumed by a workflow-construction tool.",
    {},
    async () => {
      try {
        const resolved = DefaultsManager.getAll();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  config_path: DefaultsManager.getConfigPath(),
                  defaults: resolved,
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
    "set_defaults",
    "Update generation defaults. By default updates the in-memory runtime layer (lost on restart). " +
      "Pass persist=true to also write the change into the config file (~/.config/comfyui-mcp/config.json by default). " +
      "Use this to avoid repeating common values like width, height, steps, cfg, sampler, checkpoint.",
    {
      values: z
        .record(z.string(), z.any())
        .describe("Key/value map of defaults to set. Keys are typically lowercase (e.g. width, steps)."),
      persist: z
        .boolean()
        .optional()
        .describe("If true, write to the config file in addition to runtime."),
    },
    async ({ values, persist }) => {
      try {
        await DefaultsManager.set(values, { persist });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: persist ? "updated_runtime_and_config" : "updated_runtime",
                  config_path: DefaultsManager.getConfigPath(),
                  defaults: DefaultsManager.getAll(),
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
