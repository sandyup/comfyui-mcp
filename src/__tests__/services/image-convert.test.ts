import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
  },
}));

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
}));

const mkdirMock = vi.fn();
const readFileMock = vi.fn();
const statMock = vi.fn();
const writeFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  writeFile: (...a: unknown[]) => writeFileMock(...a),
}));

const pngMock = vi.fn();
const jpegMock = vi.fn();
const webpMock = vi.fn();
const toBufferMock = vi.fn();
const sharpMock = vi.fn();
vi.mock("sharp", () => ({
  default: (...a: unknown[]) => sharpMock(...a),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { convertImage } from "../../services/image-convert.js";
import { config } from "../../config.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function registerAsset(filename = "hero.png"): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [record] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder: "", type: "output", url: "u" }],
      },
    ],
  });
  return record.assetId;
}

beforeEach(() => {
  AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
  AssetRegistry.clear();
  config.comfyuiPath = "/comfy";
  getOutputImageMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  readFileMock.mockReset();
  statMock.mockReset().mockResolvedValue({ isFile: () => true });
  writeFileMock.mockReset().mockResolvedValue(undefined);
  pngMock.mockReset();
  jpegMock.mockReset();
  webpMock.mockReset();
  toBufferMock.mockReset().mockResolvedValue(Buffer.from("small"));
  const chain = {
    png: pngMock.mockReturnThis(),
    jpeg: jpegMock.mockReturnThis(),
    webp: webpMock.mockReturnThis(),
    toBuffer: toBufferMock,
  };
  sharpMock.mockReset().mockReturnValue(chain);
});

describe("convertImage", () => {
  it.each([
    ["png" as const, "image/png", pngMock, { quality: 80 }],
    ["jpeg" as const, "image/jpeg", jpegMock, { quality: 75, progressive: true }],
    ["webp" as const, "image/webp", webpMock, { quality: 70, lossless: false, effort: 5 }],
  ])("converts asset sources to %s inline", async (format, mimeType, encoder, options) => {
    const assetId = registerAsset();
    getOutputImageMock.mockResolvedValueOnce({
      base64: Buffer.from("source-data").toString("base64"),
      mimeType: "image/png",
      filename: "hero.png",
    });

    const result = await convertImage({ asset_id: assetId, format, ...options });

    expect(getOutputImageMock).toHaveBeenCalledWith("hero.png", "output", "");
    expect(sharpMock).toHaveBeenCalledWith(Buffer.from("source-data"));
    expect(encoder).toHaveBeenCalledWith(expect.objectContaining(options));
    expect(result.mimeType).toBe(mimeType);
    expect(result.outputBytes).toBe(5);
    expect(result.bytesSaved).toBe(Buffer.byteLength("source-data") - 5);
    expect(result.content).toContainEqual({
      type: "image",
      data: Buffer.from("small").toString("base64"),
      mimeType,
    });
  });

  it("converts a path source under the output directory and writes out_path", async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from("large-source"));

    const result = await convertImage({
      path: "nested/source.png",
      format: "webp",
      quality: 60,
      out_path: "converted/source.webp",
    });

    expect(statMock).toHaveBeenCalledWith("/comfy/output/nested/source.png");
    expect(readFileMock).toHaveBeenCalledWith("/comfy/output/nested/source.png");
    expect(webpMock).toHaveBeenCalledWith({ quality: 60, lossless: undefined, effort: undefined });
    expect(mkdirMock).toHaveBeenCalledWith("/comfy/output/converted", { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith("/comfy/output/converted/source.webp", Buffer.from("small"));
    expect(result.outPath).toBe("/comfy/output/converted/source.webp");
    expect(result.sourceBytes).toBe(Buffer.byteLength("large-source"));
    expect(result.bytesSaved).toBe(Buffer.byteLength("large-source") - 5);
    const text = result.content.find((c) => c.type === "text") as { text: string };
    expect(JSON.parse(text.text)).toMatchObject({
      output_bytes: 5,
      bytes_saved: Buffer.byteLength("large-source") - 5,
      out_path: "/comfy/output/converted/source.webp",
    });
  });

  it("rejects path traversal before reading source files", async () => {
    await expect(
      convertImage({ path: "../secret.png", format: "jpeg" }),
    ).rejects.toThrow(/output directory/i);
    expect(statMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects path traversal in out_path before writing", async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from("large-source"));

    await expect(
      convertImage({ path: "source.png", format: "jpeg", out_path: "../x.jpg" }),
    ).rejects.toThrow(/output directory/i);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("validates quality and effort ranges before resolving the source", async () => {
    const assetId = registerAsset();
    await expect(
      convertImage({ asset_id: assetId, format: "jpeg", quality: 101 }),
    ).rejects.toThrow(/quality/i);
    await expect(
      convertImage({ asset_id: assetId, format: "webp", effort: 7 }),
    ).rejects.toThrow(/effort/i);
    expect(getOutputImageMock).not.toHaveBeenCalled();
  });

  it("rejects missing assets clearly", async () => {
    await expect(
      convertImage({ asset_id: "a_missing", format: "webp" }),
    ).rejects.toThrow(/No asset found/);
  });
});
