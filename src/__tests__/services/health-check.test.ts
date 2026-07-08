import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchApi = vi.fn();
const getQueue = vi.fn();
const getSystemStats = vi.fn();

vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi }),
  getQueue: (...args: unknown[]) => getQueue(...args),
  getSystemStats: (...args: unknown[]) => getSystemStats(...args),
}));

// Imported after the mock so the module picks up the stub.
const { runHealthCheck } = await import("../../services/health-check.js");

describe("runHealthCheck", () => {
  beforeEach(() => {
    fetchApi.mockReset();
    getQueue.mockReset();
    getSystemStats.mockReset();

    getSystemStats.mockResolvedValue({
      system: {
        python_version: "3.11.0",
        comfyui_version: "0.5.0",
        pytorch_version: "2.4.0",
        ram_free: 8 * 1024 ** 3,
      },
      devices: [
        {
          name: "NVIDIA GeForce RTX 4090",
          vram_total: 24 * 1024 ** 3,
          vram_free: 22 * 1024 ** 3,
        },
      ],
    });
    getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports version, GPU, queue, and populated model categories", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models/checkpoints") {
        return new Response(JSON.stringify(["sd_xl_base_1.0.safetensors"]), {
          status: 200,
        });
      }
      if (path === "/internal/logs") {
        return new Response("startup ok\nready\n", { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const text = await runHealthCheck({
      modelCategories: ["checkpoints", "loras"],
    });

    expect(text).toContain("**ComfyUI**: 0.5.0");
    expect(text).toContain("VRAM free 22.0/24.0 GB");
    expect(text).toContain("**Queue**: 0 running, 0 pending");
    expect(text).toContain("checkpoints: 1");
    expect(text).toContain("loras: **EMPTY**");
  });

  it("surfaces a recent error from /internal/logs", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/internal/logs") {
        return new Response(
          "startup ok\nTraceback (most recent call last):\n  File 'x.py'\n",
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const text = await runHealthCheck({ modelCategories: ["checkpoints"] });
    expect(text).toContain("Recent errors");
    expect(text).toMatch(/Traceback/);
  });

  it("throws ConnectionError when ComfyUI is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8188"));
    await expect(
      runHealthCheck({ modelCategories: ["checkpoints"] }),
    ).rejects.toThrow(/ComfyUI unreachable/);
  });
});
