import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseDocument, Document } from "yaml";

/**
 * First-class setup for non-Claude MCP harnesses (issue #97):
 * `comfyui-mcp setup <agent>` merges a ready-to-run comfyui server entry into
 * the harness's own config file, preserving everything else in it.
 *
 * Supported agents and their config shapes:
 * - hermes   ~/.hermes/config.yaml        mcp_servers.comfyui  (YAML, comments preserved)
 * - openclaw ~/.openclaw/openclaw.json    mcpServers.comfyui   (+ transport: "stdio")
 * - copilot  ~/.copilot/mcp-config.json   mcpServers.comfyui   (+ type: "stdio", tools: ["*"])
 */
export type AgentName = "hermes" | "openclaw" | "copilot";

export const AGENT_NAMES: readonly AgentName[] = ["hermes", "openclaw", "copilot"];

export interface SetupOptions {
  agent: AgentName;
  /** Register in compact tool mode (3 meta-tools). Defaults per agent:
   *  hermes/openclaw → true (both harnesses inject every schema into context and
   *  recommend low tool counts), copilot → false (frontier models). */
  compact?: boolean;
  /** COMFYUI_URL to embed in the server entry's env (omitted → auto-detect). */
  comfyuiUrl?: string;
  /** Print the merged config instead of writing it. */
  dryRun?: boolean;
  /** Override the config file path (tests). */
  configPath?: string;
}

export interface SetupResult {
  agent: AgentName;
  configPath: string;
  compact: boolean;
  /** Full new file content (what was or would be written). */
  content: string;
  wrote: boolean;
  /** Human next steps for this harness. */
  nextSteps: string[];
}

export function defaultConfigPath(agent: AgentName): string {
  switch (agent) {
    case "hermes":
      return join(homedir(), ".hermes", "config.yaml");
    case "openclaw":
      return join(homedir(), ".openclaw", "openclaw.json");
    case "copilot":
      return join(homedir(), ".copilot", "mcp-config.json");
  }
}

export function defaultCompact(agent: AgentName): boolean {
  return agent !== "copilot";
}

function serverArgs(compact: boolean): string[] {
  return compact ? ["-y", "comfyui-mcp", "--compact"] : ["-y", "comfyui-mcp"];
}

function buildEntry(agent: AgentName, compact: boolean, comfyuiUrl?: string): Record<string, unknown> {
  const env = comfyuiUrl ? { COMFYUI_URL: comfyuiUrl } : undefined;
  switch (agent) {
    case "hermes":
      return { command: "npx", args: serverArgs(compact), ...(env ? { env } : {}) };
    case "openclaw":
      return { command: "npx", args: serverArgs(compact), transport: "stdio", ...(env ? { env } : {}) };
    case "copilot":
      return {
        type: "stdio",
        command: "npx",
        args: serverArgs(compact),
        env: env ?? {},
        tools: ["*"],
      };
  }
}

/** Merge into Hermes' YAML via the document API so user comments survive. */
function mergeHermesYaml(existing: string, entry: Record<string, unknown>): string {
  const doc = existing.trim() ? parseDocument(existing) : new Document({});
  if (doc.errors?.length) {
    throw new Error(
      `~/.hermes/config.yaml did not parse as YAML (${doc.errors[0].message}); fix it or pass --dry-run and merge manually.`,
    );
  }
  doc.setIn(["mcp_servers", "comfyui"], doc.createNode(entry));
  return doc.toString();
}

function mergeJson(existing: string, entry: Record<string, unknown>, file: string): string {
  let root: Record<string, unknown> = {};
  if (existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      throw new Error(
        `${file} did not parse as JSON (${err instanceof Error ? err.message : err}); fix it or pass --dry-run and merge manually.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object; fix it or pass --dry-run and merge manually.`);
    }
    root = parsed as Record<string, unknown>;
  }
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  servers.comfyui = entry;
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function nextSteps(agent: AgentName, compact: boolean): string[] {
  const compactNote = compact
    ? "Compact tool mode is ON: the model gets list_tools/describe_tool/call_tool instead of ~200 schemas (rerun with --full for the complete surface)."
    : "Full tool mode: ~200 tool schemas — right for frontier models (rerun with --compact for small/local models).";
  switch (agent) {
    case "hermes":
      return [
        "In a running Hermes session type /reload-mcp (or restart Hermes).",
        "Tools appear as mcp_comfyui_list_tools / _describe_tool / _call_tool.",
        "Local models: gemma4 (e4b or larger), qwen3, llama3.1+ have native tool calling; gemma3 does not.",
        compactNote,
      ];
    case "openclaw":
      return [
        "Restart the OpenClaw gateway to pick up the new server.",
        "Local models: gemma4 (e4b or larger), qwen3, llama3.1+ have native tool calling; gemma3 does not.",
        compactNote,
      ];
    case "copilot":
      return [
        "Run `copilot` and check the server with /mcp show.",
        compactNote,
      ];
  }
}

export async function setupAgent(opts: SetupOptions): Promise<SetupResult> {
  const compact = opts.compact ?? defaultCompact(opts.agent);
  const configPath = opts.configPath ?? defaultConfigPath(opts.agent);
  const entry = buildEntry(opts.agent, compact, opts.comfyuiUrl);

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    // no config yet — we create it
  }

  const content =
    opts.agent === "hermes"
      ? mergeHermesYaml(existing, entry)
      : mergeJson(existing, entry, configPath);

  if (!opts.dryRun) {
    await fs.mkdir(dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content, "utf8");
  }

  return {
    agent: opts.agent,
    configPath,
    compact,
    content,
    wrote: !opts.dryRun,
    nextSteps: nextSteps(opts.agent, compact),
  };
}
