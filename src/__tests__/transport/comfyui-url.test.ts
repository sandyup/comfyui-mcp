import { describe, expect, it } from "vitest";
import { parseComfyUIUrl } from "../../transport/comfyui-url.js";

describe("parseComfyUIUrl", () => {
  it("parses http with explicit port", () => {
    expect(parseComfyUIUrl("http://127.0.0.1:8188")).toEqual({
      host: "127.0.0.1",
      port: 8188,
      ssl: false,
    });
  });

  it("parses https with explicit port", () => {
    expect(parseComfyUIUrl("https://comfy.example.com:8443")).toEqual({
      host: "comfy.example.com",
      port: 8443,
      ssl: true,
    });
  });

  it("defaults https to port 443 when omitted", () => {
    expect(parseComfyUIUrl("https://comfy.example.com")).toEqual({
      host: "comfy.example.com",
      port: 443,
      ssl: true,
    });
  });

  it("defaults http to port 80 when omitted", () => {
    expect(parseComfyUIUrl("http://comfy.local")).toEqual({
      host: "comfy.local",
      port: 80,
      ssl: false,
    });
  });

  it("handles LAN IP with custom port", () => {
    expect(parseComfyUIUrl("http://192.168.1.50:8000")).toEqual({
      host: "192.168.1.50",
      port: 8000,
      ssl: false,
    });
  });

  it("throws on unsupported protocol", () => {
    expect(() => parseComfyUIUrl("ftp://host:21")).toThrow(/protocol/i);
  });

  it("throws on a non-URL string", () => {
    expect(() => parseComfyUIUrl("not a url")).toThrow();
  });
});
