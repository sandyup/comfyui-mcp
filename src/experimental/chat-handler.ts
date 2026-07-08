import type {
  LanguageModel,
  ToolSet,
  UIMessage,
} from "ai";
import { z } from "zod";

import { resolveModel } from "./provider-registry.js";
import { requireOptionalDep } from "../utils/optional-dep.js";

// ---------------------------------------------------------------------------
// Experimental AI SDK chat handler for the embedded-agent-panel POC.
//
// `POST /api/chat` -> streamText({ model, messages, tools }).toUIMessageStreamResponse()
//
// Includes ONE server-side tool end-to-end (`generate_image`) which, for the
// POC, returns a stub result. Wiring the real comfyui-mcp generate tools is a
// later phase (see design/embedded-agent-panel.md, build order step 5).
//
// This module is only reached behind COMFYUI_MCP_AGENT_POC. `ai` is an
// optional dependency, so we build the tool registry lazily — a slim install
// without `ai` still imports this module without crashing; the optional-dep
// error only surfaces when handleChatRequest() is actually called.
// ---------------------------------------------------------------------------

type AiModule = typeof import("ai");

async function loadAi(): Promise<AiModule> {
  return requireOptionalDep<AiModule>("ai", {
    feature: "embedded-agent-panel POC",
    installHint: "npm install ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai",
  });
}

export function buildTools(toolFn: AiModule["tool"]): ToolSet {
  // A slot is addressable by name ("MODEL", "samples") or numeric index.
  const slotRef = z.union([z.string(), z.number().int().min(0)]);

  return {
    generate_image: toolFn({
      description:
        "Generate an image from a text prompt using ComfyUI. (POC stub — returns a placeholder result instead of running a real workflow.)",
      inputSchema: z.object({
        prompt: z.string().describe("The text prompt to generate an image from."),
        width: z.number().int().positive().optional().describe("Image width in pixels."),
        height: z.number().int().positive().optional().describe("Image height in pixels."),
      }),
      execute: async ({ prompt, width, height }) => {
        // POC stub: real implementation will enqueue a ComfyUI workflow and
        // return the resulting asset id / image URL.
        return {
          status: "stubbed",
          prompt,
          width: width ?? 1024,
          height: height ?? 1024,
          imageUrl: "https://example.invalid/poc-placeholder.png",
          note: "Placeholder result from the POC. No real workflow was executed.",
        };
      },
    }),

    // ── Client-side graph tools ──────────────────────────────────────────
    // No `execute` on any of these: the AI SDK forwards the call to the
    // client (the sidebar panel running inside ComfyUI), the stream pauses,
    // and the panel executes against the live LiteGraph graph and re-POSTs
    // the conversation with the tool result appended. See
    // comfyui-mcp-panel's web/js/comfyui-mcp-panel.js for the executors.
    graph_get_state: toolFn({
      description:
        "Read the user's currently-open ComfyUI graph: node ids, types, titles, widget values, and connections. ALWAYS call this before editing so node ids and slot names are accurate. Read-only.",
      inputSchema: z.object({}),
    }),
    graph_add_node: toolFn({
      description:
        "Add a node to the open ComfyUI graph by its class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). Returns the created node's id, slots, and default widget values. Undoable with Ctrl+Z.",
      inputSchema: z.object({
        class_type: z.string().describe("Exact ComfyUI node class_type to create."),
        pos: z
          .tuple([z.number(), z.number()])
          .optional()
          .describe("Canvas [x, y] position. Auto-placed beside existing nodes when omitted."),
        title: z.string().optional().describe("Optional custom node title."),
      }),
    }),
    graph_remove_node: toolFn({
      description:
        "Remove a node (and its connections) from the open graph by id. Undoable with Ctrl+Z.",
      inputSchema: z.object({
        node_id: z.number().int().describe("Node id from graph_get_state."),
      }),
    }),
    graph_connect: toolFn({
      description:
        "Connect an output slot of one node to an input slot of another in the open graph. Slots accept a name ('MODEL', 'samples') or numeric index. Fails with the list of available slots when a name doesn't match — re-check with graph_get_state.",
      inputSchema: z.object({
        from_node_id: z.number().int().describe("Source node id."),
        from_output: slotRef.optional().describe("Source output slot name or index (default 0)."),
        to_node_id: z.number().int().describe("Target node id."),
        to_input: slotRef.optional().describe("Target input slot name or index (default 0)."),
      }),
    }),
    graph_disconnect: toolFn({
      description: "Disconnect an input slot of a node in the open graph. Undoable with Ctrl+Z.",
      inputSchema: z.object({
        node_id: z.number().int().describe("Node id whose input to disconnect."),
        input: slotRef.optional().describe("Input slot name or index (default 0)."),
      }),
    }),
    graph_set_widget: toolFn({
      description:
        "Set a widget value on a node in the open graph (e.g. steps, cfg, seed, ckpt_name, text prompts). Returns the previous and new value. Undoable with Ctrl+Z.",
      inputSchema: z.object({
        node_id: z.number().int().describe("Node id from graph_get_state."),
        widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe("New value. Must match the widget's expected type."),
      }),
    }),
  } satisfies ToolSet;
}

export interface ChatHandlerOptions {
  /** Override the model (mainly for tests). Defaults to the provider registry. */
  model?: LanguageModel;
  /** Optional `provider:model` id forwarded to the registry. */
  modelId?: string;
  /** System prompt for the agent. */
  system?: string;
  /** Override the tool set (mainly for tests). Defaults to the POC tools. */
  tools?: ToolSet;
}

const DEFAULT_SYSTEM =
  "You are an assistant embedded in ComfyUI's sidebar. You can edit the user's " +
  "open graph live with the graph_* tools: ALWAYS call graph_get_state before " +
  "your first edit so node ids, widget names, and slot names are accurate. " +
  "Prefer small incremental edits over rebuilding the graph, and tell the user " +
  "what you changed (every edit is undoable with Ctrl+Z). You can also generate " +
  "images with the generate_image tool.";

/**
 * Handle a chat request. Accepts a Fetch-style `Request` whose JSON body is
 * `{ messages: UIMessage[], model?: string }` and returns a streaming
 * `Response` (UI message stream protocol).
 */
export async function handleChatRequest(
  req: Request,
  options: ChatHandlerOptions = {},
): Promise<Response> {
  const body = (await req.json()) as {
    messages?: UIMessage[];
    model?: string;
  };
  const messages = body.messages ?? [];

  const ai = await loadAi();
  const model =
    options.model ?? (await resolveModel(options.modelId ?? body.model));
  const tools = options.tools ?? buildTools(ai.tool);

  const result = ai.streamText({
    model,
    system: options.system ?? DEFAULT_SYSTEM,
    messages: await ai.convertToModelMessages(messages),
    tools,
    stopWhen: ai.stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
