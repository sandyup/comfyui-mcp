import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  getObjectInfo,
  backfillObjectInfo,
} from "../comfyui/client.js";
import {
  isUiFormat,
  convertUiToApi,
  collectNodeTypes,
} from "../services/workflow-converter.js";
import { validateWorkflow } from "../services/workflow-validator.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { applyOverrides } from "../services/asset-registry.js";
import { fetchWorkflowFromUrl } from "../services/workflow-url.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

/**
 * Detect a ComfyUI API-format prompt graph: a plain object whose values all look
 * like nodes ({ class_type, inputs }). Some shares wrap the graph as
 * `{ prompt: {...} }` (a raw /prompt request body) — `unwrapApiWorkflow` handles
 * that before this check.
 */
function isApiFormat(obj: unknown): obj is WorkflowJSON {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const values = Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "class_type" in (v as Record<string, unknown>),
  );
}

/** Unwrap `{ prompt: {...} }` /prompt-request bodies to the bare node graph. */
function unwrapApiWorkflow(json: unknown): unknown {
  if (
    json != null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "prompt" in (json as Record<string, unknown>) &&
    isApiFormat((json as Record<string, unknown>).prompt)
  ) {
    return (json as Record<string, unknown>).prompt;
  }
  return json;
}

/** Class-type fragments that identify the structurally important nodes. */
const KEY_NODE_PATTERNS =
  /(checkpoint|unet|diffusionmodel|sampler|saveimage|savevideo|vaedecode|cliptextencode|loraloader|controlnet)/i;

function summarizeWorkflow(workflow: WorkflowJSON): string {
  const histogram: Record<string, number> = {};
  const keyNodes: string[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    const t = node.class_type ?? "?";
    histogram[t] = (histogram[t] ?? 0) + 1;
    if (KEY_NODE_PATTERNS.test(t)) keyNodes.push(`${id}:${t}`);
  }
  const types = Object.entries(histogram)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${c}× ${t}`)
    .join(", ");
  const lines = [
    `Node count: ${Object.keys(workflow).length}`,
    `Node types: ${types}`,
  ];
  if (keyNodes.length > 0) {
    lines.push(`Key nodes: ${keyNodes.join(", ")}`);
  }
  return lines.join("\n");
}

export function registerWorkflowUrlTools(server: McpServer): void {
  server.tool(
    "run_workflow_url",
    "Read (and optionally execute) a shared ComfyUI workflow from a URL. " +
      "Fetches the workflow JSON, accepts API-format prompt graphs or UI-format exports " +
      "(UI is auto-converted via the same converter as get_workflow), validates it, and " +
      "summarizes it. Supports raw .json links and GitHub blob/raw URLs (blob is normalized " +
      "to raw); other share hosts that need a site API return a clear 'paste the raw JSON URL' " +
      "error. The fetch is bounded (http/https only, timeout + size cap, loopback/private/" +
      "metadata IPs rejected to prevent SSRF). " +
      "READ-ONLY unless run=true; when run=true it enqueues the workflow (applying optional " +
      "`inputs` overrides) and returns the prompt_id.",
    {
      url: z
        .string()
        .describe(
          "URL of the workflow JSON. Raw .json links and GitHub blob/raw URLs work directly.",
        ),
      run: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, enqueue the workflow for execution and return the prompt_id. " +
            "Default false: only fetch, validate, and summarize (read-only).",
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Optional parameter overrides applied (only when run=true) to every node that " +
            "already has a matching input name. Common keys: cfg, steps, sampler_name, seed, text.",
        ),
    },
    async ({ url, run, inputs }) => {
      try {
        const { json, finalUrl } = await fetchWorkflowFromUrl(url);

        // Resolve to an API-format graph: convert UI exports, unwrap /prompt bodies.
        let workflow: WorkflowJSON;
        const warnings: string[] = [];
        if (isUiFormat(json)) {
          const bulk = await getObjectInfo();
          const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(json));
          const converted = convertUiToApi(json, objectInfo);
          workflow = converted.workflow;
          warnings.push(...converted.warnings);
        } else {
          const candidate = unwrapApiWorkflow(json);
          if (!isApiFormat(candidate)) {
            throw new ValidationError(
              "The URL returned JSON that is not a recognized ComfyUI workflow " +
                "(neither an API-format prompt graph of {class_type, inputs} nodes, " +
                "nor a UI-format export with nodes[]/links[]).",
            );
          }
          workflow = candidate;
        }

        if (Object.keys(workflow).length === 0) {
          throw new ValidationError("The workflow contains no nodes.");
        }

        // Validate (best-effort — never throws; reports 'cannot reach ComfyUI' as an issue).
        const validation = await validateWorkflow(workflow);

        if (!run) {
          const lines: string[] = [];
          lines.push(`# Workflow loaded from ${finalUrl}`);
          if (warnings.length > 0) {
            lines.push("");
            lines.push(`**Conversion warnings (${warnings.length}):**`);
            lines.push(...warnings.map((w) => `- ${w}`));
          }
          lines.push("");
          lines.push(summarizeWorkflow(workflow));
          lines.push("");
          lines.push(`Validation: ${validation.summary}`);
          for (const issue of validation.issues) {
            const loc = issue.node_id
              ? `${issue.node_id} (${issue.node_type})`
              : "workflow";
            lines.push(`- [${issue.severity}] ${loc}: ${issue.message}`);
          }
          lines.push("");
          lines.push("Re-call with run=true to enqueue this workflow.");
          return {
            content: [
              { type: "text" as const, text: lines.join("\n") },
              { type: "text" as const, text: JSON.stringify(workflow, null, 2) },
            ],
          };
        }

        // run=true → apply overrides and enqueue.
        const next = applyOverrides(workflow, inputs);
        const result = await enqueueWorkflow(next);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  source_url: finalUrl,
                  overrides_applied: inputs ?? {},
                  conversion_warnings: warnings,
                  validation: validation.summary,
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
