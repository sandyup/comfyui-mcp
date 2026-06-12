import { Client } from "@stable-canvas/comfyui-client";
import {
  config,
  getComfyUIApiHost,
  getComfyUIProtocol,
  isCloudMode,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { ComfyUIError, ConnectionError } from "../utils/errors.js";
import * as cloudClient from "./cloud-client.js";
import type { ObjectInfo, SystemStats, QueueStatus } from "./types.js";

// Functions that fundamentally require a local ComfyUI process (WebSocket-bound
// session, local `client.fetchApi` paths, etc.) throw via this guard when the
// server is configured for Comfy Cloud — there is no WebSocket to attach to
// and no local socket to call. Dispatcher pattern from @picoSols
// (picoSols/comfyui-cloud-mcp@7a812069).
function requireLocalMode(op: string): void {
  if (isCloudMode()) {
    throw new ComfyUIError(
      `This tool needs a direct ComfyUI session (${op}) and is not available in Comfy Cloud mode. ` +
        `Unset COMFYUI_API_KEY to target a local or remote ComfyUI instance.`,
      "CLOUD_UNSUPPORTED",
    );
  }
}

let clientInstance: Client | null = null;

export function getClient(): Client {
  requireLocalMode("getClient");
  if (!clientInstance) {
    clientInstance = new Client({
      api_host: getComfyUIApiHost(),
      ssl: config.comfyuiSsl,
      clientId: "comfyui-mcp",
      // Node 22+ provides global WebSocket
    });
    logger.info("ComfyUI client created", {
      host: getComfyUIApiHost(),
    });
  }
  return clientInstance;
}

export async function connectClient(): Promise<Client> {
  requireLocalMode("connectClient");
  const client = getClient();
  try {
    await client.connect();
    logger.info("Connected to ComfyUI via WebSocket");
    return client;
  } catch (err) {
    throw new ConnectionError(
      `Failed to connect to ComfyUI at ${getComfyUIApiHost()}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Ensures WebSocket is connected, auto-reconnecting if stale.
 * Only needed before WebSocket-dependent operations (enqueue with progress tracking).
 */
export async function ensureConnected(): Promise<Client> {
  requireLocalMode("ensureConnected");
  const client = getClient();

  // If the socket looks healthy, return immediately
  if (!client.closed) {
    return client;
  }

  // Socket is stale — reset and reconnect
  logger.info("WebSocket stale (closed=true), reconnecting...");
  resetClient();

  try {
    return await connectClient();
  } catch {
    // First attempt failed — reset singleton completely and retry once
    logger.warn("Reconnect failed, resetting client and retrying...");
    resetClient();
    try {
      return await connectClient();
    } catch (err) {
      throw new ConnectionError(
        `Failed to reconnect to ComfyUI after retry: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  if (isCloudMode()) return cloudClient.getSystemStats();
  const client = getClient();
  const stats = await client.getSystemStats();
  return stats as unknown as SystemStats;
}

// /object_info is large (~MBs) and slow (300-800 ms) but only changes when
// ComfyUI restarts or a custom node is (un)installed. Memoize it for the
// life of the server process; restartComfyUI()/stopComfyUI() reset it.
// In-flight coalescing prevents a thundering herd on the first fetch.
// Perf gap flagged by josephoibrahim/comfy-cozy (re-validate ~7 s → ~0.5 s).
let objectInfoCache: ObjectInfo | null = null;
let objectInfoInflight: Promise<ObjectInfo> | null = null;

export async function getObjectInfo(): Promise<ObjectInfo> {
  if (isCloudMode()) return cloudClient.getObjectInfo();
  if (objectInfoCache) return objectInfoCache;
  if (objectInfoInflight) return objectInfoInflight;

  objectInfoInflight = (async () => {
    const client = getClient();
    const info = (await client.getNodeDefs()) as unknown as ObjectInfo;
    objectInfoCache = info;
    return info;
  })();

  try {
    return await objectInfoInflight;
  } finally {
    objectInfoInflight = null;
  }
}

/**
 * Drop the memoized /object_info so the next call refetches. Called after
 * ComfyUI restarts (node packs may have changed) and available for tools
 * that mutate the node set mid-session.
 */
export function resetObjectInfoCache(): void {
  objectInfoCache = null;
  logger.debug("object_info cache reset");
}

export async function getQueue(): Promise<QueueStatus> {
  if (isCloudMode()) return cloudClient.getQueue();
  const client = getClient();
  const queue = await client.getQueue() as Record<string, unknown>;
  return {
    queue_running: (queue.Running ?? queue.queue_running ?? []) as QueueStatus["queue_running"],
    queue_pending: (queue.Pending ?? queue.queue_pending ?? []) as QueueStatus["queue_pending"],
  };
}

export async function interrupt(promptId?: string): Promise<void> {
  if (isCloudMode()) return cloudClient.interrupt(promptId);
  const client = getClient();
  await client.interrupt(promptId ?? null);
}

/**
 * Fire-and-forget: enqueue a prompt via HTTP POST (no WebSocket needed).
 * Returns prompt_id and queue position immediately.
 */
export async function enqueuePrompt(
  workflow: Record<string, unknown>,
  extraData?: Record<string, unknown>,
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  if (isCloudMode()) return cloudClient.enqueuePrompt(workflow, extraData);
  const client = getClient();

  // The SDK's _enqueue_prompt does not forward `extra_data`, which is how
  // comfy.org API-node credentials (api_key_comfy_org / auth_token_comfy_org)
  // must travel to the server. When extra_data is supplied, POST /prompt directly.
  if (extraData && Object.keys(extraData).length > 0) {
    const url = `${getComfyUIProtocol()}://${getComfyUIApiHost()}/prompt`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "comfyui-mcp",
        extra_data: extraData,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConnectionError(
        `ComfyUI /prompt returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }
    const data = (await res.json()) as { prompt_id: string; number?: number };
    return { prompt_id: data.prompt_id, queue_remaining: data.number };
  }

  const result = await client._enqueue_prompt(workflow);
  return {
    prompt_id: result.prompt_id,
    queue_remaining: result.exec_info?.queue_remaining,
  };
}

/**
 * Remove a specific pending job from the queue by prompt_id.
 */
export async function deleteQueueItem(id: string): Promise<void> {
  if (isCloudMode()) return cloudClient.deleteQueueItem(id);
  const client = getClient();
  await client.deleteItem("queue", id);
}

/**
 * Clear all pending jobs from the queue (doesn't affect running job).
 */
export async function clearQueue(): Promise<void> {
  if (isCloudMode()) return cloudClient.clearQueue();
  const client = getClient();
  await client.clearItems("queue");
}

export async function getSamplers(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getSamplers();
  const client = getClient();
  return client.getSamplers();
}

export async function getSchedulers(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getSchedulers();
  const client = getClient();
  return client.getSchedulers();
}

export async function getCheckpoints(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getCheckpoints();
  const client = getClient();
  return client.getSDModels();
}

export async function getLoRAs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getLoRAs();
  const client = getClient();
  return client.getLoRAs();
}

export async function getVAEs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getVAEs();
  const client = getClient();
  return client.getVAEs();
}

export async function getUpscaleModels(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getUpscaleModels();
  const client = getClient();
  return client.getUpscaleModels();
}

export function resetClient(): void {
  if (clientInstance) {
    try {
      clientInstance.close();
    } catch {
      // Ignore close errors — process may already be dead
    }
    clientInstance = null;
    logger.info("ComfyUI client reset");
  }
}

export function getComfyUIPath(): string | undefined {
  if (isCloudMode()) return cloudClient.getComfyUIPath();
  return config.comfyuiPath;
}

export async function getLogs(): Promise<string[]> {
  if (isCloudMode()) return cloudClient.getLogs();
  const client = getClient();
  const res = await client.fetchApi("/internal/logs");
  const text = await res.text();

  // ComfyUI returns logs as a JSON-encoded string with \n separators,
  // or as raw text depending on version. Handle both.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed.split("\n").filter(Boolean);
    }
  } catch {
    // Not JSON — treat as raw text
  }
  return text.split("\n").filter(Boolean);
}

export interface HistoryEntry {
  prompt: Record<string, unknown>;
  outputs: Record<string, unknown>;
  status: {
    status_str: string;
    completed: boolean;
    messages: Array<[string, Record<string, unknown>]>;
  };
  meta?: Record<string, unknown>;
}

export async function getHistory(
  promptId?: string,
): Promise<Record<string, HistoryEntry>> {
  if (isCloudMode()) return cloudClient.getHistory(promptId);
  const client = getClient();
  const path = promptId ? `/history/${promptId}` : "/history";
  const res = await client.fetchApi(path);
  return res.json() as Promise<Record<string, HistoryEntry>>;
}

/**
 * Fetch an image from ComfyUI's /view endpoint as a base64 string.
 * Works over HTTP — no local filesystem access needed.
 */
export async function fetchImage(
  filename: string,
  type: "output" | "input" | "temp" = "output",
  subfolder = "",
): Promise<{ base64: string; mimeType: string }> {
  if (isCloudMode()) return cloudClient.fetchImage(filename, type, subfolder);
  const client = getClient();
  const params = new URLSearchParams({ filename, type, subfolder });
  const res = await client.fetchApi(`/view?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`ComfyUI /view returned ${res.status} for "${filename}"`);
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  const mimeType = contentType.split(";")[0].trim();
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

/**
 * Upload an image to ComfyUI's input/ directory via HTTP multipart POST.
 * Works over HTTP — no local filesystem access needed.
 */
export async function uploadImageHttp(
  filename: string,
  data: Buffer,
  mimeType = "image/png",
): Promise<{ name: string; subfolder: string; type: string }> {
  if (isCloudMode()) return cloudClient.uploadImageHttp(filename, data, mimeType);
  const client = getClient();
  const formData = new FormData();
  const blob = new Blob([data], { type: mimeType });
  formData.append("image", blob, filename);
  formData.append("type", "input");
  formData.append("overwrite", "true");
  const res = await client.fetchApi("/upload/image", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI /upload/image returned ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ name: string; subfolder: string; type: string }>;
}
