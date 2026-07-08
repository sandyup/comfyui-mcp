import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { workflowToDsl, dslToWorkflow } from "../services/workflow-dsl.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerWorkflowDslTools(server: McpServer): void {
  server.tool(
    "workflow_to_dsl",
    "Convert a ComfyUI API-format workflow into a compact, human/LLM-readable DSL — easier to read and edit than raw JSON, and round-trips losslessly back via dsl_to_workflow. Connections render as `key <- nodeId.outputIndex`, literals as `key = <JSON>`. (Experimental.)",
    {
      workflow: z
        .record(z.string(), z.any())
        .describe("ComfyUI workflow in API format (node ID -> {class_type, inputs})"),
    },
    async ({ workflow }) => {
      try {
        return { content: [{ type: "text" as const, text: workflowToDsl(workflow) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "dsl_to_workflow",
    "Convert the compact workflow DSL (see workflow_to_dsl) back into executable ComfyUI API-format JSON. Useful for authoring/editing workflows in the legible DSL, then converting to run with enqueue_workflow. (Experimental.)",
    {
      dsl: z.string().describe("Workflow DSL text"),
    },
    async ({ dsl }) => {
      try {
        const workflow = dslToWorkflow(dsl);
        return { content: [{ type: "text" as const, text: JSON.stringify(workflow, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
