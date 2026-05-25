import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Control config (comfyuiPath + tokens) per test.
vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  },
}));

// Avoid touching the real filesystem. createWriteStream / pipeline are only
// reached on a successful download, which these tests deliberately don't do.
const mkdirMock = vi.fn();
const statMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  readdir: vi.fn(),
}));

import { config } from "../../config.js";
import { downloadModel } from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";

const fetchMock = vi.fn();

function headersOf(callIndex = 0): Record<string, string> {
  const opts = fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> };
  return opts.headers;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  statMock.mockReset();
  config.comfyuiPath = "/comfy";
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadModel — filename path safety", () => {
  it("rejects a filename with parent traversal and never fetches", async () => {
    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "../evil.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a filename containing a path separator", async () => {
    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "sub/evil.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects '..' as a filename", async () => {
    await expect(
      downloadModel("https://example.com/x", "checkpoints", ".."),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("downloadModel — auth headers (token never in URL)", () => {
  // fetch returns not-ok so downloadModel stops right after the request (before
  // streaming) — enough to assert the headers/URL the request was made with.
  function failingFetch() {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "err" });
  }

  it("attaches a CivitAI bearer header (and keeps the token out of the URL) for civitai.com", async () => {
    config.civitaiApiToken = "secret";
    failingFetch();

    await expect(
      downloadModel("https://civitai.com/api/download/models/42", "checkpoints", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://civitai.com/api/download/models/42");
    expect(calledUrl).not.toContain("secret");
    expect(headersOf().Authorization).toBe("Bearer secret");
  });

  it("does NOT send the CivitAI token to a non-civitai host", async () => {
    config.civitaiApiToken = "secret";
    failingFetch();

    await expect(
      downloadModel("https://evil.example.com/path/civitai.com/x.safetensors", "checkpoints", "x.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBeUndefined();
  });

  it("attaches a HuggingFace bearer header for huggingface.co", async () => {
    config.huggingfaceToken = "hf";
    failingFetch();

    await expect(
      downloadModel("https://huggingface.co/org/repo/resolve/main/m.safetensors", "checkpoints", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBe("Bearer hf");
  });
});
