import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addExtraPath,
  EXTRA_PATH_TARGETS,
  listExtraPaths,
  removeExtraPath,
} from "../services/extra-paths.js";
import { errorToToolResult } from "../utils/errors.js";

const targetSchema = z.enum(EXTRA_PATH_TARGETS);

const targetArgs = {
  target: targetSchema
    .optional()
    .describe(
      "Config target: auto chooses Desktop config if it exists, otherwise standalone; " +
        "standalone uses <COMFYUI_PATH>/extra_model_paths.yaml; desktop uses the OS app-data extra_models_config.yaml.",
    ),
  config_path: z
    .string()
    .optional()
    .describe("Explicit YAML config path override, mainly for advanced/manual installs."),
};

const mutationArgs = {
  ...targetArgs,
  group: z
    .string()
    .optional()
    .describe("Top-level YAML group to edit. Defaults to comfyui_mcp."),
  category: z
    .string()
    .min(1)
    .describe(
      "ComfyUI search-path category, e.g. checkpoints, loras, vae, diffusion_models, unet_gguf, or custom_nodes.",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "Directory path to add/remove for that category. Absolute paths are safest; relative paths are resolved by ComfyUI.",
    ),
};

export function registerExtraPathsTools(server: McpServer): void {
  server.tool(
    "list_extra_paths",
    "View ComfyUI extra search-path config for standalone/manual installs and ComfyUI Desktop. " +
      "Standalone uses <COMFYUI_PATH>/extra_model_paths.yaml; Desktop uses the OS app-data " +
      "extra_models_config.yaml. Reports generic categories, so model categories and custom_nodes " +
      "entries are both visible when present. Read-only.",
    targetArgs,
    async (args) => {
      try {
        const result = await listExtraPaths({
          target: args.target,
          configPath: args.config_path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "add_extra_path",
    "Add a directory to a ComfyUI extra search-path YAML config. Use this for " +
      "model categories such as checkpoints/loras/vae and, on ComfyUI builds that " +
      "support it, custom_nodes. Writes the config file and returns the updated view; restart ComfyUI to apply.",
    {
      ...mutationArgs,
      is_default: z
        .boolean()
        .optional()
        .describe("Set is_default on a newly-created group. Existing groups are not overwritten."),
    },
    async (args) => {
      try {
        const result = await addExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
          isDefault: args.is_default,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "remove_extra_path",
    "Remove a directory from a ComfyUI extra search-path YAML config. Matches the stored path exactly. " +
      "Restart ComfyUI after removing an active path.",
    mutationArgs,
    async (args) => {
      try {
        const result = await removeExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
