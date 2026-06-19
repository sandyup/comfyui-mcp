import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserMcpServers,
  addUserMcpServer,
  removeUserMcpServer,
  isConflictingServer,
  setUserMcpServerSecret,
} from "../../services/user-mcp-config.js";

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-mcp-"));
  cfgPath = join(dir, ".claude.json");
  process.env.COMFYUI_MCP_CLAUDE_JSON = cfgPath;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_CLAUDE_JSON;
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(obj: unknown) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

describe("user-mcp-config", () => {
  it("returns no servers when the config is missing", () => {
    expect(readUserMcpServers()).toEqual({});
  });

  it("reads user-scope servers but filters out conflicting comfyui entries", () => {
    writeCfg({
      mcpServers: {
        context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        comfyui: { type: "stdio", command: "npx", args: ["comfyui-mcp"] },
        civitai: { type: "http", url: "https://mcp.civitai.com/mcp" },
        // A renamed comfyui-mcp instance (different key) must also be filtered.
        myComfy: { type: "stdio", command: "node", args: ["comfyui-mcp"] },
      },
    });
    const servers = readUserMcpServers();
    expect(Object.keys(servers).sort()).toEqual(["civitai", "context7"]);
    expect(servers.civitai).toMatchObject({ type: "http", url: "https://mcp.civitai.com/mcp" });
  });

  it("flags conflicting servers by name and by config contents", () => {
    expect(isConflictingServer("comfyui", {})).toBe(true);
    expect(isConflictingServer("x", { args: ["comfyui-mcp"] })).toBe(true);
    expect(isConflictingServer("context7", { command: "npx" })).toBe(false);
  });

  it("adds an http server, preserving other top-level keys", () => {
    writeCfg({ numStartups: 7, mcpServers: { context7: { type: "stdio", command: "npx" } } });
    addUserMcpServer("civitai", { type: "http", url: "https://mcp.civitai.com/mcp" });

    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(raw.numStartups).toBe(7); // unrelated keys untouched
    expect(raw.mcpServers.context7).toBeDefined();
    expect(raw.mcpServers.civitai).toEqual({ type: "http", url: "https://mcp.civitai.com/mcp" });
    // And it shows up as inheritable.
    expect(readUserMcpServers().civitai).toBeDefined();
  });

  it("creates the mcpServers map when the config exists without one", () => {
    writeCfg({ theme: "dark" });
    addUserMcpServer("civitai", { type: "http", url: "https://mcp.civitai.com/mcp" });
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(raw.theme).toBe("dark");
    expect(raw.mcpServers.civitai).toBeDefined();
  });

  it("refuses invalid names and conflicting names", () => {
    expect(() => addUserMcpServer("bad name", { type: "http", url: "x" })).toThrow();
    expect(() => addUserMcpServer("comfyui", { type: "http", url: "x" })).toThrow(/conflicts/);
    expect(existsSync(cfgPath)).toBe(false); // nothing written on rejection
  });

  it("writes a header secret with a prefix onto an existing server", () => {
    writeCfg({ mcpServers: { civitai: { type: "http", url: "https://mcp.civitai.com/mcp" } } });
    setUserMcpServerSecret({ kind: "header", server: "civitai", key: "Authorization", prefix: "Bearer " }, "abc123");
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(raw.mcpServers.civitai.headers.Authorization).toBe("Bearer abc123");
    expect(raw.mcpServers.civitai.url).toBe("https://mcp.civitai.com/mcp"); // preserved
  });

  it("writes an env secret onto a stdio server", () => {
    writeCfg({ mcpServers: { hf: { type: "stdio", command: "npx", args: ["x"] } } });
    setUserMcpServerSecret({ kind: "env", server: "hf", key: "HF_TOKEN" }, "tok");
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(raw.mcpServers.hf.env.HF_TOKEN).toBe("tok");
  });

  it("refuses to set a secret on a missing server", () => {
    writeCfg({ mcpServers: {} });
    expect(() =>
      setUserMcpServerSecret({ kind: "header", server: "nope", key: "Authorization" }, "x"),
    ).toThrow(/not configured/);
  });

  it("removes a server and reports absence", () => {
    writeCfg({ mcpServers: { civitai: { type: "http", url: "x" } } });
    expect(removeUserMcpServer("civitai")).toBe(true);
    expect(readUserMcpServers().civitai).toBeUndefined();
    expect(removeUserMcpServer("nope")).toBe(false);
  });
});
