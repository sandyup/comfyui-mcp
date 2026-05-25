import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".comfyui-mcp", "cache");
const HASH_CHARS = 32;
const inflight = new Map<string, Promise<string>>();

export const downloadCacheFs = {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
};

export interface DownloadCacheOptions {
  url: string;
  headers: Record<string, string>;
  targetPath: string;
}

export interface DownloadCacheResult {
  targetPath: string;
  usedCache: boolean;
  cachePath?: string;
  materializedBy?: "hardlink" | "copy";
}

function cacheDir(): string {
  return resolve(process.env.COMFYUI_DOWNLOAD_CACHE_DIR || DEFAULT_CACHE_DIR);
}

function cacheSizeLimitBytes(): number {
  const raw = Number(process.env.COMFYUI_LRU_CACHE_SIZE_GB ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * 1024 * 1024 * 1024;
}

function cachePathForUrl(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, HASH_CHARS);
  let extension = "";
  try {
    extension = extname(basename(new URL(url).pathname));
  } catch {
    // Callers validate URLs before reaching this layer; keep the cache helper
    // defensive so fallback direct downloads can still surface the real error.
  }
  return join(cacheDir(), `${hash}${extension}`);
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await downloadCacheFs.utimes(path, now, now);
}

async function streamUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ModelError(
      `Download failed: ${res.status} ${res.statusText}`,
      { url, status: res.status },
    );
  }

  if (!res.body) {
    throw new ModelError("Download response has no body", { url });
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(targetPath);
  await pipeline(nodeStream, fileStream);
}

async function downloadIntoCache(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const target = cachePathForUrl(url);
  const key = target;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    await downloadCacheFs.mkdir(cacheDir(), { recursive: true });

    try {
      const info = await downloadCacheFs.stat(target);
      if (info.isFile()) {
        await touch(target);
        return target;
      }
    } catch {
      // Cache miss.
    }

    const tmp = join(cacheDir(), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await streamUrlToFile(url, tmp, headers);
      await downloadCacheFs.rename(tmp, target);
      await touch(target);
      return target;
    } catch (err) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function materializeCacheFile(
  cachePath: string,
  targetPath: string,
): Promise<"hardlink" | "copy"> {
  if (resolve(cachePath) === resolve(targetPath)) return "hardlink";

  await downloadCacheFs.rm(targetPath, { force: true });
  try {
    await downloadCacheFs.link(cachePath, targetPath);
    return "hardlink";
  } catch {
    await downloadCacheFs.copyFile(cachePath, targetPath);
    return "copy";
  }
}

async function evictLruIfNeeded(): Promise<void> {
  const limit = cacheSizeLimitBytes();
  if (limit <= 0) return;

  const dir = cacheDir();
  const entries = await downloadCacheFs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = join(dir, entry.name);
        const info = await downloadCacheFs.stat(path);
        return {
          path,
          size: info.size,
          time: Math.max(info.atimeMs, info.mtimeMs),
        };
      }),
  );

  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= limit) return;

  files.sort((a, b) => a.time - b.time);
  for (const file of files) {
    await downloadCacheFs.rm(file.path, { force: true });
    total -= file.size;
    if (total <= limit) break;
  }
}

export async function downloadUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
): Promise<void> {
  await streamUrlToFile(url, targetPath, headers);
}

export async function downloadWithCache(
  options: DownloadCacheOptions,
): Promise<DownloadCacheResult> {
  try {
    const cachePath = await downloadIntoCache(options.url, options.headers);
    const materializedBy = await materializeCacheFile(cachePath, options.targetPath);
    await evictLruIfNeeded();
    return {
      targetPath: options.targetPath,
      usedCache: true,
      cachePath,
      materializedBy,
    };
  } catch (err) {
    if (err instanceof ModelError) throw err;
    logger.warn("Download cache unavailable; falling back to direct download", {
      url: options.url,
      error: err instanceof Error ? err.message : String(err),
    });
    await downloadUrlToFile(options.url, options.targetPath, options.headers);
    return { targetPath: options.targetPath, usedCache: false };
  }
}
