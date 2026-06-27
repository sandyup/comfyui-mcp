import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeColor } from "../services/color-analysis.js";
import { errorToToolResult } from "../utils/errors.js";

const analyzeColorSchema = {
  asset_id: z
    .string()
    .optional()
    .describe("Registered asset id from a completed job. Provide one source: asset_id, filename, or path."),
  filename: z
    .string()
    .optional()
    .describe("A ComfyUI output ref filename (pair with subfolder/type). Provide one source: asset_id, filename, or path."),
  subfolder: z
    .string()
    .optional()
    .describe("Subfolder for the output ref (default empty)."),
  type: z
    .enum(["output", "input", "temp"])
    .optional()
    .describe("ComfyUI dir for the output ref (default 'output')."),
  path: z
    .string()
    .optional()
    .describe("Absolute image path, or a path under the ComfyUI output dir. Provide one source: asset_id, filename, or path. (Videos: extract a frame to PNG first.)"),
  reference_path: z
    .string()
    .optional()
    .describe("Optional reference image to shot-match against; returns target−reference deltas for contrast, black/white points, saturation, and per-channel means."),
  histogram: z
    .boolean()
    .optional()
    .describe("Also return an overlaid R/G/B/luma histogram PNG for visual confirmation (default false)."),
};

export function registerColorAnalysisTools(server: McpServer): void {
  server.tool(
    "analyze_color",
    "Measure the color of a rendered image (not by eye): returns black/white points, contrast (luma std), saturation, per-channel means + cast, and clipping — plus heuristic flags (washedOut, lowContrast, liftedBlacks, dimHighlights, lowSaturation, colorCast) and a one-line verdict. Source = asset_id, a ComfyUI output ref (filename/subfolder/type), or an image path. Pass reference_path to shot-match against a known-good frame (target−reference deltas). Set histogram:true to also get an overlaid R/G/B/luma histogram PNG. Use this to diagnose 'washed out' objectively and decide a color fix; for a video, extract a frame to PNG first.",
    analyzeColorSchema,
    async (args) => {
      try {
        const result = await analyzeColor(args);
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
