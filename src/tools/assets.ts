import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry, applyOverrides } from "../services/asset-registry.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { viewAssetImage } from "../services/view-image.js";
import { errorToToolResult } from "../utils/errors.js";

function summarizeRecord(record: ReturnType<typeof AssetRegistry.get>) {
  if (!record) return null;
  return {
    asset_id: record.assetId,
    prompt_id: record.promptId,
    node_id: record.nodeId,
    filename: record.filename,
    subfolder: record.subfolder,
    type: record.type,
    url: record.url,
    created_at: new Date(record.createdAt).toISOString(),
  };
}

export function registerAssetTools(server: McpServer): void {
  server.tool(
    "view_image",
    "Fetch a registered asset's bytes and return them as an inline image so the agent can see the result. Use this after enqueue_workflow completes (asset_id is included in the completion notification) to inspect, critique, or compare generated images. Only supports image mime types (PNG/JPEG/WebP); audio/video assets must be saved to disk via get_image.",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
    },
    async ({ asset_id }) => {
      try {
        const result = await viewAssetImage(asset_id);
        return {
          content: result.content.map((block) =>
            block.type === "image"
              ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
              : { type: "text" as const, text: block.text },
          ),
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_assets",
    "List recently generated assets from the in-memory registry, newest-first. Assets are registered automatically when a workflow completes successfully. The registry is ephemeral and clears on server restart; records expire after COMFYUI_ASSET_TTL_HOURS (default 24h).",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max records to return (default: all)"),
      since: z
        .string()
        .datetime()
        .optional()
        .describe("ISO timestamp — only return assets created at or after this time"),
    },
    async (args) => {
      try {
        const since = args.since ? Date.parse(args.since) : undefined;
        const records = AssetRegistry.list({ limit: args.limit, since });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: records.length, assets: records.map(summarizeRecord) },
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

  server.tool(
    "get_asset_metadata",
    "Get full provenance for a registered asset including the workflow snapshot that produced it. Use this to inspect the parameters that generated an image before calling regenerate with overrides.",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
    },
    async ({ asset_id }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...summarizeRecord(record),
                  workflow: record.workflow,
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

  server.tool(
    "regenerate",
    "Re-enqueue the workflow that produced an existing asset, optionally applying parameter overrides. Overrides are applied to any node input matching the key name (e.g. cfg, steps, sampler_name, scheduler, seed, denoise, text). Seeds are re-randomized by default so each regenerate yields a fresh image unless seed is explicitly passed in overrides.",
    {
      asset_id: z.string().describe("Asset id of the source generation"),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Map of input-name → new value applied to every node that already has that input. " +
            "Common keys: cfg, steps, sampler_name, scheduler, seed, denoise, text.",
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe(
          "If true, do not randomize seed fields. Combine with `overrides.seed` to reproduce the exact original image.",
        ),
    },
    async ({ asset_id, overrides, disable_random_seed }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        const next = applyOverrides(record.workflow, overrides);
        const result = await enqueueWorkflow(next, { disable_random_seed });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  source_asset_id: asset_id,
                  overrides_applied: overrides ?? {},
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
