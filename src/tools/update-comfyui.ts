import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  updateComfyUICore,
  updateAllCustomNodes,
} from "../services/update-comfyui.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerUpdateComfyUITools(server: McpServer): void {
  server.tool(
    "update_comfyui",
    "Update the ComfyUI core install: runs `git pull` in the configured ComfyUI directory and reinstalls its Python requirements (auto-detecting uv vs pip). Requires a local install (COMFYUI_PATH); returns a clear error when targeting a remote instance via --comfyui-url.",
    {},
    async () => {
      try {
        const result = await updateComfyUICore();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "update_all",
    "Update ALL installed custom nodes via the ComfyUI-Manager HTTP API (queues update_all, then starts the queue worker). Mirrors `comfy-cli update all`. This does NOT update ComfyUI core — use update_comfyui for that. Works against the connected instance (local or remote); updates run asynchronously and a ComfyUI restart may be required afterward.",
    {},
    async () => {
      try {
        const result = await updateAllCustomNodes();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
