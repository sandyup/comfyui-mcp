import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, getComfyUIApiHost, getComfyUIProtocol } from "../config.js";
import { NodeSnapshotError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// ComfyUI-Manager snapshot HTTP API
//
// Confirmed endpoints (Comfy-Org/ComfyUI-Manager, glob/manager_server.py):
//   GET  /snapshot/getlist      -> { items: string[] }   (names without .json)
//   POST /snapshot/save         -> 200 (filename {date}_snapshot.json, no name arg)
//   POST /snapshot/restore      -> 200, body { target: <name> }
//   GET  /snapshot/get_current  -> snapshot state JSON
//
// The HTTP API works against remote instances (--comfyui-url). Naming a
// snapshot is only possible via the file fallback (writes get_current output
// to the Manager snapshots dir), which requires a local config.comfyuiPath.
// ---------------------------------------------------------------------------

export interface SaveSnapshotResult {
  name: string;
  method: "http" | "file";
  message: string;
}

export interface RestoreSnapshotResult {
  name: string;
  message: string;
}

export interface ListSnapshotsResult {
  snapshots: string[];
}

function managerBaseUrl(): string {
  return `${getComfyUIProtocol()}://${getComfyUIApiHost()}`;
}

/**
 * Fetch a ComfyUI-Manager endpoint. Throws NodeSnapshotError on non-2xx or
 * network failure so callers can route through errorToToolResult.
 */
async function managerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${managerBaseUrl()}${path}`;
  logger.debug("Manager API request", { url, method: init?.method ?? "GET" });

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NodeSnapshotError(
      `Failed to reach ComfyUI-Manager at ${url}: ${msg}. ` +
        `Is ComfyUI running with ComfyUI-Manager installed?`,
      { url },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NodeSnapshotError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`,
      { url, status: res.status, body },
    );
  }
  return res;
}

/**
 * Candidate ComfyUI-Manager snapshot directories under a local install,
 * newest layout first. Mirrors manager_migration.get_manager_path().
 */
function snapshotDirCandidates(comfyuiPath: string): string[] {
  return [
    join(comfyuiPath, "user", "__manager", "snapshots"),
    join(comfyuiPath, "user", "default", "ComfyUI-Manager", "snapshots"),
    join(comfyuiPath, "custom_nodes", "ComfyUI-Manager", "snapshots"),
  ];
}

/**
 * Resolve the directory to write a named snapshot into. Prefers an existing
 * Manager snapshots dir; otherwise falls back to the newest-layout path
 * (created on write).
 */
function resolveSnapshotWriteDir(comfyuiPath: string): string {
  const candidates = snapshotDirCandidates(comfyuiPath);
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/** GET /snapshot/getlist */
export async function listNodeSnapshots(): Promise<ListSnapshotsResult> {
  const res = await managerFetch("/snapshot/getlist");
  const data = (await res.json()) as { items?: unknown };
  const items = Array.isArray(data.items)
    ? data.items.filter((x): x is string => typeof x === "string")
    : [];
  logger.info(`Listed ${items.length} node snapshot(s)`);
  return { snapshots: items };
}

/**
 * Save a snapshot of the current custom-node + version state.
 *
 * - No name: POST /snapshot/save (Manager names it {date}_snapshot). Works
 *   remotely. We diff getlist before/after to report the created name.
 * - Named: fetch GET /snapshot/get_current and write <name>.json into the
 *   local Manager snapshots dir. Requires config.comfyuiPath (errors clearly
 *   in remote --comfyui-url mode).
 */
export async function saveNodeSnapshot(
  name?: string,
): Promise<SaveSnapshotResult> {
  const trimmed = name?.trim();

  if (!trimmed) {
    // HTTP-only path — Manager assigns a timestamped name.
    const before = new Set((await listNodeSnapshots()).snapshots);
    await managerFetch("/snapshot/save", { method: "POST" });
    const after = (await listNodeSnapshots()).snapshots;
    const created = after.find((n) => !before.has(n));
    const resolved = created ?? after[0] ?? "(unknown)";
    return {
      name: resolved,
      method: "http",
      message: `Saved snapshot "${resolved}" via ComfyUI-Manager.`,
    };
  }

  // Named snapshot — requires a local install to write the file.
  validateSnapshotName(trimmed);
  if (!config.comfyuiPath) {
    throw new NodeSnapshotError(
      "Saving a named snapshot requires a local ComfyUI install path, which " +
        "is unavailable in remote (--comfyui-url) mode. Omit the name to let " +
        "ComfyUI-Manager assign a timestamped snapshot instead.",
    );
  }

  // Capture current state from the running instance via the Manager API.
  const res = await managerFetch("/snapshot/get_current");
  const snapshot = await res.json();

  const dir = resolveSnapshotWriteDir(config.comfyuiPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${trimmed}.json`);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 4), "utf-8");
  logger.info(`Wrote named node snapshot to ${filePath}`);

  return {
    name: trimmed,
    method: "file",
    message: `Saved snapshot "${trimmed}" to ${filePath}.`,
  };
}

/** POST /snapshot/restore with { target } */
export async function restoreNodeSnapshot(
  name: string,
): Promise<RestoreSnapshotResult> {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new NodeSnapshotError("Snapshot name is required to restore.");
  }

  // The Manager stores names without the .json suffix; tolerate either.
  const target = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;

  await managerFetch("/snapshot/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });

  logger.info(`Requested restore of node snapshot "${target}"`);
  return {
    name: target,
    message:
      `Restore of snapshot "${target}" requested. ComfyUI-Manager applies ` +
      `custom-node changes on the next ComfyUI restart.`,
  };
}

/**
 * Reject names that would escape the snapshots directory or produce an
 * invalid filename.
 */
function validateSnapshotName(name: string): void {
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    throw new NodeSnapshotError(
      `Invalid snapshot name "${name}": must not contain path separators or "..".`,
    );
  }
}
