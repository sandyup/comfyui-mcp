import { describe, expect, it, vi } from "vitest";

// Mock node:child_process and node:fs so NO real git/pip/clone/disk access runs,
// even if the default deps path is exercised.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

import {
  installComfyUI,
  buildCloneArgs,
  buildPipInstallArgs,
  validateVersion,
  COMFYUI_REPO_URL,
  COMFYUI_MANAGER_REPO_URL,
  MANAGER_SUBDIR,
  type InstallDeps,
} from "../../services/install-comfyui.js";
import { ValidationError, ProcessControlError } from "../../utils/errors.js";

interface RunCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Build a controllable fake dependency set for installComfyUI. */
function makeDeps(overrides: Partial<InstallDeps> = {}): {
  deps: InstallDeps;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const deps: InstallDeps = {
    run: vi.fn((cmd: string, args: string[], cwd?: string) => {
      calls.push({ cmd, args, cwd });
      return "ok";
    }),
    hasCommand: vi.fn(() => true),
    existsSync: vi.fn(() => false),
    isNonEmptyDir: vi.fn(() => false),
    mkdirp: vi.fn(),
    ...overrides,
  };
  return { deps, calls };
}

describe("buildCloneArgs", () => {
  it("clones without a branch when no version given", () => {
    expect(buildCloneArgs(COMFYUI_REPO_URL, "/dest")).toEqual([
      "clone",
      COMFYUI_REPO_URL,
      "/dest",
    ]);
  });

  it("includes -b/--branch when a version is given", () => {
    expect(buildCloneArgs(COMFYUI_REPO_URL, "/dest", "v0.3.0")).toEqual([
      "clone",
      "--branch",
      "v0.3.0",
      COMFYUI_REPO_URL,
      "/dest",
    ]);
  });
});

describe("buildPipInstallArgs", () => {
  const venvPy = "/ws/comfy/.venv/bin/python";

  it("targets the workspace venv via uv --python", () => {
    expect(buildPipInstallArgs("uv", venvPy, "/c/requirements.txt")).toEqual({
      cmd: "uv",
      args: ["pip", "install", "--python", venvPy, "-r", "/c/requirements.txt"],
    });
  });

  it("runs the venv python's own pip (never the server's python)", () => {
    const { cmd, args } = buildPipInstallArgs("pip", venvPy, "/c/requirements.txt");
    expect(cmd).toBe(venvPy);
    expect(args).toEqual(["-m", "pip", "install", "-r", "/c/requirements.txt"]);
  });
});

describe("validateVersion", () => {
  it("accepts nightly/latest/semver and rejects raw refs", () => {
    expect(validateVersion("nightly")).toEqual({ kind: "nightly" });
    expect(validateVersion("latest")).toEqual({ kind: "latest" });
    expect(validateVersion("0.3.40")).toEqual({ kind: "semver", tag: "v0.3.40" });
    expect(validateVersion("v0.3.40")).toEqual({ kind: "semver", tag: "v0.3.40" });
    expect(() => validateVersion("main")).toThrow(ValidationError);
    expect(() => validateVersion("0.3.x")).toThrow(ValidationError);
    expect(() => validateVersion("--evil")).toThrow(ValidationError);
  });
});

describe("installComfyUI — validation", () => {
  it("rejects empty target path", () => {
    const { deps } = makeDeps();
    expect(() => installComfyUI({ targetPath: "  " }, deps)).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-empty target directory (never clobbers)", () => {
    const { deps, calls } = makeDeps({ isNonEmptyDir: vi.fn(() => true) });
    expect(() => installComfyUI({ targetPath: "/existing" }, deps)).toThrow(
      /not empty/i,
    );
    // No git/pip ran.
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when git is not on PATH", () => {
    const { deps } = makeDeps({
      hasCommand: vi.fn((c: string) => c !== "git"),
    });
    expect(() => installComfyUI({ targetPath: "/empty" }, deps)).toThrow(
      /git was not found/i,
    );
  });
});

