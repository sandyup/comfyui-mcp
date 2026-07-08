// In-process MCP server that gives the orchestrator's background agent LIVE
// control of the workflow the user is actually looking at.
//
// The panel pack already implements a fixed allowlist of graph executors
// (graph_get_state, graph_add_node, graph_set_widget, graph_run, …) for the
// interactive --channels path. This server exposes those same operations to the
// background agent as MCP tools, each forwarding to the panel over the bridge
// the orchestrator owns (bridge.send → rid-correlated reply). Because it runs
// IN the orchestrator process (createSdkMcpServer, not a stdio subprocess), the
// tools can reach the live UiBridge directly.
//
// Each agent gets its own server bound to its tab id, so commands always target
// the workflow in that browser tab — no tab_id juggling for the model.

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { UiBridge } from "../services/ui-bridge.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const slotRef = z.union([z.string(), z.number().int().min(0)]);

/**
 * Build the per-tab live-graph MCP server. `tabId` binds every command to the
 * panel tab this agent serves.
 */
export function createPanelMcpServer(
  bridge: UiBridge,
  tabId: string,
): McpSdkServerConfigWithInstance {
  // Forward a command to the panel and wrap the reply as a tool result.
  const call = async (cmd: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> => {
    try {
      return ok(await bridge.send(cmd as { cmd: string }, { tabId, timeoutMs }));
    } catch (err) {
      return fail(err);
    }
  };

  return createSdkMcpServer({
    name: "comfyui-panel",
    version: "1.0.0",
    tools: [
      tool(
        "panel_get_graph",
        "Read the workflow the user is CURRENTLY VIEWING on their canvas (root graph or an opened subgraph — 'viewing' says which): node ids, types, titles, widget values, and connections. Subgraph nodes are summarized shallowly — drill in with panel_get_subgraph. ALWAYS call this before your first edit so ids and slot names are accurate. This is the user's live graph — they watch your edits happen. Read-only.",
        {},
        async () => call({ cmd: "graph_get_state" }),
      ),
      tool(
        "panel_get_subgraph",
        "Read INSIDE a subgraph node on the user's open graph: ids, types, widget values, and connections of its inner nodes. Use after panel_get_graph shows a node with is_subgraph=true. Read-only.",
        { node_id: z.number().int().describe("Subgraph node id (is_subgraph=true).") },
        async (args) => call({ cmd: "graph_get_subgraph", node_id: args.node_id }),
      ),
      tool(
        "panel_add_node",
        "Add a node to the user's OPEN ComfyUI graph by class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). The user sees it appear live; Ctrl+Z undoes it. Returns the created node's id, slots, and default widget values.",
        {
          class_type: z.string().describe("Exact ComfyUI node class_type to create."),
          pos: z
            .tuple([z.number(), z.number()])
            .optional()
            .describe("Canvas [x, y]. Auto-placed beside existing nodes when omitted."),
          title: z.string().optional().describe("Optional custom node title."),
        },
        async (args) =>
          call({ cmd: "graph_add_node", class_type: args.class_type, pos: args.pos, title: args.title }),
      ),
      tool(
        "panel_remove_node",
        "Remove a node (and its connections) from the user's open graph by id. Undoable with Ctrl+Z.",
        { node_id: z.number().int().describe("Node id from panel_get_graph.") },
        async (args) => call({ cmd: "graph_remove_node", node_id: args.node_id }),
      ),
      tool(
        "panel_clear",
        "Remove EVERY node from the user's open graph in one step — use when they ask to clear/reset the canvas. The whole wipe is a single Ctrl+Z undo.",
        {},
        async () => call({ cmd: "graph_clear" }),
      ),
      tool(
        "panel_connect",
        "Connect an output slot of one node to an input slot of another in the user's open graph. Slots accept a name ('MODEL', 'samples') or numeric index. On a name mismatch the error lists available slots — re-check with panel_get_graph. Undoable.",
        {
          from_node_id: z.number().int().describe("Source node id."),
          from_output: slotRef.optional().describe("Source output slot name or index (default 0)."),
          to_node_id: z.number().int().describe("Target node id."),
          to_input: slotRef.optional().describe("Target input slot name or index (default 0)."),
        },
        async (args) =>
          call({
            cmd: "graph_connect",
            from_node_id: args.from_node_id,
            from_output: args.from_output,
            to_node_id: args.to_node_id,
            to_input: args.to_input,
          }),
      ),
      tool(
        "panel_disconnect",
        "Disconnect an input slot of a node in the user's open graph. Undoable with Ctrl+Z.",
        {
          node_id: z.number().int().describe("Node id whose input to disconnect."),
          input: slotRef.optional().describe("Input slot name or index (default 0)."),
        },
        async (args) => call({ cmd: "graph_disconnect", node_id: args.node_id, input: args.input }),
      ),
      tool(
        "panel_set_widget",
        "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value. Undoable with Ctrl+Z.",
        {
          node_id: z.number().int().describe("Node id from panel_get_graph."),
          widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
          value: z
            .union([z.string(), z.number(), z.boolean()])
            .describe("New value. Must match the widget's expected type."),
        },
        async (args) =>
          call({ cmd: "graph_set_widget", node_id: args.node_id, widget: args.widget, value: args.value }),
      ),
      tool(
        "panel_move_node",
        "Move a node to a new canvas position [x, y] in the user's open graph. Undoable.",
        {
          node_id: z.number().int().describe("Node id from panel_get_graph."),
          pos: z.tuple([z.number(), z.number()]).describe("New canvas [x, y]."),
        },
        async (args) => call({ cmd: "graph_move_node", node_id: args.node_id, pos: args.pos }),
      ),
      tool(
        "panel_canvas",
        "Control the user's canvas view: 'fit' frames the whole graph, 'center_on_node' jumps to a node (give node_id), 'pan' shifts by dx/dy, 'zoom' sets an absolute scale. View-only.",
        {
          action: z.enum(["fit", "center_on_node", "pan", "zoom"]),
          node_id: z.number().int().optional().describe("Required for center_on_node."),
          dx: z.number().optional().describe("Pan delta x."),
          dy: z.number().optional().describe("Pan delta y."),
          scale: z.number().optional().describe("Absolute zoom for 'zoom' (0.05–4, 1 = 100%)."),
        },
        async (args) =>
          call({
            cmd: "graph_canvas",
            action: args.action,
            node_id: args.node_id,
            dx: args.dx,
            dy: args.dy,
            scale: args.scale,
          }),
      ),
      tool(
        "panel_run",
        "Queue the workflow the user has OPEN — exactly like them pressing Queue Prompt (current widget values, the live graph they can see). Returns queued:true, or queued:false with node_errors when frontend validation fails. Use this so the render runs on THEIR canvas and they see the result.",
        {
          batch_count: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("Times to queue (default 1)."),
        },
        async (args) => call({ cmd: "graph_run", batch_count: args.batch_count }, 20000),
      ),
      tool(
        "panel_get_errors",
        "Read the most recent execution error and per-node validation errors from the user's open ComfyUI tab. Check this when a run fails or after panel_run reports node_errors. Read-only.",
        {},
        async () => call({ cmd: "graph_get_errors" }),
      ),
      tool(
        "panel_save_workflow",
        "Save the user's open workflow. Without a name: same as Ctrl+S. With a name: saves a copy to workflows/<name>.json (duplicate).",
        { name: z.string().optional().describe("Save-as/duplicate name (no .json needed). Omit for plain save.") },
        async (args) =>
          args.name
            ? call({ cmd: "workflow_save_as", name: args.name }, 15000)
            : call({ cmd: "workflow_save" }, 15000),
      ),
      tool(
        "panel_list_workflows",
        "List the user's OPEN workflow tabs and which one is active (path, filename, modified, persisted). Use this to know what's open before switching/renaming/closing. Read-only.",
        {},
        async () => call({ cmd: "workflow_list" }),
      ),
      tool(
        "panel_new_workflow",
        "Open a brand-new BLANK workflow in a NEW TAB. Use this whenever the user wants a 'new workflow' / 'fresh canvas' / 'start over for a new project'. This does NOT touch their current workflow — it opens a separate tab. NEVER use panel_clear for a new workflow (panel_clear wipes the CURRENT graph and is only for 'clear/reset this canvas').",
        {},
        async () => call({ cmd: "workflow_new" }, 15000),
      ),
      tool(
        "panel_open_workflow",
        "Open / switch to a workflow by path or filename (from panel_list_workflows). Switches the active tab to it.",
        { path: z.string().describe("Workflow path, filename, or key from panel_list_workflows.") },
        async (args) => call({ cmd: "workflow_open", path: args.path }, 15000),
      ),
      tool(
        "panel_rename_workflow",
        "Rename a workflow (the active one, or the one matching `path`).",
        {
          name: z.string().describe("New name (no .json needed)."),
          path: z.string().optional().describe("Which workflow to rename; omit for the active one."),
        },
        async (args) => call({ cmd: "workflow_rename", name: args.name, path: args.path }, 15000),
      ),
      tool(
        "panel_close_workflow",
        "Close a workflow tab (the active one, or the one matching `path`). Refuses if it has unsaved changes unless force:true — save first to avoid losing the user's work.",
        {
          path: z.string().optional().describe("Which workflow to close; omit for the active one."),
          force: z.boolean().optional().describe("Close even with unsaved changes (discards them). Default false."),
        },
        async (args) => call({ cmd: "workflow_close", path: args.path, force: args.force }, 15000),
      ),
      tool(
        "panel_select_nodes",
        "Select nodes on the user's canvas by id (highlights them, sets the multi-selection). Useful before panel_create_subgraph.",
        { node_ids: z.array(z.number().int()).describe("Node ids to select.") },
        async (args) => call({ cmd: "graph_select_nodes", node_ids: args.node_ids }),
      ),
      tool(
        "panel_create_subgraph",
        "Group the given nodes into a SUBGRAPH (ComfyUI 'Convert to Subgraph') on the user's canvas — collapses them into one subgraph node. Returns the new subgraph node id. Undoable with Ctrl+Z.",
        { node_ids: z.array(z.number().int()).describe("Node ids to group into a subgraph.") },
        async (args) => call({ cmd: "graph_create_subgraph", node_ids: args.node_ids }, 15000),
      ),
      tool(
        "panel_search_nodes",
        "Search installable custom-node packs via the user's BUILT-IN ComfyUI Manager (the same source the Manager UI uses). Returns matching packs {id, title, description}. Use the `id` with panel_install_node. Prefer this over the headless search_custom_nodes tool — it works against the user's actual (Desktop) Manager.",
        { query: z.string().describe("Search text, e.g. 'kjnodes', 'controlnet', 'ipadapter'."), limit: z.number().int().min(1).max(40).optional() },
        async (args) => call({ cmd: "nodes_search", query: args.query, limit: args.limit }, 20000),
      ),
      tool(
        "panel_list_nodes",
        "List the custom-node packs currently installed in the user's ComfyUI (via the built-in Manager). Read-only.",
        {},
        async () => call({ cmd: "nodes_list" }, 20000),
      ),
      tool(
        "panel_install_node",
        "Install a custom-node pack into the user's ComfyUI via the BUILT-IN Manager (queues the install). Pass `id` (registry id like 'comfyui-kjnodes' or 'author/repo') from panel_search_nodes, or `repository` (git URL) for a nightly install. A ComfyUI restart (panel_restart_comfyui) is usually required afterward to load the nodes — poll panel_node_queue_status first. Prefer this over the headless install_custom_node tool.",
        {
          id: z.string().optional().describe("Registry id or 'author/repo'."),
          repository: z.string().optional().describe("Git URL (for a nightly/from-source install)."),
          version: z.string().optional().describe("Specific version; default 'latest' (or 'nightly' with repository)."),
          channel: z.string().optional().describe("Manager channel (default 'default')."),
          mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote')."),
        },
        async (args) =>
          call(
            { cmd: "nodes_install", id: args.id, repository: args.repository, version: args.version, channel: args.channel, mode: args.mode },
            30000,
          ),
      ),
      tool(
        "panel_node_queue_status",
        "Check the built-in Manager's install/update queue status (to see if a queued install finished). Read-only.",
        {},
        async () => call({ cmd: "nodes_queue_status" }, 20000),
      ),
      tool(
        "panel_restart_comfyui",
        "Restart the user's ComfyUI server via the built-in Manager — needed to load newly installed custom nodes. ComfyUI (and this agent) go down briefly; the panel auto-reconnects and you resume afterward. Tell the user you're restarting before calling. Only call when a restart is actually needed (e.g. right after installing nodes).",
        {},
        async () => call({ cmd: "comfy_reboot" }, 15000),
      ),
    ],
  });
}
