import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Canonical URLs — verified against Comfy-Org/comfy-cli constants.py
//   COMFY_GITHUB_URL = "https://github.com/comfyanonymous/ComfyUI"
// Current comfy-cli installs ComfyUI-Manager via `manager_requirements.txt`
// (recent ComfyUI ships it); a git clone is the fallback for older workspaces.
// The canonical Manager repo now lives under Comfy-Org (ltdrdata redirects).
// ---------------------------------------------------------------------------

export const COMFYUI_REPO_URL = "https://github.com/comfyanonymous/ComfyUI";
export const COMFYUI_MANAGER_REPO_URL =
  "https://github.com/Comfy-Org/ComfyUI-Manager";
/** Sub-path under the ComfyUI clone where the Manager lives (clone fallback). */
export const MANAGER_SUBDIR = join("custom_nodes", "comfyui-manager");

const IS_WIN = platform() === "win32";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallComfyUIOptions {
  /** Target workspace directory to install ComfyUI into. */
  targetPath: string;
  /** Skip cloning ComfyUI-Manager. Default false (Manager is installed). */
  skipManager?: boolean;
  /** Prefer `uv pip` over plain `pip` when uv is available. Default false. */
  useUv?: boolean;
  /**
   * ComfyUI git ref to check out (tag, branch, or commit). When omitted the
   * default branch HEAD is used.
   */
  version?: string;
}

export interface StepResult {
  step: string;
  command: string;
  ok: boolean;
  output?: string;
}

export interface InstallComfyUIResult {
  installed: boolean;
  targetPath: string;
  /** Path to the workspace virtualenv python that deps were installed into. */
  venvPath: string;
  comfyuiUrl: string;
  managerUrl: string | null;
  managerInstalled: boolean;
  /** How the Manager was installed: pip "requirements", "git-clone", or null. */
  managerVia: "requirements" | "git-clone" | null;
  version: string | null;
  pythonInstaller: "uv" | "pip";
  steps: StepResult[];
  message: string;
}

// ---------------------------------------------------------------------------
// Seams — overridable for testing without touching real git/pip/fs.
// ---------------------------------------------------------------------------

export interface InstallDeps {
  /** Run a command, throwing on non-zero exit. Returns combined stdout. */
  run: (cmd: string, args: string[], cwd?: string) => string;
  /** Detect whether a CLI tool is on PATH. */
  hasCommand: (cmd: string) => boolean;
  existsSync: (p: string) => boolean;
  /** True if the path exists AND contains at least one entry. */
  isNonEmptyDir: (p: string) => boolean;
  mkdirp: (p: string) => void;
}

function defaultRun(cmd: string, args: string[], cwd?: string): string {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    // Merge: capture both streams; surface them on failure.
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.error) {
    throw new ProcessControlError(
      `Failed to execute ${cmd}: ${result.error.message}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (result.status !== 0) {
    throw new ProcessControlError(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n${combined}`,
    );
  }

  return combined;
}

