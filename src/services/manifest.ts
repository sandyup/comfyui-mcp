import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config } from "../config.js";
import {
  installCustomNode,
  listInstalledNodes,
  type InstalledNode,
} from "./node-management.js";
import {
  downloadModel,
  MODEL_SUBDIRS,
  type ModelType,
} from "./model-resolver.js";
import { ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const IS_WIN = platform() === "win32";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const YAML_MAX_ALIAS_COUNT = 50;
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/;
const WHITESPACE_RE = /\s/;

const modelTypeSchema = z.enum(MODEL_SUBDIRS);

export const manifestSchema = z
  .object({
    apt: z.array(z.string().min(1)).optional().default([]),
    pip: z.array(z.string().min(1)).optional().default([]),
    custom_nodes: z.array(z.string().min(1)).optional().default([]),
    models: z
      .array(
        z
          .object({
            url: z.string().url(),
            model_type: modelTypeSchema.optional(),
            filename: z.string().min(1).optional(),
            local_path: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
  })
  .strict();

export type ComfyManifest = z.infer<typeof manifestSchema>;

export interface ApplyManifestOptions {
  manifest?: unknown;
  path?: string;
}

export type ManifestAction =
  | "apt"
  | "pip"
  | "custom_node"
  | "model";

export type ManifestItemStatus = "applied" | "skipped" | "failed";

export interface ManifestItemReport {
  item: string;
  action: ManifestAction;
  status: ManifestItemStatus;
  message: string;
}

export interface ApplyManifestResult {
  success: boolean;
  summary: Record<ManifestItemStatus, number>;
  results: ManifestItemReport[];
}

function requireComfyUIPath(): string {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      "apply_manifest requires a local ComfyUI install. It installs Python packages, " +
        "custom nodes, and models on the local filesystem, so it is unavailable in " +
        "remote --comfyui-url / COMFYUI_URL mode. Set COMFYUI_PATH to enable it.",
    );
  }
  return config.comfyuiPath;
}

function parseManifestText(path: string, text: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(text, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
  }
  throw new ValidationError(
    `Unsupported manifest file extension "${ext || "(none)"}". Use .json, .yaml, or .yml.`,
  );
}

export async function loadManifestFile(path: string): Promise<ComfyManifest> {
  const info = await stat(path);
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new ValidationError(
      `Manifest file is too large (${info.size} bytes). Maximum is ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }
  const text = await readFile(path, "utf-8");
  const raw = parseManifestText(path, text);
  return manifestSchema.parse(raw);
}

async function resolveManifest(opts: ApplyManifestOptions): Promise<ComfyManifest> {
  const hasInline = opts.manifest !== undefined;
  const hasPath = opts.path !== undefined && opts.path.trim().length > 0;
  if (hasInline === hasPath) {
    throw new ValidationError(
      "Provide exactly one of `manifest` or `path` to apply_manifest.",
    );
  }
  if (hasInline) return manifestSchema.parse(opts.manifest);
  return loadManifestFile(opts.path!);
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(IS_WIN ? "where" : cmd, IS_WIN ? [cmd] : ["--version"], {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 5000,
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspacePython(comfyuiPath: string): string {
  if (process.env.COMFYUI_PYTHON) return process.env.COMFYUI_PYTHON;
  for (const venv of [".venv", "venv"]) {
    const py = IS_WIN
      ? join(comfyuiPath, venv, "Scripts", "python.exe")
      : join(comfyuiPath, venv, "bin", "python");
    if (existsSync(py)) return py;
  }
  return IS_WIN ? "python" : "python3";
}

function validatePipPackageSpec(pkg: string): void {
  if (pkg.startsWith("-")) {
    throw new ValidationError(`Manifest pip entry must be a package spec, not an option: ${pkg}`);
  }
  if (ASCII_CONTROL_RE.test(pkg)) {
    throw new ValidationError("Manifest pip entry cannot contain ASCII control characters.");
  }
  if (WHITESPACE_RE.test(pkg)) {
    throw new ValidationError(`Manifest pip entry cannot contain whitespace: ${pkg}`);
  }
}

function installPipPackage(pkg: string, comfyuiPath: string): string {
  validatePipPackageSpec(pkg);
  const python = resolveWorkspacePython(comfyuiPath);
  const useUv = commandExists("uv");
  const cmd = useUv ? "uv" : python;
  const args = useUv
    ? ["pip", "install", "--python", python, pkg]
    : ["-m", "pip", "install", pkg];

  logger.info("Installing manifest Python package", {
    package: pkg,
    installer: useUv ? "uv" : "pip",
  });

  const out = execFileSync(cmd, args, {
    cwd: comfyuiPath,
    encoding: "utf-8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (out ?? "").trim();
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function maybeGitModuleName(value: string): string | undefined {
  if (!/^(https?:\/\/|git@|git\+)/i.test(value) && !value.endsWith(".git")) {
    return undefined;
  }
  const withoutRef = value.replace(/(?<!^)@[^@/]+$/, "");
  const stripped = withoutRef.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const pathPart = stripped.includes(":") && !stripped.includes("://")
    ? stripped.slice(stripped.lastIndexOf(":") + 1)
    : stripped;
  return basename(pathPart).replace(/\.git$/i, "").toLowerCase();
}

function nodeAlreadyInstalled(id: string, installed: InstalledNode[]): boolean {
  const wanted = normalizeId(id);
  const gitModule = maybeGitModuleName(id);
  return installed.some((node) => {
    const candidates = [
      node.module,
      node.cnrId,
      node.auxId,
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeId);
    return candidates.includes(wanted) || (gitModule ? candidates.includes(gitModule) : false);
  });
}

function modelsRoot(comfyuiPath: string): string {
  return join(comfyuiPath, "models");
}

function defaultFilenameForUrl(url: string): string {
  return basename(new URL(url).pathname) || "model.safetensors";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function rejectEscapingSymlinkTarget(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return;
    const realTarget = await realpath(path);
    if (!isWithinRoot(root, realTarget)) {
      throw new ValidationError(`${label} escapes the models directory: ${path}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Missing final target is fine; downloadModel will create it.
  }
}

async function validateExistingModelAncestors(
  root: string,
  parent: string,
  realRoot: string,
  localPath: string,
): Promise<void> {
  let cursor = parent;
  while (cursor !== root && cursor.startsWith(root + sep)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const realCursor = await realpath(cursor);
        if (!isWithinRoot(realRoot, realCursor)) {
          throw new ValidationError(
            `Model local_path escapes the models directory: ${localPath}`,
          );
        }
      } else if (!info.isDirectory()) {
        throw new ValidationError(`Model local_path parent is not a directory: ${localPath}`);
      }
      return;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      cursor = dirname(cursor);
    }
  }
}

