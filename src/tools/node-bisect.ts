import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  bisectStart,
  bisectGood,
  bisectBad,
  bisectReset,
  bisectStatus,
} from "../services/node-bisect.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerNodeBisectTools(server: McpServer): void {
  server.tool(
    "bisect_start",
    "Begin a binary-search (bisect) session over installed ComfyUI custom nodes to find which one causes a problem. Enables half the nodes and disables the rest for the first test round, then guide the search with bisect_good / bisect_bad. Prefers the ComfyUI-Manager HTTP API; falls back to toggling .disabled directory suffixes for local installs. A ComfyUI restart may be needed for changes to take effect.",
    {},
    async () => {
      try {
        const result = await bisectStart();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "bisect_good",
    "Mark the currently enabled set of custom nodes as GOOD (the problem is absent with this set). Narrows the bisection to the disabled candidates and enables the next subset to test. Resolves and reports the culprit when one node remains.",
    {},
    async () => {
      try {
        const result = await bisectGood();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "bisect_bad",
    "Mark the currently enabled set of custom nodes as BAD (the problem is present with this set). Narrows the bisection to the enabled subset and enables the next subset to test. Resolves and reports the culprit when one node remains.",
    {},
    async () => {
      try {
        const result = await bisectBad();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "bisect_reset",
    "Re-enable all custom nodes and clear the current bisect session. Use this to abort a bisection or restore the installation after the search completes.",
    {},
    async () => {
      try {
        const result = await bisectReset();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "bisect_status",
    "Report the current bisect session state: status (idle/running/resolved), the remaining candidate node set, which nodes are enabled this round, and the identified culprit if resolved.",
    {},
    async () => {
      try {
        const result = bisectStatus();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
