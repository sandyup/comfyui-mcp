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
//   ComfyUI-Manager   = "https://github.com/ltdrdata/ComfyUI-Manager"
//                       (cloned into ComfyUI/custom_nodes/comfyui-manager)
// ---------------------------------------------------------------------------

export const COMFYUI_REPO_URL = "https://github.com/comfyanonymous/ComfyUI";
export const COMFYUI_MANAGER_REPO_URL =
  "https://github.com/ltdrdata/ComfyUI-Manager";
/** Sub-path under the ComfyUI clone where the Manager must live. */
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
  comfyuiUrl: string;
  managerUrl: string | null;
  managerInstalled: boolean;
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

/** Build the pip/uv install argv for a requirements file. */
export function buildPipInstallArgs(
  installer: "uv" | "pip",
  requirementsFile: string,
): { cmd: string; args: string[] } {
  if (installer === "uv") {
    return { cmd: "uv", args: ["pip", "install", "-r", requirementsFile] };
  }
  // Use the active interpreter's pip to avoid PATH ambiguity.
  return {
    cmd: IS_WIN ? "python" : "python3",
    args: ["-m", "pip", "install", "-r", requirementsFile],
  };
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

  // Ensure the parent of targetPath exists (clone creates targetPath itself).
  // mkdirp on the target is harmless when empty; git clone into an empty dir is fine.
  deps.mkdirp(targetPath);

  // --- 1. Clone ComfyUI ---
  // If version looks like an arbitrary commit we still clone the default branch
  // and `git checkout` after; using -b for a commit fails. We treat any
  // provided version as a branch/tag for the -b fast path, then verify with a
  // checkout step so commits and tags both work.
  logger.info(`Cloning ComfyUI into ${targetPath}`, { version: version ?? "HEAD" });
  record(
    "clone_comfyui",
    "git",
    buildCloneArgs(COMFYUI_REPO_URL, targetPath, undefined),
  );

  // --- 2. Optional checkout of a specific ref (tag/branch/commit) ---
  let resolvedVersion: string | null = null;
  if (version) {
    // `--end-of-options` stops flag parsing so a ref starting with "-" is
    // treated as a revision, never a git flag (option-injection guard).
    // (Distinct from `--`, which would make the arg a *pathspec*.)
    record("checkout_version", "git", [
      "-C",
      targetPath,
      "checkout",
      "--end-of-options",
      version,
    ]);
    resolvedVersion = version;
  }

  // --- 3. Optional ComfyUI-Manager clone ---
  let managerInstalled = false;
  if (!skipManager) {
    const managerDest = join(targetPath, MANAGER_SUBDIR);
    logger.info(`Cloning ComfyUI-Manager into ${managerDest}`);
    record(
      "clone_manager",
      "git",
      buildCloneArgs(COMFYUI_MANAGER_REPO_URL, managerDest, undefined),
    );
    managerInstalled = true;
  }

  // --- 4. Install ComfyUI Python requirements ---
  const requirements = join(targetPath, "requirements.txt");
  const { cmd: pipCmd, args: pipArgs } = buildPipInstallArgs(
    installer,
    requirements,
  );
  logger.info(`Installing ComfyUI requirements via ${installer}`);
  record("install_requirements", pipCmd, pipArgs, targetPath);

  // --- 5. Install Manager requirements if present ---
  // comfy-cli installs the manager's deps from manager_requirements.txt at the
  // ComfyUI root when present; fall back to the manager's own requirements.txt.
  if (managerInstalled) {
    const managerReqRoot = join(targetPath, "manager_requirements.txt");
    const managerReqLocal = join(
      targetPath,
      MANAGER_SUBDIR,
      "requirements.txt",
    );
    let managerReqFile: string | null = null;
    if (deps.existsSync(managerReqRoot)) managerReqFile = managerReqRoot;
    else if (deps.existsSync(managerReqLocal)) managerReqFile = managerReqLocal;

    if (managerReqFile) {
      const { cmd, args } = buildPipInstallArgs(installer, managerReqFile);
      logger.info(`Installing ComfyUI-Manager requirements via ${installer}`);
      record("install_manager_requirements", cmd, args, targetPath);
    } else {
      logger.info(
        "No ComfyUI-Manager requirements file found — skipping manager dep install.",
      );
    }
  }

  return {
    installed: true,
    targetPath,
    comfyuiUrl: COMFYUI_REPO_URL,
    managerUrl: managerInstalled ? COMFYUI_MANAGER_REPO_URL : null,
    managerInstalled,
    version: resolvedVersion,
    pythonInstaller: installer,
    steps,
    message:
      `ComfyUI installed at ${targetPath}` +
      (managerInstalled ? " (with ComfyUI-Manager)" : "") +
      ` using ${installer}.`,
  };
}
