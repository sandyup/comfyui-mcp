import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyCustomNode } from "../services/node-verify.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerNodeVerifyTools(server: McpServer): void {
  server.tool(
    "verify_custom_node",
    "Test that a custom-node pack actually loads in ComfyUI — the middle step of " +
      "the author loop (scaffold_custom_node → verify_custom_node → publish_custom_node). " +
      "Restarts the local ComfyUI and waits for it to become ready, then checks that the " +
      "pack's node class_types appear in /object_info. A node that fails to import (a " +
      "missing dependency or a syntax error) simply never registers, so any missing " +
      "class_types pinpoint a broken pack. Provide class_types explicitly, or a pack " +
      "`name` whose __init__.py declares NODE_CLASS_MAPPINGS (the keys are inferred). " +
      "LOCAL-ONLY: needs COMFYUI_PATH and a managed local ComfyUI. Set restart:false to " +
      "check the already-running server without restarting it.",
    {
      name: z
        .string()
        .optional()
        .describe(
          "Pack folder under custom_nodes/. If class_types is omitted, its __init__.py NODE_CLASS_MAPPINGS keys are inferred and checked.",
        ),
      class_types: z
        .array(z.string())
        .optional()
        .describe(
          "Explicit NODE_CLASS_MAPPINGS keys to confirm are registered in /object_info. Takes precedence over inferring from `name`.",
        ),
      restart: z
        .boolean()
        .optional()
        .describe("Restart ComfyUI before checking so newly-added packs load (default true). Set false to check the live server as-is."),
    },
    async (args) => {
      try {
        const result = await verifyCustomNode({
          name: args.name,
          classTypes: args.class_types,
          restart: args.restart,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
