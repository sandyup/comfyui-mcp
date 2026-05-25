import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  configureManager,
  MANAGER_CONFIG_ACTIONS,
} from "../services/manager-config.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerManagerConfigTools(server: McpServer): void {
  server.tool(
    "configure_manager",
    "Configure ComfyUI-Manager settings, mirroring `comfy-cli manager` subcommands. " +
      "Most actions use the ComfyUI-Manager HTTP API (works against remote ComfyUI); " +
      "set_network_mode and set_security_level have no HTTP setter and are written to " +
      "Manager's config.ini (requires a known local ComfyUI path; restart ComfyUI to apply).",
    {
      action: z
        .enum(MANAGER_CONFIG_ACTIONS)
        .describe(
          "Which setting to change. HTTP API: set_preview_method, set_db_mode, " +
            "set_component_policy, set_update_policy, set_channel, reset_queue. " +
            "config.ini fallback: set_network_mode, set_security_level.",
        ),
      value: z
        .string()
        .optional()
        .describe(
          "Value for the chosen action (omit only for reset_queue). Allowed values per action — " +
            "set_preview_method: auto | latent2rgb | taesd | none; " +
            "set_db_mode: local | cache | remote; " +
            "set_component_policy: workflow | higher | mine; " +
            "set_update_policy: stable-comfyui | nightly-comfyui; " +
            "set_channel: a channel name (e.g. default); " +
            "set_network_mode: public | private | offline; " +
            "set_security_level: strong | normal | normal- | weak. " +
            "HTTP-API actions take effect live; the config.ini actions " +
            "(set_network_mode, set_security_level) apply only after a ComfyUI restart.",
        ),
    },
    async (args) => {
      try {
        const result = await configureManager(args.action, args.value);
        const stateLine =
          result.state !== undefined ? `\nResulting state: ${result.state}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.message} (via ${result.via})${stateLine}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
