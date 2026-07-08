import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getWorkspace,
  setDefaultWorkspace,
  listWorkspaces,
  getEnvironment,
} from "../services/workspace-env.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerWorkspaceEnvTools(server: McpServer): void {
  server.tool(
    "get_workspace",
    "Report the active ComfyUI workspace (mirrors `comfy-cli which`): the local installation path being used (from COMFYUI_PATH or auto-detection), the source of that path, any persisted default workspace, and the resolved API target the MCP server talks to.",
    {},
    async () => {
      try {
        const info = await getWorkspace();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "set_default_workspace",
    "Persist a default ComfyUI workspace path to the MCP config file (mirrors `comfy-cli set-default`). The value is stored under the OS config dir (e.g. ~/.config/comfyui-mcp/workspace.json) and reported by get_workspace/list_workspaces. Does NOT change the live API target.",
    {
      path: z
        .string()
        .min(1)
        .describe("Absolute path to a ComfyUI installation directory to remember as the default workspace."),
    },
    async (args) => {
      try {
        const result = await setDefaultWorkspace(args.path);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_workspaces",
    "List known/auto-detected ComfyUI installations on this machine. Scans common install locations across macOS, Linux, and Windows and marks which one is active and which is the saved default.",
    {},
    async () => {
      try {
        const result = await listWorkspaces();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_environment",
    "Report ComfyUI environment info (mirrors `comfy-cli env`): the running instance details from /system_stats (OS, Python, ComfyUI version, GPU/VRAM — works for remote targets) plus local probes when a workspace path is available (Python version, git revision, ComfyUI-Manager version, and key pip packages like torch/CUDA). Degrades gracefully: local probes are omitted when no local path is configured or tools are unavailable.",
    {},
    async () => {
      try {
        const info = await getEnvironment();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
