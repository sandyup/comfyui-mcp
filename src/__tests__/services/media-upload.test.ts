import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
}));

const copyFileMock = vi.fn();
const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...a: unknown[]) => readFileMock(...a),
  copyFile: (...a: unknown[]) => copyFileMock(...a),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const uploadImageHttpMock = vi.fn();
const fetchImageMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
}));

import { config } from "../../config.js";
import {
  uploadVideoAuto,
  uploadVideoLocal,
  uploadAudioAuto,
  uploadAudioLocal,
} from "../../services/image-management.js";
import { ValidationError } from "../../utils/errors.js";

beforeEach(() => {
  vi.clearAllMocks();
  (config as { comfyuiPath?: string }).comfyuiPath = "/comfy";
  readFileMock.mockResolvedValue(Buffer.from("data"));
  uploadImageHttpMock.mockResolvedValue({ name: "x" });
  copyFileMock.mockResolvedValue(undefined);
});

describe("uploadVideoAuto (HTTP)", () => {
  it("uploads a .mp4 with the video/mp4 mime type", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "clip.mp4" });
    const r = await uploadVideoAuto("/src/clip.mp4");
    expect(r.filename).toBe("clip.mp4");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "clip.mp4",
      expect.any(Buffer),
      "video/mp4",
    );
  });

  it("respects a filename override and maps .webm", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "renamed.webm" });
    await uploadVideoAuto("/src/clip.webm", "renamed.webm");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "renamed.webm",
      expect.any(Buffer),
      "video/webm",
    );
  });

  it("rejects an unsupported extension before any upload", async () => {
    await expect(uploadVideoAuto("/src/notes.txt")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(uploadImageHttpMock).not.toHaveBeenCalled();
  });
});

describe("uploadAudioAuto (HTTP)", () => {
  it("uploads a .wav with the audio/wav mime type", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "track.wav" });
    const r = await uploadAudioAuto("/src/track.wav");
    expect(r.filename).toBe("track.wav");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "track.wav",
      expect.any(Buffer),
      "audio/wav",
    );
  });

  it("rejects an image extension (wrong media kind)", async () => {
    await expect(uploadAudioAuto("/src/pic.png")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(uploadImageHttpMock).not.toHaveBeenCalled();
  });
});

describe("uploadVideoLocal / uploadAudioLocal (filesystem)", () => {
  it("copies a video into <comfyui>/input and returns the path", async () => {
    const r = await uploadVideoLocal("/src/clip.mov");
    expect(copyFileMock).toHaveBeenCalledWith(
      "/src/clip.mov",
      join("/comfy", "input", "clip.mov"),
    );
    expect(r).toEqual({
      filename: "clip.mov",
      path: join("/comfy", "input", "clip.mov"),
    });
  });

  it("rejects an unsupported audio extension before copying", async () => {
    await expect(uploadAudioLocal("/src/clip.mp4")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it("errors clearly when COMFYUI_PATH is unset (remote mode)", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    await expect(uploadVideoLocal("/src/clip.mp4")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});
