import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyManifest, manifestSchema } from "../services/manifest.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerManifestTools(server: McpServer): void {
  server.tool(
    "apply_manifest",
    "Apply a local ComfyUI setup manifest from an inline object or .json/.yaml/.yml file. LOCAL-ONLY: requires COMFYUI_PATH. Composes existing custom-node installs and model downloads, installs pip packages into the ComfyUI Python environment, and reports apt entries as skipped because system packages require manual/root installation.",
    {
      manifest: manifestSchema
        .optional()
        .describe(
          "Inline manifest object. Provide exactly one of `manifest` or `path`.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Path to a .json, .yaml, or .yml manifest file. Provide exactly one of `manifest` or `path`.",
        ),
    },
    async (args) => {
      try {
        const result = await applyManifest(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
