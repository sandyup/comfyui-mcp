import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  extractWorkflowFromImage,
  listOutputImages,
  getOutputImage,
  uploadImageAuto,
  uploadVideoAuto,
  uploadAudioAuto,
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

  // ── upload_image / upload_video / upload_audio ────────────────────────────
  // HTTP-only (works for both local and remote ComfyUI via /upload/image).
  // Previous filesystem fallback was deceptive when COMFYUI_PATH auto-detected
  // an unrelated local install — files would land in the wrong tree and the
  // tool reported success while the remote ComfyUI never received them.
  // Originally diagnosed by João Lucas (github.com/joaolvivas) in
  // joaolvivas/comfyui-mcp-byjlucas@089180ad (2026-05-12).
  const registerMediaUpload = (
    name: string,
    description: string,
    autoFn: (s: string, f?: string) => Promise<{ filename: string }>,
    nodeHint: string,
  ): void => {
    server.tool(
      name,
      description,
      {
        source_path: z
          .string()
          .describe("Absolute path to the local file to upload"),
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
          const result = await autoFn(args.source_path, args.filename);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Uploaded via HTTP.\n\nFilename: ${result.filename}\n\n` +
                  `Use "${result.filename}" ${nodeHint}.`,
              },
            ],
          };
        } catch (err) {
          return errorToToolResult(err);
        }
      },
    );
  };

  registerMediaUpload(
    "upload_image",
    "Upload a local image file to the connected ComfyUI's input/ directory " +
      "via the HTTP /upload/image endpoint so it can be referenced in LoadImage " +
      "nodes. Works for both local and remote ComfyUI. Returns the stored " +
      "filename.",
    uploadImageAuto,
    "as the `image` input in LoadImage nodes",
  );

  registerMediaUpload(
    "upload_video",
    "Upload a local video file (.mp4, .mov, .webm, .avi, .mkv, .m4v) to the " +
      "connected ComfyUI's input/ directory via the HTTP /upload/image endpoint " +
      "for use in video-loading nodes such as VHS_LoadVideo " +
      "(ComfyUI-VideoHelperSuite). Works for both local and remote ComfyUI. " +
      "Returns the stored filename. Use upload_image for images or " +
      "upload_audio for audio.",
    uploadVideoAuto,
    "as the video file input in VHS_LoadVideo (or similar) nodes",
  );

  registerMediaUpload(
    "upload_audio",
    "Upload a local audio file (.wav, .mp3, .flac, .ogg, .m4a, .aac) to the " +
      "connected ComfyUI's input/ directory via the HTTP /upload/image endpoint " +
      "for use in audio-conditioned workflows (e.g. LoadAudio). Works for both " +
      "local and remote ComfyUI. Returns the stored filename. Use upload_image " +
      "for images or upload_video for video.",
    uploadAudioAuto,
    "as the audio file input in LoadAudio (or similar) nodes",
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
    "List recently generated image files from ComfyUI's local output/ directory (filesystem scan), newest-first, with file size and modification time. Requires COMFYUI_PATH to be set (local installs only) — it does NOT return the image data itself. For remote ComfyUI, use get_history to find filenames, then get_image to fetch the actual bytes. Read-only.",
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
