import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultsManager } from "../../services/defaults-manager.js";

async function tmpConfig(initial?: Record<string, unknown>): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-defaults-"));
  const path = join(dir, "config.json");
  if (initial) await writeFile(path, JSON.stringify(initial), "utf-8");
  return { path, dir };
}

describe("DefaultsManager", () => {
  beforeEach(() => {
    DefaultsManager.reset();
  });

  it("returns empty defaults when no config + no env", async () => {
    const { path, dir } = await tmpConfig();
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      expect(DefaultsManager.getAll()).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads values from the config file", async () => {
    const { path, dir } = await tmpConfig({ width: 1024, steps: 30, sampler: "euler" });
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      const all = DefaultsManager.getAll();
      expect(all.width).toEqual({ value: 1024, source: "config" });
      expect(all.steps).toEqual({ value: 30, source: "config" });
      expect(all.sampler).toEqual({ value: "euler", source: "config" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("env vars override config values", async () => {
    const { path, dir } = await tmpConfig({ width: 1024 });
    try {
      DefaultsManager.configure({
        configPath: path,
        env: { COMFYUI_DEFAULT_WIDTH: "768" },
      });
      await DefaultsManager.load();
      expect(DefaultsManager.getAll().width).toEqual({ value: 768, source: "env" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runtime overrides win over env and config", async () => {
    const { path, dir } = await tmpConfig({ width: 1024 });
    try {
      DefaultsManager.configure({
        configPath: path,
        env: { COMFYUI_DEFAULT_WIDTH: "768" },
      });
      await DefaultsManager.load();
      await DefaultsManager.set({ width: 512 });
      expect(DefaultsManager.getAll().width).toEqual({ value: 512, source: "runtime" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set() with persist=true writes to config file", async () => {
    const { path, dir } = await tmpConfig({ width: 1024 });
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      await DefaultsManager.set({ steps: 25 }, { persist: true });
      const raw = JSON.parse(await readFile(path, "utf-8"));
      expect(raw.steps).toBe(25);
      expect(raw.width).toBe(1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set() without persist does not touch the file", async () => {
    const { path, dir } = await tmpConfig({ width: 1024 });
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      await DefaultsManager.set({ steps: 25 });
      const raw = JSON.parse(await readFile(path, "utf-8"));
      expect(raw.steps).toBeUndefined();
      expect(DefaultsManager.getAll().steps).toEqual({ value: 25, source: "runtime" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directory when persisting to a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-defaults-"));
    const path = join(dir, "nested", "deep", "config.json");
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load(); // no file yet — should not throw
      await DefaultsManager.set({ width: 512 }, { persist: true });
      const raw = JSON.parse(await readFile(path, "utf-8"));
      expect(raw.width).toBe(512);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses env values as JSON when possible", async () => {
    const { path, dir } = await tmpConfig();
    try {
      DefaultsManager.configure({
        configPath: path,
        env: {
          COMFYUI_DEFAULT_STEPS: "30",
          COMFYUI_DEFAULT_CFG: "7.5",
          COMFYUI_DEFAULT_RANDOMIZE: "true",
          COMFYUI_DEFAULT_SAMPLER: "euler",
        },
      });
      await DefaultsManager.load();
      const all = DefaultsManager.getAll();
      expect(all.steps.value).toBe(30);
      expect(all.cfg.value).toBe(7.5);
      expect(all.randomize.value).toBe(true);
      expect(all.sampler.value).toBe("euler");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed config file content with a warning", async () => {
    const { path, dir } = await tmpConfig();
    try {
      await writeFile(path, "{ not json", "utf-8");
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      expect(DefaultsManager.getAll()).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("apply() fills missing keys in an args object from defaults", async () => {
    const { path, dir } = await tmpConfig({ width: 1024, height: 1024, steps: 30 });
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      const args = DefaultsManager.apply({ width: 512 });
      expect(args).toEqual({ width: 512, height: 1024, steps: 30 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite undefined-vs-missing distinctions", async () => {
    const { path, dir } = await tmpConfig({ width: 1024 });
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      await DefaultsManager.load();
      // explicit undefined still triggers default fill
      const args = DefaultsManager.apply({ width: undefined });
      expect(args).toEqual({ width: 1024 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("DefaultsManager — config path resolution", () => {
  it("default config path uses ~/.config/comfyui-mcp/config.json on first call", () => {
    DefaultsManager.reset();
    const path = DefaultsManager.getConfigPath();
    expect(path).toMatch(/\.config[\\/]comfyui-mcp[\\/]config\.json$/);
  });

  it("ensures the directory does not exist isn't a problem for getConfigPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-defaults-"));
    const path = join(dir, "still-missing", "config.json");
    try {
      DefaultsManager.configure({ configPath: path, env: {} });
      expect(DefaultsManager.getConfigPath()).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
      DefaultsManager.reset();
    }
  });
});
