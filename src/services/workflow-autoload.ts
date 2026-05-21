import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { z, type ZodTypeAny } from "zod";
import type { WorkflowJSON } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export type PlaceholderType = "string" | "int" | "float" | "bool";

export interface Placeholder {
  name: string;
  type: PlaceholderType;
  nodeId: string;
  inputName: string;
}

const PROMPT_TOKEN = "PARAM_PROMPT";
const TYPED_RE = /^PARAM_(INT|FLOAT|STRING|BOOL)_([A-Z][A-Z0-9_]*)$/;

/**
 * Scan a workflow JSON for PARAM_* placeholders and return a list of
 * (name, type, nodeId, inputName) entries — one per *site*, so duplicates
 * across nodes are preserved (applyParams fills every site).
 */
export function parsePlaceholders(workflow: WorkflowJSON): Placeholder[] {
  const placeholders: Placeholder[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node.inputs) continue;
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string") continue;
      if (value === PROMPT_TOKEN) {
        placeholders.push({ name: "prompt", type: "string", nodeId, inputName });
        continue;
      }
      const match = TYPED_RE.exec(value);
      if (!match) continue;
      const [, kind, rawName] = match;
      const type: PlaceholderType =
        kind === "INT" ? "int" : kind === "FLOAT" ? "float" : kind === "BOOL" ? "bool" : "string";
      placeholders.push({
        name: rawName.toLowerCase(),
        type,
        nodeId,
        inputName,
      });
    }
  }
  return placeholders;
}

function zodForType(type: PlaceholderType): ZodTypeAny {
  switch (type) {
    case "int":
      return z.coerce.number().int();
    case "float":
      return z.coerce.number();
    case "bool":
      return z.coerce.boolean();
    case "string":
      return z.string();
  }
}

/**
 * Build a Zod shape object keyed by unique placeholder name. All placeholders
 * are required for v1 — to expose a default, edit the workflow JSON to use a
 * real value instead of a PARAM_* token.
 */
export function buildToolSchema(placeholders: Placeholder[]): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const p of placeholders) {
    if (!(p.name in shape)) {
      shape[p.name] = zodForType(p.type);
    }
  }
  return shape;
}

/**
 * Replace every PARAM_* placeholder in `workflow` with values from `params`.
 * Throws ValidationError if a required name is missing. Returns a new workflow
 * (does not mutate input).
 */
export function applyParams(
  workflow: WorkflowJSON,
  placeholders: Placeholder[],
  params: Record<string, unknown>,
): WorkflowJSON {
  const next = JSON.parse(JSON.stringify(workflow)) as WorkflowJSON;
  const needed = new Set(placeholders.map((p) => p.name));
  for (const name of needed) {
    if (!(name in params) || params[name] === undefined) {
      throw new ValidationError(`Missing required param: ${name}`);
    }
  }
  for (const p of placeholders) {
    const node = next[p.nodeId];
    if (!node) continue;
    const raw = params[p.name];
    const coerced = coerce(raw, p.type, p.name);
    node.inputs[p.inputName] = coerced;
  }
  return next;
}

function coerce(value: unknown, type: PlaceholderType, name: string): unknown {
  switch (type) {
    case "int": {
      const n = typeof value === "string" ? Number(value) : (value as number);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ValidationError(`Param "${name}" must be an integer, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case "float": {
      const n = typeof value === "string" ? Number(value) : (value as number);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Param "${name}" must be a number, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case "bool":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new ValidationError(`Param "${name}" must be a boolean`);
    case "string":
      return String(value);
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────

export interface DiscoveredWorkflow {
  toolName: string;
  filePath: string;
  workflow: WorkflowJSON;
  placeholders: Placeholder[];
}

export function getWorkflowsDir(): string {
  return process.env.COMFYUI_WORKFLOWS_DIR ?? join(homedir(), ".comfyui-mcp", "workflows");
}

function slugify(filename: string): string {
  const base = basename(filename, extname(filename));
  return base.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/**
 * Discover all *.json files in the configured workflows directory. Invalid
 * JSON files are logged and skipped, never thrown — startup must remain
 * resilient to bad user-managed files.
 */
export async function discoverWorkflows(dir = getWorkflowsDir()): Promise<DiscoveredWorkflow[]> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    logger.warn("Failed to read workflows directory", {
      dir,
      error: err instanceof Error ? err.message : err,
    });
    return [];
  }

  const discovered: DiscoveredWorkflow[] = [];
  const seenNames = new Set<string>();

  for (const file of entries) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as WorkflowJSON;
      const placeholders = parsePlaceholders(parsed);
      let toolName = slugify(file);
      if (seenNames.has(toolName)) {
        logger.warn("Duplicate workflow tool name, skipping", { toolName, filePath });
        continue;
      }
      seenNames.add(toolName);
      discovered.push({ toolName, filePath, workflow: parsed, placeholders });
    } catch (err) {
      logger.warn("Failed to load workflow JSON, skipping", {
        filePath,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
  return discovered;
}
