import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { convertImage } from "../services/image-convert.js";
import { errorToToolResult } from "../utils/errors.js";

const convertImageSchema = {
  asset_id: z
    .string()
    .optional()
    .describe("Registered asset id from a completed job. Provide exactly one of asset_id or path."),
  path: z
    .string()
    .optional()
    .describe("Path to a source image under COMFYUI_PATH/output. Provide exactly one of asset_id or path."),
  format: z
    .enum(["png", "jpeg", "webp"])
    .describe("Target encoded image format."),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Encoder quality, 1-100. Applies where supported by the selected format."),
  progressive: z
    .boolean()
    .optional()
    .describe("JPEG only: write a progressive JPEG."),
  lossless: z
    .boolean()
    .optional()
    .describe("WebP only: write lossless WebP."),
  effort: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe("WebP only: encoder effort, 0-6."),
  out_path: z
    .string()
    .optional()
    .describe("Optional output path under COMFYUI_PATH/output where the converted image should be written."),
};

export function registerImageConvertTools(server: McpServer): void {
  server.tool(
    "convert_image",
    "Re-encode a generated image to PNG, JPEG, or WebP and return it inline as an image content block. Source can be a registered asset_id or a path under the local ComfyUI output directory. Optionally writes the converted image back under the output directory and reports source/output size plus bytes saved.",
    convertImageSchema,
    async (args) => {
      try {
        const result = await convertImage(args);
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
}
