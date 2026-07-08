import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { uploadOutput, type UploadOutputOptions } from "../services/storage-upload.js";
import { errorToToolResult } from "../utils/errors.js";

const s3DestinationSchema = z.object({
  bucket: z.string().min(1).describe("Destination S3 bucket"),
  prefix: z.string().optional().describe("Optional object key prefix"),
  async: z.boolean().optional().describe("Accepted for API compatibility; uploads complete before the tool returns."),
});

const azureDestinationSchema = z.object({
  container: z.string().min(1).describe("Destination Azure Blob container"),
  blob_prefix: z.string().optional().describe("Optional blob name prefix"),
});

const httpDestinationSchema = z.object({
  url: z.string().url().describe("HTTP(S) URL to PUT the output file to"),
});

const hfDestinationSchema = z.object({
  repo: z.string().min(1).describe("HuggingFace repo in owner/name format"),
  repo_type: z.enum(["model", "dataset", "space"]).optional().describe("Repo type; defaults to model"),
  path: z.string().optional().describe("Optional path prefix inside the repo"),
});

const uploadOutputSchema = {
  asset_id: z
    .string()
    .optional()
    .describe("Registered asset id from a completed job. Provide exactly one of asset_id or path."),
  path: z
    .string()
    .optional()
    .describe("Path to a generated output under COMFYUI_PATH/output. Provide exactly one of asset_id or path."),
  destination: z
    .object({
      s3: s3DestinationSchema.optional(),
      azure: azureDestinationSchema.optional(),
      http: httpDestinationSchema.optional(),
      hf: hfDestinationSchema.optional(),
    })
    .describe("Exactly one upload destination."),
};

export function registerStorageUploadTools(server: McpServer): void {
  server.tool(
    "upload_output",
    "Upload a generated ComfyUI output to cloud storage. Source can be asset_id or a local path under COMFYUI_PATH/output. Destination can be S3, Azure Blob, HTTP PUT, or HuggingFace via the hf CLI.",
    uploadOutputSchema,
    async (args) => {
      try {
        const result = await uploadOutput(args as UploadOutputOptions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