describe("installComfyUI — command construction", () => {
  it("clones ComfyUI and Manager with canonical URLs and installs requirements", () => {
    const { deps, calls } = makeDeps();
    const result = installComfyUI({ targetPath: "/ws/comfy" }, deps);

    const cloneComfy = calls.find(
      (c) => c.cmd === "git" && c.args.includes(COMFYUI_REPO_URL),
    );
    expect(cloneComfy).toBeDefined();
    expect(cloneComfy?.args[0]).toBe("clone");

    const cloneManager = calls.find(
      (c) => c.cmd === "git" && c.args.includes(COMFYUI_MANAGER_REPO_URL),
    );
    expect(cloneManager).toBeDefined();
    // Manager destination must be under custom_nodes/comfyui-manager.
    expect(cloneManager?.args.some((a) => a.includes(MANAGER_SUBDIR))).toBe(
      true,
    );

    // requirements install ran in the target dir.
    const pipStep = calls.find((c) => c.args.includes("install"));
    expect(pipStep).toBeDefined();

    expect(result.installed).toBe(true);
    expect(result.comfyuiUrl).toBe(COMFYUI_REPO_URL);
    expect(result.managerUrl).toBe(COMFYUI_MANAGER_REPO_URL);
    expect(result.managerInstalled).toBe(true);
    expect(result.pythonInstaller).toBe("pip");
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("skips the Manager clone when skip_manager is set", () => {
    const { deps, calls } = makeDeps();
    const result = installComfyUI(
      { targetPath: "/ws/comfy", skipManager: true },
      deps,
    );

    expect(
      calls.some((c) => c.args.includes(COMFYUI_MANAGER_REPO_URL)),
    ).toBe(false);
    expect(result.managerInstalled).toBe(false);
    expect(result.managerUrl).toBeNull();
  });

  it("checks out a specific version after cloning", () => {
    const { deps, calls } = makeDeps();
    const result = installComfyUI(
      { targetPath: "/ws/comfy", version: "v0.3.10" },
      deps,
    );

    const checkout = calls.find(
      (c) => c.args.includes("checkout") && c.args.includes("v0.3.10"),
    );
    expect(checkout).toBeDefined();
    expect(checkout?.cmd).toBe("git");
    // Option-injection guard: --end-of-options must precede the ref so a
    // version starting with "-" is treated as a revision, not a flag.
    const eoo = checkout!.args.indexOf("--end-of-options");
    expect(eoo).toBeGreaterThanOrEqual(0);
    expect(checkout!.args[eoo + 1]).toBe("v0.3.10");
    expect(result.version).toBe("v0.3.10");
  });

  it("rejects raw git refs / invalid versions (comfy-cli version semantics)", () => {
    const { deps } = makeDeps();
    expect(() =>
      installComfyUI({ targetPath: "/ws/comfy", version: "--evil" }, deps),
    ).toThrow(ValidationError);
    expect(() =>
      installComfyUI({ targetPath: "/ws/comfy", version: "main" }, deps),
    ).toThrow(ValidationError);
  });

  it("nightly tracks the default branch without a checkout", () => {
    const { deps, calls } = makeDeps();
    const result = installComfyUI({ targetPath: "/ws/comfy", version: "nightly" }, deps);
    expect(calls.some((c) => c.args.includes("checkout"))).toBe(false);
    expect(result.version).toBe("nightly");
  });
});

describe("installComfyUI — uv vs pip selection", () => {
  it("uses uv when use_uv is true and uv is present", () => {
    const { deps, calls } = makeDeps({ hasCommand: vi.fn(() => true) });
    const result = installComfyUI(
      { targetPath: "/ws/comfy", useUv: true },
      deps,
    );
    expect(result.pythonInstaller).toBe("uv");
    expect(calls.some((c) => c.cmd === "uv")).toBe(true);
  });

  it("falls back to pip when use_uv is true but uv is missing", () => {
    const { deps, calls } = makeDeps({
      hasCommand: vi.fn((c: string) => c !== "uv"),
    });
    const result = installComfyUI(
      { targetPath: "/ws/comfy", useUv: true },
      deps,
    );
    expect(result.pythonInstaller).toBe("pip");
    expect(calls.some((c) => c.cmd === "uv")).toBe(false);
  });

  it("uses pip by default when use_uv is not set even if uv exists", () => {
    const { deps } = makeDeps({ hasCommand: vi.fn(() => true) });
    const result = installComfyUI({ targetPath: "/ws/comfy" }, deps);
    expect(result.pythonInstaller).toBe("pip");
  });
});

describe("installComfyUI — manager install path", () => {
  it("pip-installs manager_requirements.txt (no git clone) when it is present", () => {
    const { deps, calls } = makeDeps({
      existsSync: vi.fn((p: string) => p.endsWith("manager_requirements.txt")),
    });
    const result = installComfyUI({ targetPath: "/ws/comfy" }, deps);

    const managerReq = calls.find((c) =>
      c.args.some((a) => a.endsWith("manager_requirements.txt")),
    );
    expect(managerReq).toBeDefined();
    // Current comfy-cli path: do NOT git-clone the Manager.
    expect(calls.some((c) => c.args.includes(COMFYUI_MANAGER_REPO_URL))).toBe(false);
    expect(result.managerVia).toBe("requirements");
    expect(result.managerUrl).toBeNull();
  });

  it("falls back to a git clone of the Comfy-Org Manager when no requirements file exists", () => {
    const { deps, calls } = makeDeps(); // existsSync -> false
    const result = installComfyUI({ targetPath: "/ws/comfy" }, deps);
    expect(calls.some((c) => c.args.includes(COMFYUI_MANAGER_REPO_URL))).toBe(true);
    expect(result.managerVia).toBe("git-clone");
    expect(result.managerUrl).toBe(COMFYUI_MANAGER_REPO_URL);
  });
});

describe("installComfyUI — failure surfacing", () => {
  it("propagates subprocess failures and records the failed step", () => {
    const calls: RunCall[] = [];
    const deps = makeDeps().deps;
    deps.run = vi.fn((cmd: string, args: string[], cwd?: string) => {
      calls.push({ cmd, args, cwd });
      if (args.includes("clone")) {
        throw new ProcessControlError("Command failed (exit 128): git clone");
      }
      return "ok";
    });

    expect(() => installComfyUI({ targetPath: "/ws/comfy" }, deps)).toThrow(
      ProcessControlError,
    );
    // Clone was attempted; pip never reached.
    expect(calls.some((c) => c.args.includes("clone"))).toBe(true);
    expect(calls.some((c) => c.args.includes("install"))).toBe(false);
  });
});