function defaultHasCommand(cmd: string): boolean {
  try {
    const probe = IS_WIN ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(probe, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function defaultIsNonEmptyDir(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    if (!st.isDirectory()) {
      // A file occupying the target path is also a conflict.
      return true;
    }
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

const defaultDeps: InstallDeps = {
  run: defaultRun,
  hasCommand: defaultHasCommand,
  existsSync,
  isNonEmptyDir: defaultIsNonEmptyDir,
  mkdirp: (p: string) => {
    mkdirSync(p, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// Command builders — pure, so tests can assert on them directly.
// ---------------------------------------------------------------------------

/** Build the `git clone` argv (without the leading `git`). */
export function buildCloneArgs(
  url: string,
  dest: string,
  version?: string,
): string[] {
  const args = ["clone"];
  // For branches/tags we can clone directly with -b. For arbitrary commits a
  // checkout after clone is required, handled separately by the caller.
  if (version) {
    args.push("--branch", version);
  }
  args.push(url, dest);
  return args;
}

/** Path to the workspace venv's python interpreter. */
export function venvPythonPath(targetPath: string): string {
  return IS_WIN
    ? join(targetPath, ".venv", "Scripts", "python.exe")
    : join(targetPath, ".venv", "bin", "python");
}

/** Build the argv that creates the workspace venv (`<target>/.venv`). */
export function buildVenvArgs(
  installer: "uv" | "pip",
  targetPath: string,
): { cmd: string; args: string[] } {
  const venvDir = join(targetPath, ".venv");
  if (installer === "uv") {
    return { cmd: "uv", args: ["venv", venvDir] };
  }
  return { cmd: IS_WIN ? "python" : "python3", args: ["-m", "venv", venvDir] };
}

/**
 * Build the pip/uv install argv for a requirements file, ALWAYS targeting the
 * workspace venv's interpreter (`venvPython`) — never the Python running this
 * MCP server. uv targets the venv explicitly via `--python`.
 */
export function buildPipInstallArgs(
  installer: "uv" | "pip",
  venvPython: string,
  requirementsFile: string,
): { cmd: string; args: string[] } {
  if (installer === "uv") {
    return {
      cmd: "uv",
      args: ["pip", "install", "--python", venvPython, "-r", requirementsFile],
    };
  }
  return {
    cmd: venvPython,
    args: ["-m", "pip", "install", "-r", requirementsFile],
  };
}

/**
 * Validate the requested ComfyUI version, mirroring comfy-cli's
 * `validate_version`: only "nightly", "latest", or a full semantic version
 * (optionally v-prefixed). Raw git refs / branch names are rejected.
 */
export function validateVersion(
  version: string,
): { kind: "nightly" } | { kind: "latest" } | { kind: "semver"; tag: string } {
  const v = version.trim();
  const lower = v.toLowerCase();
  if (lower === "nightly") return { kind: "nightly" };
  if (lower === "latest") return { kind: "latest" };
  const sem = v.replace(/^v/i, "");
  if (/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(sem)) {
    return { kind: "semver", tag: `v${sem}` };
  }
  throw new ValidationError(
    `Invalid version "${version}". Use "nightly", "latest", or a semantic ` +
      `version like "0.3.40" (raw git refs/branches are not accepted).`,
  );
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Mirrors `comfy-cli install`: clones ComfyUI (and optionally ComfyUI-Manager)
 * into a target workspace, then installs Python requirements via pip or uv.
 *
 * This is a LOCAL, subprocess-only operation. It never touches a remote
 * ComfyUI server and ignores `config.comfyuiPath` in favour of the explicit
 * `targetPath`.
 */
export function installComfyUI(
  options: InstallComfyUIOptions,
  deps: InstallDeps = defaultDeps,
): InstallComfyUIResult {
  const { skipManager = false, useUv = false, version } = options;

  if (!options.targetPath || options.targetPath.trim() === "") {
    throw new ValidationError("targetPath is required and cannot be empty.");
  }

  const targetPath = resolve(options.targetPath);

  // --- Validate target: must be empty or non-existent. Never clobber. ---
  if (deps.isNonEmptyDir(targetPath)) {
    throw new ValidationError(
      `Target path is not empty: ${targetPath}. Refusing to overwrite an existing install. ` +
        `Choose an empty or non-existent directory.`,
    );
  }

  // --- Verify git is available. ---
  if (!deps.hasCommand("git")) {
    throw new ProcessControlError(
      "git was not found on PATH. Install git before running install_comfyui.",
    );
  }

  // --- Select Python installer (uv preferred only when requested AND present). ---
  const installer: "uv" | "pip" =
    useUv && deps.hasCommand("uv") ? "uv" : "pip";
  if (useUv && installer === "pip") {
    logger.warn("use_uv requested but uv not found on PATH — falling back to pip.");
  }

  const steps: StepResult[] = [];
  const record = (
    step: string,
    cmd: string,
    args: string[],
    cwd?: string,
  ): string => {
    const command = `${cmd} ${args.join(" ")}`;
    try {
      const output = deps.run(cmd, args, cwd);
      steps.push({ step, command, ok: true, output });
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ step, command, ok: false, output: msg });
      throw err;
    }
  };

  // git clone creates targetPath itself; mkdirp on an empty target is harmless.
  deps.mkdirp(targetPath);

  // --- 1. Clone ComfyUI (default branch; a version is checked out next). ---
  logger.info(`Cloning ComfyUI into ${targetPath}`, { version: version ?? "HEAD" });
  record("clone_comfyui", "git", buildCloneArgs(COMFYUI_REPO_URL, targetPath));

  // --- 2. Resolve & check out the requested version (comfy-cli semantics). ---
  let resolvedVersion: string | null = null;
  if (version) {
    const v = validateVersion(version); // throws on a raw ref / invalid form
    if (v.kind === "nightly") {
      // Track the default branch HEAD — nothing to check out.
      resolvedVersion = "nightly";
    } else if (v.kind === "latest") {
      const tag = record("resolve_latest_tag", "git", [
        "-C",
        targetPath,
        "describe",
        "--tags",
        "--abbrev=0",
      ]).trim();
      if (tag) {
        record("checkout_version", "git", [
          "-C",
          targetPath,
          "checkout",
          "--end-of-options",
          tag,
        ]);
        resolvedVersion = tag;
      } else {
        resolvedVersion = "latest";
      }
    } else {
      // --end-of-options keeps a "-"-prefixed ref from being read as a flag.
      record("checkout_version", "git", [
        "-C",
        targetPath,
        "checkout",
        "--end-of-options",
        v.tag,
      ]);
      resolvedVersion = v.tag;
    }
  }

  // --- 3. Create the workspace virtualenv. Dependencies install into THIS
  //         interpreter, never the Python running this MCP server. ---
  const venvPython = venvPythonPath(targetPath);
  {
    const { cmd, args } = buildVenvArgs(installer, targetPath);
    logger.info(`Creating workspace venv at ${join(targetPath, ".venv")}`);
    record("create_venv", cmd, args, targetPath);
  }

  // --- 4. Install ComfyUI Python requirements into the workspace venv. ---
  {
    const requirements = join(targetPath, "requirements.txt");
    const { cmd, args } = buildPipInstallArgs(installer, venvPython, requirements);
    logger.info(`Installing ComfyUI requirements via ${installer} into the workspace venv`);
    record("install_requirements", cmd, args, targetPath);
  }

  // --- 5. Install ComfyUI-Manager. Current comfy-cli pip-installs it from
  //         manager_requirements.txt; fall back to a git clone for older
  //         workspaces that don't ship that file. ---
  let managerInstalled = false;
  let managerVia: "requirements" | "git-clone" | null = null;
  let managerUrl: string | null = null;
  if (!skipManager) {
    const managerReqRoot = join(targetPath, "manager_requirements.txt");
    if (deps.existsSync(managerReqRoot)) {
      const { cmd, args } = buildPipInstallArgs(installer, venvPython, managerReqRoot);
      logger.info("Installing ComfyUI-Manager via manager_requirements.txt");
      record("install_manager_requirements", cmd, args, targetPath);
      managerInstalled = true;
      managerVia = "requirements";
    } else {
      const managerDest = join(targetPath, MANAGER_SUBDIR);
      logger.info(`Cloning ComfyUI-Manager into ${managerDest} (legacy fallback)`);
      record("clone_manager", "git", buildCloneArgs(COMFYUI_MANAGER_REPO_URL, managerDest));
      managerUrl = COMFYUI_MANAGER_REPO_URL;
      const managerReqLocal = join(targetPath, MANAGER_SUBDIR, "requirements.txt");
      if (deps.existsSync(managerReqLocal)) {
        const { cmd, args } = buildPipInstallArgs(installer, venvPython, managerReqLocal);
        record("install_manager_requirements", cmd, args, targetPath);
      }
      managerInstalled = true;
      managerVia = "git-clone";
    }
  }

  return {
    installed: true,
    targetPath,
    venvPath: venvPython,
    comfyuiUrl: COMFYUI_REPO_URL,
    managerUrl,
    managerInstalled,
    managerVia,
    version: resolvedVersion,
    pythonInstaller: installer,
    steps,
    message:
      `ComfyUI installed at ${targetPath} (deps in ${join(targetPath, ".venv")})` +
      (managerInstalled ? ` with ComfyUI-Manager (via ${managerVia})` : "") +
      ` using ${installer}.`,
  };
}
