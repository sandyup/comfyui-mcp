import { readdir, stat, mkdir } from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { config } from "../config.js";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { downloadWithCache } from "./download-cache.js";

export const MODEL_SUBDIRS = [
  "checkpoints",
  "loras",
  "vae",
  "upscale_models",
  "controlnet",
  "embeddings",
  "clip",
  "diffusers",
  "diffusion_models",
  "gligen",
  "hypernetworks",
  "photomaker",
  "style_models",
  "text_encoders",
  "unet",
] as const;

export type ModelType = (typeof MODEL_SUBDIRS)[number];

export interface HFModelResult {
  id: string;
  modelId: string;
  author: string;
  tags: string[];
  downloads: number;
  likes: number;
  lastModified: string;
}

export interface LocalModel {
  name: string;
  path: string;
  size: number;
  modified: string;
  type: string;
}

function getModelsRoot(): string {
  if (!config.comfyuiPath) {
    throw new ModelError("COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.");
  }
  return join(config.comfyuiPath, "models");
}

export async function searchHuggingFaceModels(
  query: string,
  options: { filter?: string; limit?: number } = {},
): Promise<HFModelResult[]> {
  const { filter, limit = 10 } = options;
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
  });
  if (filter) params.set("filter", filter);

  const headers: Record<string, string> = {};
  if (config.huggingfaceToken) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  }

  const url = `https://huggingface.co/api/models?${params}`;
  logger.debug("HuggingFace API request", { url });

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(
      `HuggingFace API ${res.status}: ${res.statusText}`,
      { url, status: res.status, body },
    );
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((m) => ({
    id: String(m.id ?? m._id ?? ""),
    modelId: String(m.modelId ?? m.id ?? ""),
    author: String(m.author ?? ""),
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    downloads: Number(m.downloads ?? 0),
    likes: Number(m.likes ?? 0),
    lastModified: String(m.lastModified ?? ""),
  }));
}

export async function listLocalModels(
  modelType?: string,
): Promise<LocalModel[]> {
  const modelsRoot = getModelsRoot();
  const dirsToScan: string[] = modelType
    ? [modelType]
    : [...MODEL_SUBDIRS];

  const results: LocalModel[] = [];

  for (const dir of dirsToScan) {
    const dirPath = join(modelsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath, { recursive: true });
    } catch {
      // Directory doesn't exist -- skip silently
      continue;
    }

    for (const entry of entries) {
      const filePath = join(dirPath, entry);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        results.push({
          name: entry,
          path: filePath,
          size: info.size,
          modified: info.mtime.toISOString(),
          type: dir,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }

  return results;
}

/** True when `url`'s host is civitai.com (or a subdomain), parsed safely. */
function isCivitaiUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "civitai.com" || host.endsWith(".civitai.com");
  } catch {
    return false;
  }
}

export async function downloadModel(
  url: string,
  targetSubfolder: string,
  filename?: string,
): Promise<string> {
  const modelsRoot = getModelsRoot();
  const targetDir = join(modelsRoot, targetSubfolder);

  // Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  const rawFilename =
    filename ?? (basename(new URL(url).pathname) || "model.safetensors");
  // Guard against path traversal: the filename must be a bare basename so it
  // cannot escape targetDir via separators or "..".
  const resolvedFilename = basename(rawFilename);
  if (
    resolvedFilename !== rawFilename ||
    resolvedFilename === "" ||
    resolvedFilename === "." ||
    resolvedFilename === ".."
  ) {
    throw new ModelError(
      "Invalid model filename: must be a plain filename without path separators or '..'.",
      { filename: rawFilename },
    );
  }
  const targetPath = join(targetDir, resolvedFilename);
  // Defense-in-depth: confirm the resolved path stays inside targetDir.
  if (!resolve(targetPath).startsWith(resolve(targetDir) + sep)) {
    throw new ModelError(
      "Refusing to write outside the target model directory.",
      { filename: rawFilename },
    );
  }

  logger.info(`Downloading model to ${targetPath}`, { url });

  const headers: Record<string, string> = {};
  if (config.huggingfaceToken && url.includes("huggingface.co")) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  } else if (config.civitaiApiToken && isCivitaiUrl(url)) {
    // CivitAI auth travels as a request header (never in the URL/query) so the
    // token can't leak into logs, errors, or redirect URLs. fetch drops the
    // header on the cross-origin redirect to the already-signed download host.
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }

  await downloadWithCache({ url, headers, targetPath });

  const info = await stat(targetPath);
  logger.info(`Download complete: ${resolvedFilename} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

  return targetPath;
}
