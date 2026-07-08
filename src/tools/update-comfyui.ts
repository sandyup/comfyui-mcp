import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  updateComfyUICore,
  updateAll,
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
    "Update ComfyUI core AND all installed custom nodes. Core is updated via subprocess (git pull + pip/uv) against the local install; custom nodes are updated via the ComfyUI-Manager HTTP API (queues update_all then starts the queue worker). Node updates run asynchronously and may require a ComfyUI restart afterward.",
    {},
    async () => {
      try {
        const result = await updateAll();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
