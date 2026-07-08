import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../services/image-management.js", () => ({
  getOutputImage: vi.fn(),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { viewAssetImage } from "../../services/view-image.js";
import { getOutputImage } from "../../services/image-management.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const mockedGetOutputImage = vi.mocked(getOutputImage);

function register(filename: string, type = "output", subfolder = ""): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [rec] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder, type, url: "u" }],
      },
    ],
  });
  return rec.assetId;
}

describe("viewAssetImage", () => {
  beforeEach(() => {
    AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
    AssetRegistry.clear();
    mockedGetOutputImage.mockReset();
  });

  it("returns an image content block for a registered PNG asset", async () => {
    const assetId = register("hero.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "aGVsbG8=",
      mimeType: "image/png",
      filename: "hero.png",
    });

    const result = await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("hero.png", "output", "");
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("throws when asset_id is unknown or expired", async () => {
    await expect(viewAssetImage("a_deadbeef")).rejects.toThrow(/No asset found/);
    expect(mockedGetOutputImage).not.toHaveBeenCalled();
  });

  it("rejects unsupported mime types (e.g. audio/video)", async () => {
    const assetId = register("song.flac");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "audio/flac",
      filename: "song.flac",
    });
    await expect(viewAssetImage(assetId)).rejects.toThrow(/not an image/i);
  });

  it("passes through subfolder and type to the fetcher", async () => {
    const assetId = register("a.png", "temp", "preview");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/png",
      filename: "a.png",
    });
    await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("a.png", "temp", "preview");
  });

  it("includes a text summary alongside the image block", async () => {
    const assetId = register("b.jpg");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/jpeg",
      filename: "b.jpg",
    });
    const result = await viewAssetImage(assetId);
    const text = result.content.find((c) => c.type === "text");
    expect(text).toBeDefined();
    expect((text as { text: string }).text).toContain(assetId);
    expect((text as { text: string }).text).toContain("b.jpg");
  });
});
