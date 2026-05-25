import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock config so civitaiApiToken is controllable per test.
vi.mock("../../config.js", () => ({
  config: { civitaiApiToken: undefined as string | undefined },
}));

import { config } from "../../config.js";
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
} from "../../services/civitai-resolver.js";
import { ModelError, ValidationError } from "../../utils/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  config.civitaiApiToken = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCivitaiModelVersion", () => {
  it("returns the primary file's download URL and filename", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 12345,
        name: "v1.0",
        files: [
          { name: "secondary.safetensors", downloadUrl: "https://civitai.com/api/download/models/999", primary: false },
          { name: "primary.safetensors", downloadUrl: "https://civitai.com/api/download/models/12345", primary: true },
        ],
      }),
    );

    const res = await resolveCivitaiModelVersion(12345);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/model-versions/12345",
      expect.objectContaining({ headers: {} }),
    );
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/12345");
    expect(res.filename).toBe("primary.safetensors");
    expect(res.versionId).toBe(12345);
  });

  it("falls back to the first file when none is marked primary", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 7,
        files: [{ name: "a.safetensors", downloadUrl: "https://civitai.com/api/download/models/7" }],
      }),
    );

    const res = await resolveCivitaiModelVersion(7);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/7");
    expect(res.filename).toBe("a.safetensors");
  });

  it("synthesizes a download URL when no file URL is present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 555, files: [] }));
    const res = await resolveCivitaiModelVersion(555);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/555");
    expect(res.filename).toBeUndefined();
  });

  it("appends the API token as a query param and sends bearer header", async () => {
    config.civitaiApiToken = "secret-token";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 42,
        files: [{ name: "m.safetensors", downloadUrl: "https://civitai.com/api/download/models/42", primary: true }],
      }),
    );

    const res = await resolveCivitaiModelVersion(42);

    // Request to the API carries the bearer header.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/model-versions/42",
      expect.objectContaining({ headers: { Authorization: "Bearer secret-token" } }),
    );
    // Download URL carries the token query param (downloadModel only adds
    // auth headers for huggingface.co, so query-param auth is required).
    expect(res.downloadUrl).toBe(
      "https://civitai.com/api/download/models/42?token=secret-token",
    );
  });

  it("does not duplicate an existing token query param", async () => {
    config.civitaiApiToken = "tok";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 1,
        files: [{ downloadUrl: "https://civitai.com/api/download/models/1?token=already", primary: true }],
      }),
    );
    const res = await resolveCivitaiModelVersion(1);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/1?token=already");
  });

  it("throws ModelError on 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(resolveCivitaiModelVersion(404)).rejects.toBeInstanceOf(ModelError);
  });

  it("throws ModelError on other API errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(resolveCivitaiModelVersion(1)).rejects.toBeInstanceOf(ModelError);
  });
});

describe("resolveCivitaiModel", () => {
  it("picks the first (latest) version by default", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 100,
        name: "Cool Model",
        modelVersions: [
          { id: 201, files: [{ name: "latest.safetensors", downloadUrl: "https://civitai.com/api/download/models/201", primary: true }] },
          { id: 200, files: [{ name: "older.safetensors", downloadUrl: "https://civitai.com/api/download/models/200", primary: true }] },
        ],
      }),
    );

    const res = await resolveCivitaiModel(100);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/models/100",
      expect.anything(),
    );
    expect(res.versionId).toBe(201);
    expect(res.filename).toBe("latest.safetensors");
    expect(res.modelName).toBe("Cool Model");
  });

  it("selects a specific version when versionId is provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 100,
        modelVersions: [
          { id: 201, files: [{ downloadUrl: "https://civitai.com/api/download/models/201", primary: true }] },
          { id: 200, files: [{ name: "older.safetensors", downloadUrl: "https://civitai.com/api/download/models/200", primary: true }] },
        ],
      }),
    );

    const res = await resolveCivitaiModel(100, 200);
    expect(res.versionId).toBe(200);
    expect(res.filename).toBe("older.safetensors");
  });

  it("throws ValidationError when the requested version is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 100, modelVersions: [{ id: 201, files: [] }] }),
    );
    await expect(resolveCivitaiModel(100, 999)).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ModelError when the model has no versions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 100, modelVersions: [] }));
    await expect(resolveCivitaiModel(100)).rejects.toBeInstanceOf(ModelError);
  });
});
