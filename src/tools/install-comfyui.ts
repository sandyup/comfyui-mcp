import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installComfyUI } from "../services/install-comfyui.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerInstallComfyUITools(server: McpServer): void {
  server.tool(
    "install_comfyui",
    "Install ComfyUI locally by cloning it (and optionally ComfyUI-Manager) via git into a target " +
      "directory, then installing Python requirements via pip or uv. Mirrors `comfy-cli install`. " +
      "This is a LOCAL, subprocess-only operation: it runs git + pip/uv on the machine hosting this " +
      "MCP server, independent of any remote --comfyui-url target. The target directory must be empty " +
      "or non-existent — an existing install is never overwritten.",
    {
      target_path: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the workspace directory to install ComfyUI into. Must be empty or non-existent.",
        ),
      skip_manager: z
        .boolean()
        .optional()
        .describe(
          "If true, do not clone/install ComfyUI-Manager. Default false (Manager is installed).",
        ),
      use_uv: z
        .boolean()
        .optional()
        .describe(
          "If true, prefer `uv pip install` over plain pip when uv is available on PATH. Falls back to pip if uv is missing. Default false.",
        ),
      version: z
        .string()
        .optional()
        .describe(
          "Optional ComfyUI git ref (tag, branch, or commit) to check out after cloning. Defaults to the repository's default branch HEAD.",
        ),
    },
    async (args) => {
      try {
        const result = installComfyUI({
          targetPath: args.target_path,
          skipManager: args.skip_manager,
          useUv: args.use_uv,
          version: args.version,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
