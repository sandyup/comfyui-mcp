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

// Multi-tab: every graph tool accepts an optional tab_id (full id or the
// 8-char prefix panel_status shows). Routing default when omitted:
// the only connected tab → the tab the user last typed in → error.
const tabIdParam = z
  .string()
  .optional()
  .describe(
    "Target panel tab (full id or 8-char prefix from panel_status). Optional when one tab is connected or the user recently typed in a tab.",
  );

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
    "List the ComfyUI Agent Panel tabs connected to this server's bridge — each browser tab holds its own connection with its own open workflow (id + workflow title shown). Call this before other panel_* tools when a command fails, and to get tab_ids when multiple ComfyUI tabs are open. Read-only.",
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
    "Read the graph the user is currently viewing (root graph or an opened subgraph — 'viewing' says which): node ids, types, titles, widget values, and connections. Subgraph nodes are summarized SHALLOWLY (boundary inputs/outputs/widgets + inner node count) — drill in with panel_get_subgraph. ALWAYS call this before your first edit so ids and slot names are accurate. Read-only.",
    { tab_id: tabIdParam },
    async (args) => {
      try {
        return textResult(
          await bridge().send({ cmd: "graph_get_state" }, { tabId: args.tab_id }),
        );
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
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_add_node", ...cmdArgs }, { tabId: tab_id }),
        );
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
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_remove_node", ...cmdArgs }, { tabId: tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_clear",
    "Remove EVERY node from the user's open ComfyUI graph in one step — use when the user asks to clear/reset/empty the canvas. The whole wipe is a single Ctrl+Z undo. Requires the panel connected.",
    { tab_id: tabIdParam },
    async (args) => {
      try {
        return textResult(
          await bridge().send({ cmd: "graph_clear" }, { tabId: args.tab_id }),
        );
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
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_connect", ...cmdArgs }, { tabId: tab_id }),
        );
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
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_disconnect", ...cmdArgs }, { tabId: tab_id }),
        );
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
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_set_widget", ...cmdArgs }, { tabId: tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_get_subgraph",
    "Read INSIDE a subgraph node: ids, types, widget values, and connections of its inner nodes. Use after panel_get_graph shows a node with is_subgraph=true and you need detail (e.g. to diagnose an error inside it). Read-only.",
    {
      node_id: z.number().int().describe("Subgraph node id (is_subgraph=true in panel_get_graph)."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_get_subgraph", ...cmdArgs }, { tabId: tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_move_node",
    "Move a node to a new canvas position [x, y] in the user's open graph. Undoable with Ctrl+Z. Use panel_get_graph first for current ids.",
    {
      node_id: z.number().int().describe("Node id from panel_get_graph."),
      pos: z.tuple([z.number(), z.number()]).describe("New canvas [x, y]."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_move_node", ...cmdArgs }, { tabId: tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_canvas",
    "Control the user's canvas view: 'fit' frames the whole graph, 'center_on_node' jumps to a node (give node_id), 'pan' shifts by dx/dy graph units, 'zoom' sets an absolute scale. View-only — does not change the graph.",
    {
      action: z.enum(["fit", "center_on_node", "pan", "zoom"]),
      node_id: z.number().int().optional().describe("Required for center_on_node."),
      dx: z.number().optional().describe("Pan delta x (graph units)."),
      dy: z.number().optional().describe("Pan delta y (graph units)."),
      scale: z.number().optional().describe("Absolute zoom for 'zoom' (0.05–4, 1 = 100%)."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_canvas", ...cmdArgs }, { tabId: tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_run",
    "Queue the workflow the user has OPEN (exactly like them pressing Queue Prompt — current widget values, live graph). Returns queued:true, or queued:false with node_errors when frontend validation fails — fix those and retry. For headless API-format workflows use enqueue_workflow instead.",
    {
      batch_count: z.number().int().min(1).max(100).optional().describe("Times to queue (default 1)."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const { tab_id, ...cmdArgs } = args;
        return textResult(
          await bridge().send({ cmd: "graph_run", ...cmdArgs }, { tabId: tab_id, timeoutMs: 20000 }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_get_errors",
    "Read the most recent execution error and per-node validation errors from the user's open ComfyUI tab. Check this when the user says their workflow failed, or after panel_run reports node_errors. Read-only.",
    { tab_id: tabIdParam },
    async (args) => {
      try {
        return textResult(
          await bridge().send({ cmd: "graph_get_errors" }, { tabId: args.tab_id }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_save_workflow",
    "Save the user's open workflow. Without a name: same as Ctrl+S (may open ComfyUI's save dialog for never-saved workflows). With a name: saves a copy to workflows/<name>.json — use this to DUPLICATE the current workflow.",
    {
      name: z
        .string()
        .optional()
        .describe("Save-as/duplicate target name (no .json needed). Omit for plain save."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const cmd = args.name
          ? { cmd: "workflow_save_as" as const, name: args.name }
          : { cmd: "workflow_save" as const };
        return textResult(await bridge().send(cmd, { tabId: args.tab_id, timeoutMs: 15000 }));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_say",
    "Post a message into the panel's chat feed in the user's ComfyUI sidebar. Use this to narrate what you changed, confirm completion, or ask the user a question — it's the ONLY way your words reach the panel UI. Broadcasts to every connected tab unless tab_id targets one. Supports plain text with simple markdown (bold, code).",
    {
      text: z.string().min(1).describe("The message to show in the panel chat feed."),
      tab_id: tabIdParam,
    },
    async (args) => {
      try {
        const n = bridge().push({ type: "say", text: args.text }, args.tab_id);
        return textResult(`delivered to ${n} tab(s)`);
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "panel_inbox",
    "Drain user messages typed into the panel chat since the last call. Returns an array of { text, ts, tab_id, title } — title is the workflow open in the tab the user typed in. Use when the user says they'll talk to you through the ComfyUI panel — poll this after each action, and reply with panel_say. (When channel notifications are enabled, new messages also arrive as session events and polling is unnecessary.)",
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
interface InboxEntry {
  text: string;
  ts: string;
  tab_id?: string;
  title?: string;
  subgraph?: string;
}
const inbox: InboxEntry[] = [];

export function enqueuePanelMessage(
  text: string,
  meta: { tab_id?: string; title?: string; subgraph?: string } = {},
): void {
  inbox.push({ text, ts: new Date().toISOString(), ...meta });
  if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
}

export function drainInbox(): InboxEntry[] {
  return inbox.splice(0, inbox.length);
}