async function resolveLocalModelPath(
  comfyuiPath: string,
  model: ComfyManifest["models"][number],
): Promise<{ targetSubfolder: string; filename: string; targetPath: string }> {
  const root = resolve(modelsRoot(comfyuiPath));

  if (model.local_path) {
    if (isAbsolute(model.local_path)) {
      throw new ValidationError(
        `Model local_path must be relative to models/: ${model.local_path}`,
      );
    }
    const targetPath = resolve(root, model.local_path);
    const rel = relative(root, targetPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    if (!targetPath.startsWith(root + sep)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    const filename = basename(targetPath);
    if (filename === "." || filename === ".." || filename.length === 0) {
      throw new ValidationError(`Model local_path must include a filename: ${model.local_path}`);
    }
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    await validateExistingModelAncestors(root, dirname(targetPath), realRoot, model.local_path);
    await mkdir(dirname(targetPath), { recursive: true });
    const realParent = await realpath(dirname(targetPath));
    if (!isWithinRoot(realRoot, realParent)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    await rejectEscapingSymlinkTarget(realRoot, targetPath, "Model local_path");
    return {
      targetSubfolder: dirname(rel),
      filename,
      targetPath,
    };
  }

  const targetSubfolder: ModelType = model.model_type ?? "checkpoints";
  const filename = model.filename ?? defaultFilenameForUrl(model.url);
  return {
    targetSubfolder,
    filename,
    targetPath: join(root, targetSubfolder, filename),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function report(
  action: ManifestAction,
  item: string,
  status: ManifestItemStatus,
  message: string,
): ManifestItemReport {
  return { action, item, status, message };
}

async function installedNodesOrEmpty(): Promise<InstalledNode[]> {
  try {
    return await listInstalledNodes();
  } catch (err) {
    logger.warn("Could not list installed custom nodes before manifest apply", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function applyManifest(
  opts: ApplyManifestOptions,
): Promise<ApplyManifestResult> {
  const comfyuiPath = requireComfyUIPath();
  const manifest = await resolveManifest(opts);
  const results: ManifestItemReport[] = [];

  for (const pkg of manifest.apt) {
    results.push(
      report(
        "apt",
        pkg,
        "skipped",
        "System packages must be installed manually or with root privileges; apply_manifest does not run apt.",
      ),
    );
  }

  for (const pkg of manifest.pip) {
    try {
      installPipPackage(pkg, comfyuiPath);
      results.push(report("pip", pkg, "applied", "Python package installed."));
    } catch (err) {
      results.push(
        report(
          "pip",
          pkg,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  const installedNodes = await installedNodesOrEmpty();
  for (const id of manifest.custom_nodes) {
    if (nodeAlreadyInstalled(id, installedNodes)) {
      results.push(report("custom_node", id, "skipped", "Custom node is already installed."));
      continue;
    }
    try {
      const res = await installCustomNode({ id });
      installedNodes.push({
        module: maybeGitModuleName(id) ?? id,
        enabled: true,
      });
      results.push(report("custom_node", id, "applied", res.message));
    } catch (err) {
      results.push(
        report(
          "custom_node",
          id,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  for (const model of manifest.models) {
    const item = model.local_path ?? model.filename ?? model.url;
    try {
      const target = await resolveLocalModelPath(comfyuiPath, model);
      if (await fileExists(target.targetPath)) {
        results.push(report("model", item, "skipped", `Model already exists at ${target.targetPath}.`));
        continue;
      }
      const saved = await downloadModel(model.url, target.targetSubfolder, target.filename);
      results.push(report("model", item, "applied", `Model downloaded to ${saved}.`));
    } catch (err) {
      results.push(
        report(
          "model",
          item,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  const summary: Record<ManifestItemStatus, number> = {
    applied: 0,
    skipped: 0,
    failed: 0,
  };
  for (const result of results) summary[result.status]++;

  return {
    success: summary.failed === 0,
    summary,
    results,
  };
}
