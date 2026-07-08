// MCP tools that drive the user's live ComfyUI graph through the
// comfyui-mcp-panel sidebar pack, over the loopback WebSocket bridge
// (src/services/ui-bridge.ts). Registered only in --channels mode.
//
// You — the agent reading these tool descriptions — are the brain here: the
// user's chat messages from the panel arrive in your session, and these tools
// are your hands on their canvas. Every mutation is undoable with Ctrl+Z.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getUiBridge } from "../services/ui-bridge.js";
import { errorToToolResult, ComfyUIError } from "../utils/errors.js";

const slotRef = z.union([z.string(), z.number().int().min(0)]);

function bridge() {
  const b = getUiBridge();
  if (!b) {
    throw new ComfyUIError(
      "The panel bridge is not running. Start the server with --channels (or COMFYUI_MCP_CHANNELS=1).",
      "BRIDGE_NOT_RUNNING",
    );
  }
  return b;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerPanelTools(server: McpServer): void {
  server.tool(
    "panel_status",
    "Check whether the ComfyUI MCP Panel (the sidebar pack in the user's browser) is connected to this server's bridge. Call this before any other panel_* tool when a command fails — it distinguishes 'panel tab not open' from 'another comfyui-mcp session owns the port'. Read-only.",
    {},
    async () => {
      try {
        return textResult(bridge().status());
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_get_graph",
    "Read the user's currently-open ComfyUI graph through the sidebar panel: node ids, types, titles, widget values, and connections. ALWAYS call this before your first edit so node ids, widget names, and slot names are accurate. Requires the comfyui-mcp-panel pack connected (check panel_status). Read-only.",
    {},
    async () => {
      try {
        return textResult(await bridge().send({ cmd: "graph_get_state" }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_add_node",
    "Add a node to the user's open ComfyUI graph by class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). Returns the created node's id, slots, and default widget values. The user sees it appear live; Ctrl+Z undoes it. Requires the panel connected.",
    {
      class_type: z.string().describe("Exact ComfyUI node class_type to create."),
      pos: z
        .tuple([z.number(), z.number()])
        .optional()
        .describe("Canvas [x, y]. Auto-placed beside existing nodes when omitted."),
      title: z.string().optional().describe("Optional custom node title."),
    },
    async (args) => {
      try {
        return textResult(await bridge().send({ cmd: "graph_add_node", ...args }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_remove_node",
    "Remove a node (and its connections) from the user's open graph by id. Undoable with Ctrl+Z. Requires the panel connected.",
    {
      node_id: z.number().int().describe("Node id from panel_get_graph."),
    },
    async (args) => {
      try {
        return textResult(await bridge().send({ cmd: "graph_remove_node", ...args }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_connect",
    "Connect an output slot of one node to an input slot of another in the user's open graph. Slots accept a name ('MODEL', 'samples') or numeric index. On a name mismatch the error lists the available slots — re-check with panel_get_graph. Undoable with Ctrl+Z.",
    {
      from_node_id: z.number().int().describe("Source node id."),
      from_output: slotRef.optional().describe("Source output slot name or index (default 0)."),
      to_node_id: z.number().int().describe("Target node id."),
      to_input: slotRef.optional().describe("Target input slot name or index (default 0)."),
    },
    async (args) => {
      try {
        return textResult(await bridge().send({ cmd: "graph_connect", ...args }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_disconnect",
    "Disconnect an input slot of a node in the user's open graph. Undoable with Ctrl+Z. Requires the panel connected.",
    {
      node_id: z.number().int().describe("Node id whose input to disconnect."),
      input: slotRef.optional().describe("Input slot name or index (default 0)."),
    },
    async (args) => {
      try {
        return textResult(await bridge().send({ cmd: "graph_disconnect", ...args }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_set_widget",
    "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value. Undoable with Ctrl+Z. Requires the panel connected.",
    {
      node_id: z.number().int().describe("Node id from panel_get_graph."),
      widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe("New value. Must match the widget's expected type."),
    },
    async (args) => {
      try {
        return textResult(await bridge().send({ cmd: "graph_set_widget", ...args }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_say",
    "Post a message into the panel's chat feed in the user's ComfyUI sidebar. Use this to narrate what you changed, confirm completion, or ask the user a question — it's the ONLY way your words reach the panel UI. Supports plain text with simple markdown (bold, code).",
    {
      text: z.string().min(1).describe("The message to show in the panel chat feed."),
    },
    async (args) => {
      try {
        bridge().push({ type: "say", text: args.text });
        return textResult("delivered");
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_inbox",
    "Drain user messages typed into the panel chat since the last call. Returns an array of { text, ts }. Use when the user says they'll talk to you through the ComfyUI panel — poll this after each action, and reply with panel_say. (When channel notifications are enabled, new messages also arrive as session events and polling is unnecessary.)",
    {},
    async () => {
      try {
        bridge(); // throw early if no bridge
        return textResult(drainInbox());
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Panel → agent inbox. user_message frames land here (wired in index.ts);
// the agent drains them via panel_inbox, and — when the host supports it —
// also receives them pushed as `notifications/claude/channel` events.
// ---------------------------------------------------------------------------

const MAX_INBOX = 200;
const inbox: Array<{ text: string; ts: string }> = [];

export function enqueuePanelMessage(text: string): void {
  inbox.push({ text, ts: new Date().toISOString() });
  if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
}

export function drainInbox(): Array<{ text: string; ts: string }> {
  return inbox.splice(0, inbox.length);
}
