import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listApiNodes,
  getApiNodeSchema,
  generateWithApiNode,
} from "../services/api-nodes.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * MCP tools for hosted partner/API nodes (e.g. Flux/BFL, Ideogram, Kling,
 * Stability), mirroring `comfy-cli generate` (list / schema / run). These nodes
 * run on the connected ComfyUI server via its HTTP API, so they work against
 * remote servers too. See ../services/api-nodes.ts for mechanism + auth notes.
 */
export function registerApiNodesTools(server: McpServer): void {
  server.tool(
    "list_api_nodes",
    "List hosted partner/API nodes available on the connected ComfyUI (e.g. Flux/BFL, Ideogram, Kling, Stability). These call external image/video providers and run server-side, requiring a Comfy account/API key configured on the ComfyUI server. Returns an empty list if the server has no API nodes (or they are disabled).",
    {
      filter: z
        .string()
        .optional()
        .describe(
          'Case-insensitive substring to narrow results, matched against class_type, display name, or category (e.g. "image", "video", "kling").',
        ),
    },
    async (args) => {
      try {
        const nodes = await listApiNodes(args.filter);
        const text =
          nodes.length === 0
            ? JSON.stringify(
                {
                  count: 0,
                  nodes: [],
                  note: "No API/partner nodes found on the connected ComfyUI. They may not be installed, may be disabled (--disable-api-nodes), or the filter excluded them.",
                },
                null,
                2,
              )
            : JSON.stringify({ count: nodes.length, nodes }, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_api_node_schema",
    "Return the input schema for a specific API/partner node from the connected ComfyUI's /object_info. Lists visible inputs (with types/defaults/options), hidden inputs (server-filled auth), and outputs. Use list_api_nodes first to find a class_type.",
    {
      class_type: z
        .string()
        .describe('The node class_type, e.g. "FluxProImageNode" (from list_api_nodes).'),
    },
    async (args) => {
      try {
        const schema = await getApiNodeSchema(args.class_type);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(schema, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "generate_with_api_node",
    "Build a minimal single-node workflow that runs a chosen API/partner node with the provided inputs and enqueue it. Returns immediately with the prompt_id (use get_job_status / get_history for results). Do NOT pass auth credentials in inputs — the ComfyUI server injects those from its logged-in session. Use get_api_node_schema to discover valid inputs.",
    {
      class_type: z
        .string()
        .describe('The API node class_type to run (from list_api_nodes / get_api_node_schema).'),
      inputs: z
        .record(z.string(), z.any())
        .describe("Input values keyed by input name, per the node's schema."),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed/noise_seed inputs."),
    },
    async (args) => {
      try {
        const result = await generateWithApiNode({
          class_type: args.class_type,
          inputs: args.inputs,
          disable_random_seed: args.disable_random_seed,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  notes: result.notes,
                  workflow: result.workflow,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
