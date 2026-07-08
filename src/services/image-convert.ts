import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { ValidationError } from "../utils/errors.js";

export type ConvertImageFormat = "png" | "jpeg" | "webp";

export interface ConvertImageOptions {
  asset_id?: string;
  path?: string;
  format: ConvertImageFormat;
  quality?: number;
  progressive?: boolean;
  lossless?: boolean;
  effort?: number;
  out_path?: string;
}

export interface ConvertImageResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  format: ConvertImageFormat;
  mimeType: string;
  sourceBytes: number;
  outputBytes: number;
  bytesSaved: number;
  outPath?: string;
}

interface SourceImage {
  label: string;
  bytes: Buffer;
}

const MIME_BY_FORMAT: Record<ConvertImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const SUPPORTED_SOURCE_MIME = /^image\/(png|jpe?g|webp)$/i;

function getOutputDir(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "output");
}

function resolveOutputPath(path: string, label: string): string {
  if (path.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty path.`);
  }

  const outputDir = getOutputDir();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
  if (resolved === outputDir || !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError(`${label} must stay within the ComfyUI output directory.`);
  }
  return resolved;
}

async function resolveSource(opts: ConvertImageOptions): Promise<SourceImage> {
  if (opts.asset_id) {
    const record = AssetRegistry.get(opts.asset_id);
    if (!record) {
      throw new ValidationError(
        `No asset found for id "${opts.asset_id}". It may have expired or never been registered.`,
      );
    }

    const validType = record.type === "output" || record.type === "input" || record.type === "temp";
    const fetchType: "output" | "input" | "temp" = validType
      ? (record.type as "output" | "input" | "temp")
      : "output";
    const image = await getOutputImage(record.filename, fetchType, record.subfolder);
    if (!SUPPORTED_SOURCE_MIME.test(image.mimeType)) {
      throw new ValidationError(
        `Asset "${opts.asset_id}" is not a supported image (mime: ${image.mimeType}).`,
      );
    }
    return {
      label: `asset ${opts.asset_id} (${record.filename})`,
      bytes: Buffer.from(image.base64, "base64"),
    };
  }

  if (!opts.path) {
    throw new ValidationError("convert_image requires either asset_id or path.");
  }

  const sourcePath = resolveOutputPath(opts.path, "path");
  const info = await stat(sourcePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new ValidationError(`Source image not found: ${sourcePath}`);
  }
  return {
    label: sourcePath,
    bytes: await readFile(sourcePath),
  };
}

function buildEncoder(
  input: Buffer,
  opts: ConvertImageOptions,
): ReturnType<typeof sharp> {
  const image = sharp(input);
  if (opts.format === "png") {
    return image.png({ quality: opts.quality });
  }
  if (opts.format === "jpeg") {
    return image.jpeg({
      quality: opts.quality,
      progressive: opts.progressive,
    });
  }
  return image.webp({
    quality: opts.quality,
    lossless: opts.lossless,
    effort: opts.effort,
  });
}

function validateEncodeOptions(opts: ConvertImageOptions): void {
  if (
    opts.quality !== undefined &&
    (!Number.isInteger(opts.quality) || opts.quality < 1 || opts.quality > 100)
  ) {
    throw new ValidationError("quality must be an integer between 1 and 100.");
  }
  if (
    opts.effort !== undefined &&
    (!Number.isInteger(opts.effort) || opts.effort < 0 || opts.effort > 6)
  ) {
    throw new ValidationError("effort must be an integer between 0 and 6.");
  }
}

export async function convertImage(
  opts: ConvertImageOptions,
): Promise<ConvertImageResult> {
  if (Boolean(opts.asset_id) === Boolean(opts.path)) {
    throw new ValidationError("Provide exactly one image source: asset_id or path.");
  }
  validateEncodeOptions(opts);

  const source = await resolveSource(opts);
  const converted = await buildEncoder(source.bytes, opts).toBuffer();
  const mimeType = MIME_BY_FORMAT[opts.format];
  const outPath = opts.out_path
    ? resolveOutputPath(opts.out_path, "out_path")
    : undefined;

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, converted);
  }

  const sourceBytes = source.bytes.length;
  const outputBytes = converted.length;
  const bytesSaved = sourceBytes - outputBytes;
  const summary = {
    source: source.label,
    format: opts.format,
    mime_type: mimeType,
    source_bytes: sourceBytes,
    output_bytes: outputBytes,
    bytes_saved: bytesSaved,
    out_path: outPath,
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      {
        type: "image",
        data: converted.toString("base64"),
        mimeType,
      },
    ],
    format: opts.format,
    mimeType,
    sourceBytes,
    outputBytes,
    bytesSaved,
    outPath,
  };
}
