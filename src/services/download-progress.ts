// Cross-process download-progress channel.
//
// Model downloads run INSIDE the panel agent's comfyui MCP subprocess, but the
// panel bridge that renders the download tray lives in the ORCHESTRATOR process.
// To bridge them without a socket, the subprocess writes a small per-download
// progress JSON into COMFYUI_MCP_PROGRESS_DIR; the orchestrator watches that dir
// and broadcasts the rows to the panel (see src/orchestrator/index.ts).
//
// This no-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — i.e. for every
// normal (non-panel) use of the MCP — so it costs nothing outside the panel.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface DownloadProgress {
  /** Stable id for this download (a hash of the source URL). */
  id: string;
  /** Human-friendly file name shown in the tray. */
  name: string;
  /** Bytes written so far. */
  downloaded: number;
  /** Total bytes (0 when the server didn't send Content-Length). */
  total: number;
  /** Instantaneous throughput, bytes/sec. */
  bytes_per_sec: number;
  /** Lifecycle. */
  status: "downloading" | "done" | "error";
  /** Epoch ms of this snapshot (set on write). */
  updated: number;
}

const PROGRESS_DIR = process.env.COMFYUI_MCP_PROGRESS_DIR || "";
const lastWriteAt = new Map<string, number>();

/** True when running under the panel orchestrator (progress channel is active). */
export function progressEnabled(): boolean {
  return !!PROGRESS_DIR;
}

function fileFor(id: string): string {
  // The id is a hex hash from callers, but stay defensive about the filename.
  return join(PROGRESS_DIR, `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

/**
 * Write a progress snapshot for one download. The in-flight "downloading" state
 * is throttled to ~3/sec to avoid hammering the disk; terminal states
 * (done/error) always write so the final row is accurate.
 */
export function reportDownloadProgress(
  p: Omit<DownloadProgress, "updated">,
  force = false,
): void {
  if (!PROGRESS_DIR) return;
  const now = Date.now();
  if (!force && p.status === "downloading") {
    if (now - (lastWriteAt.get(p.id) ?? 0) < 300) return;
  }
  lastWriteAt.set(p.id, now);
  try {
    mkdirSync(PROGRESS_DIR, { recursive: true });
    writeFileSync(fileFor(p.id), JSON.stringify({ ...p, updated: now }));
  } catch {
    // best-effort — progress is cosmetic, never fail a download over it
  }
}

/** Remove a download's progress file (e.g. on cancel). */
export function clearDownloadProgress(id: string): void {
  if (!PROGRESS_DIR) return;
  lastWriteAt.delete(id);
  try {
    rmSync(fileFor(id), { force: true });
  } catch {
    // ignore
  }
}
