import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installComfyUI } from "../services/install-comfyui.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerInstallComfyUITools(server: McpServer): void {
  server.tool(
    "install_comfyui",
    "Install ComfyUI locally: git-clone it into a target directory, create a dedicated workspace " +
      "virtualenv (<target>/.venv), and install Python requirements INTO that venv (never the Python " +
      "running this MCP server) via pip or uv. ComfyUI-Manager is installed from manager_requirements.txt " +
      "when present, else git-cloned as a fallback. Mirrors `comfy-cli install`. LOCAL, subprocess-only " +
      "and independent of any remote --comfyui-url target; the target dir must be empty or non-existent " +
      "(an existing install is never overwritten). Runs SYNCHRONOUSLY and can take several minutes (large " +
      "git clone + full torch/dependency install); the call blocks until done. On success returns a JSON " +
      "report { installed, targetPath, venvPath, comfyuiUrl, managerInstalled, managerVia, version, " +
      "pythonInstaller, steps[] }. Does NOT start ComfyUI.",
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
          "ComfyUI version to install (comfy-cli semantics): \"nightly\" (default-branch HEAD), " +
            "\"latest\" (newest release tag), or a semantic version like \"0.3.40\" (checked out as " +
            "tag v0.3.40). Raw git refs/branches are rejected. Omit to track the default branch HEAD.",
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
