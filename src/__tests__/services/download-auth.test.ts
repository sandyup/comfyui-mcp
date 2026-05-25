import { describe, expect, it } from "vitest";
import { applyDownloadAuth } from "../../services/download-auth.js";
import { ValidationError } from "../../utils/errors.js";

describe("download auth validation", () => {
  it("rejects CRLF in bearer tokens", () => {
    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "bearer",
        token: "good\r\nX-Evil: yes",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects invalid custom header names", () => {
    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "header",
        header_name: "Bad Header",
        header_value: "secret",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects CRLF in custom header values", () => {
    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "header",
        header_name: "X-Api-Key",
        header_value: "secret\nX-Evil: yes",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects control characters in basic auth credentials", () => {
    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "basic",
        username: "alice",
        password: "secret\u0000suffix",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects empty or control-character query parameter names", () => {
    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "query",
        query_param: "",
        query_value: "secret",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "query",
        query_param: "token\nname",
        query_value: "secret",
      }),
    ).toThrow(ValidationError);
  });

  it("keeps valid auth requests unchanged", () => {
    expect(
      applyDownloadAuth("https://example.com/model.safetensors", {
        type: "header",
        header_name: "X-Api-Key",
        header_value: "secret",
      }),
    ).toEqual({
      url: "https://example.com/model.safetensors",
      headers: { "X-Api-Key": "secret" },
    });
  });
});
