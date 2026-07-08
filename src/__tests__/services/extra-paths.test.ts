import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
}));

// Pin the platform so the Desktop app-data path is deterministic across CI OSes:
// the desktop tests drive it via APPDATA (the win32 branch). Without this, Linux
// uses XDG_CONFIG_HOME/~/.config and macOS uses ~/Library, so the temp-dir
// assertions fail on those runners. (homedir/tmpdir stay real.)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" };
});

import { config } from "../../config.js";
import {
  addExtraPath,
  listExtraPaths,
  removeExtraPath,
} from "../../services/extra-paths.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "comfyui-extra-paths-"));
}

let dirs: string[] = [];
const oldAppData = process.env.APPDATA;

beforeEach(() => {
  config.comfyuiPath = undefined;
  dirs = [];
});

afterEach(async () => {
  process.env.APPDATA = oldAppData;
  config.comfyuiPath = undefined;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function trackTmp(): Promise<string> {
  const dir = await tmpDir();
  dirs.push(dir);
  return dir;
}

describe("extra paths config service", () => {
  it("lists a standalone extra_model_paths.yaml from COMFYUI_PATH", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;
    await writeFile(
      join(root, "extra_model_paths.yaml"),
      [
        "shared:",
        "  base_path: D:/AI",
        "  is_default: true",
        "  checkpoints: |",
        "    models/checkpoints",
        "    E:/checkpoints",
        "  custom_nodes: C:/ComfyUI/custom_nodes",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.target).toBe("standalone");
    expect(result.exists).toBe(true);
    expect(result.path).toBe(join(root, "extra_model_paths.yaml"));
    expect(result.groups[0]).toMatchObject({
      name: "shared",
      base_path: "D:/AI",
      categories: [
        { category: "checkpoints", paths: ["models/checkpoints", "E:/checkpoints"] },
        { category: "custom_nodes", paths: ["C:/ComfyUI/custom_nodes"] },
      ],
    });
  });

  it("adds paths idempotently and removes exact matches", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    const first = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
      isDefault: true,
    });
    expect(first.changed).toBe(true);
    expect(first.groups[0].categories[0]).toEqual({
      category: "loras",
      paths: ["D:/Models/loras"],
    });

    const second = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(second.changed).toBe(false);

    const raw = await readFile(join(root, "extra_model_paths.yaml"), "utf-8");
    expect(raw).toContain("shared:");
    expect(raw).toContain("is_default: true");
    expect(raw.match(/D:\/Models\/loras/g)).toHaveLength(1);

    const removed = await removeExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(removed.changed).toBe(true);
    expect(removed.groups[0].categories).toEqual([]);
  });

  it("uses the Desktop app-data config path when requested explicitly", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;

    const result = await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "checkpoints",
      path: "E:/SD/checkpoints",
    });

    expect(result.target).toBe("desktop");
    expect(result.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(result.exists).toBe(true);
    expect(result.groups[0].categories[0].paths).toEqual(["E:/SD/checkpoints"]);
  });

  it("auto target prefers an existing Desktop config over standalone", async () => {
    const root = await trackTmp();
    const appData = await trackTmp();
    config.comfyuiPath = root;
    process.env.APPDATA = appData;
    const desktopPath = join(appData, "ComfyUI", "extra_models_config.yaml");
    await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "vae",
      path: "E:/vae",
    });

    const result = await listExtraPaths({ target: "auto" });
    expect(result.target).toBe("desktop");
    expect(result.path).toBe(desktopPath);
  });

  it("rejects unsafe category keys and newline-bearing paths", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    await expect(
      addExtraPath({
        target: "standalone",
        category: "../bad",
        path: "D:/Models",
      }),
    ).rejects.toThrow(/Category/);

    await expect(
      addExtraPath({
        target: "standalone",
        category: "checkpoints",
        path: "D:/Models\nother",
      }),
    ).rejects.toThrow(/newline/);
  });
});
