import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  uploadImage,
  extractWorkflowFromImage,
  listOutputImages,
  getOutputImage,
  uploadImageAuto,
} from "../services/image-management.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerImageManagementTools(server: McpServer): void {
  // ── get_image ────────────────────────────────────────────────────────────
  // Fetches a generated image from ComfyUI via HTTP /view.
  // Works with remote ComfyUI — no COMFYUI_PATH required.
  server.tool(
    "get_image",
    "Fetch a generated image from ComfyUI and return it as an inline image. " +
      "Works with remote ComfyUI instances — does not require COMFYUI_PATH. " +
      "Use get_history first to obtain the filename.",
    {
      filename: z
        .string()
        .describe("Output image filename, e.g. PulID_Klein_00001_.png"),
      type: z
        .enum(["output", "input", "temp"])
        .optional()
        .default("output")
        .describe("Image directory: output (default), input, or temp"),
      subfolder: z
        .string()
        .optional()
        .default("")
        .describe("Subfolder within the directory, if any"),
      save_dir: z
        .string()
        .optional()
        .describe(
          "Local directory to save the image file. Defaults to /tmp/comfyui-images/.",
        ),
    },
    async (args) => {
      try {
        const { base64, mimeType } = await getOutputImage(
          args.filename,
          args.type ?? "output",
          args.subfolder ?? "",
        );

        // Save to local file
        const saveDir = args.save_dir ?? process.cwd();
        await mkdir(saveDir, { recursive: true });
        const localFilename = basename(args.filename);
        const savePath = join(saveDir, localFilename);
        await writeFile(savePath, Buffer.from(base64, "base64"));

        return {
          content: [
            {
              type: "text" as const,
              text: `Saved to: ${savePath}`,
            },
            {
              type: "image" as const,
              data: base64,
              mimeType,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── upload_image ─────────────────────────────────────────────────────────
  // Tries HTTP upload first (works remote), falls back to filesystem copy.
  server.tool(
    "upload_image",
    "Upload a local image file to ComfyUI's input/ directory so it can be " +
      "referenced in LoadImage nodes. Tries HTTP upload first (works with " +
      "remote ComfyUI), falls back to filesystem copy when COMFYUI_PATH is set.",
    {
      source_path: z
        .string()
        .describe("Absolute path to the local image file to upload"),
      filename: z
        .string()
        .optional()
        .describe(
          "Override the filename in ComfyUI's input/ directory. " +
            "Auto-detected from source path if omitted.",
        ),
    },
    async (args) => {
      try {
        // Try HTTP upload first (works for remote ComfyUI)
        const result = await uploadImageAuto(args.source_path, args.filename);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Image uploaded successfully via HTTP.\n\n` +
                `Filename: ${result.filename}\n\n` +
                `Use "${result.filename}" as the \`image\` input in LoadImage nodes.`,
            },
          ],
        };
      } catch (httpErr) {
        // Fall back to filesystem copy if HTTP fails and COMFYUI_PATH is set
        try {
          const result = await uploadImage(args.source_path, args.filename);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Image uploaded successfully via filesystem.\n\n` +
                  `Filename: ${result.filename}\nPath: ${result.path}\n\n` +
                  `Use "${result.filename}" as the \`image\` input in LoadImage nodes.`,
              },
            ],
          };
        } catch (fsErr) {
          // Both failed — report both errors
          return errorToToolResult(
            new Error(
              `HTTP upload failed: ${httpErr instanceof Error ? httpErr.message : httpErr}\n` +
                `Filesystem fallback also failed: ${fsErr instanceof Error ? fsErr.message : fsErr}`,
            ),
          );
        }
      }
    },
  );

  // ── workflow_from_image ───────────────────────────────────────────────────
  server.tool(
    "workflow_from_image",
    "Extract embedded ComfyUI workflow metadata from a PNG file. " +
      "ComfyUI stores the full workflow (API format) and prompt data in PNG tEXt chunks. " +
      "Use this to reverse-engineer how any ComfyUI image was generated.",
    {
      image_path: z
        .string()
        .describe("Absolute path to a ComfyUI-generated PNG file"),
    },
    async (args) => {
      try {
        const result = await extractWorkflowFromImage(args.image_path);
        const sections: string[] = [];
        if (result.prompt) {
          sections.push(
            "## API Format (prompt)\n\nThis is the executable workflow format:\n```json\n" +
              JSON.stringify(result.prompt, null, 2) +
              "\n```",
          );
        }
        if (result.workflow) {
          sections.push(
            "## UI Format (workflow)\n\nThis is the ComfyUI web UI format with layout data:\n```json\n" +
              JSON.stringify(result.workflow, null, 2) +
              "\n```",
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `# Workflow extracted from ${args.image_path}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── list_output_images ────────────────────────────────────────────────────
  server.tool(
    "list_output_images",
    "List recently generated images from ComfyUI's output directory. " +
      "Returns filenames sorted newest-first. Requires COMFYUI_PATH. " +
      "For remote ComfyUI, use get_history to find filenames, then get_image to fetch them.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max images to return (default: 20)"),
      pattern: z
        .string()
        .optional()
        .describe("Filter by filename pattern (case-insensitive substring match)"),
    },
    async (args) => {
      try {
        const images = await listOutputImages({
          limit: args.limit,
          pattern: args.pattern,
        });
        if (images.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: args.pattern
                  ? `No output images found matching "${args.pattern}".`
                  : "No output images found.",
              },
            ],
          };
        }
        const lines = images.map((img, i) => {
          const sizeMB = (img.size / 1024 / 1024).toFixed(1);
          const date = new Date(img.modified).toLocaleString();
          return `${i + 1}. **${img.filename}** (${sizeMB} MB) — ${date}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${images.length} image(s):\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
