// Read and write the user's Claude Code MCP-server config (~/.claude.json), so
// the panel orchestrator's background agent uses the SAME MCP servers the user's
// normal `claude` session does — and can ADD new ones programmatically (e.g.
// connect the CivitAI MCP on demand), persisting them to the user's real config.
//
// MCP servers live at the top level of ~/.claude.json under `mcpServers`, keyed
// by name; each value is a Claude Agent SDK server config (stdio | sse | http).
// We deliberately EXCLUDE any entry that looks like a comfyui-mcp instance — the
// orchestrator injects its own bridge-safe comfyui server, and a second one
// would fight for the panel bridge port.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/** A Claude Agent SDK MCP server config (stdio / sse / http). Opaque here. */
export type McpServerConfig = Record<string, unknown>;

/** Path to the user's Claude config. Overridable for tests. */
export function claudeJsonPath(): string {
  return process.env.COMFYUI_MCP_CLAUDE_JSON || join(homedir(), ".claude.json");
}

function readClaudeJson(): Record<string, unknown> {
  const p = claudeJsonPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    logger.warn(
      `[user-mcp] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

function serversObject(cfg: Record<string, unknown>): Record<string, McpServerConfig> {
  const m = cfg.mcpServers;
  return m && typeof m === "object" ? (m as Record<string, McpServerConfig>) : {};
}

/**
 * Would this server fight our own comfyui server for the bridge port? True for
 * anything named "comfyui" or whose config invokes comfyui-mcp.
 */
export function isConflictingServer(name: string, cfg: unknown): boolean {
  if (name.toLowerCase() === "comfyui") return true;
  const s = JSON.stringify(cfg ?? "").toLowerCase();
  return s.includes("comfyui-mcp");
}

/**
 * The user's configured MCP servers (user scope), minus anything that conflicts
 * with our injected comfyui server. This is what the panel agent inherits.
 */
export function readUserMcpServers(): Record<string, McpServerConfig> {
  const servers = serversObject(readClaudeJson());
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isConflictingServer(name, cfg)) continue;
    out[name] = cfg;
  }
  return out;
}

const NAME_RE = /^[\w.-]+$/;

/**
 * Add (or replace) an MCP server in the user's Claude config, persisting it so
 * both the panel agent (after a reload) and the user's normal session see it.
 * Refuses conflicting names so we can't accidentally clobber the bridge.
 */
export function addUserMcpServer(name: string, config: McpServerConfig): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid MCP server name "${name}" (use letters, digits, dot, dash, underscore).`);
  }
  if (isConflictingServer(name, config)) {
    throw new Error(`Refusing to add "${name}" — it conflicts with the panel's own comfyui server.`);
  }
  const cfg = readClaudeJson();
  const servers = serversObject(cfg);
  servers[name] = config;
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
}

/** Where a secret value should be written on an MCP server. */
export interface McpSecretTarget {
  /** "header" → server.headers[key] (http/sse); "env" → server.env[key] (stdio). */
  kind: "header" | "env";
  /** The MCP server name (must already exist). */
  server: string;
  /** Header name (e.g. "Authorization") or env var name (e.g. "CIVITAI_API_TOKEN"). */
  key: string;
  /** Optional string prepended to the value, e.g. "Bearer ". */
  prefix?: string;
}

/**
 * Write a secret onto an existing MCP server (a header for http/sse, or an env
 * var for stdio), persisting to ~/.claude.json. The caller passes the raw secret
 * straight from the secure input; it is never logged or returned anywhere.
 */
export function setUserMcpServerSecret(target: McpSecretTarget, value: string): void {
  const cfg = readClaudeJson();
  const servers = serversObject(cfg);
  const server = servers[target.server];
  if (!server || typeof server !== "object") {
    throw new Error(`MCP server "${target.server}" is not configured — add it first with panel_add_mcp.`);
  }
  const bag = target.kind === "header" ? "headers" : "env";
  const s = server as Record<string, unknown>;
  const existing = s[bag] && typeof s[bag] === "object" ? (s[bag] as Record<string, string>) : {};
  existing[target.key] = `${target.prefix ?? ""}${value}`;
  s[bag] = existing;
  servers[target.server] = s;
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
}

/** Remove an MCP server from the user's config. Returns false if absent. */
export function removeUserMcpServer(name: string): boolean {
  const cfg = readClaudeJson();
  const servers = serversObject(cfg);
  if (!(name in servers)) return false;
  delete servers[name];
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
  return true;
}
