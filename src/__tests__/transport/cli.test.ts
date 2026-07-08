import { describe, expect, it } from "vitest";
import { parseCliArgs, validateConnectUrl } from "../../transport/cli.js";

const base = ["node", "comfyui-mcp"];

describe("parseCliArgs", () => {
  it("defaults to stdio on 127.0.0.1:9100 with no args/env", () => {
    expect(parseCliArgs(base, {})).toEqual({
      transport: "stdio",
      toolMode: "full",
      toolModeExplicit: false,
      host: "127.0.0.1",
      port: 9100,
      panelOrchestrator: false,
      token: undefined,
      tunnel: false,
      allowUnauthenticated: false,
      insecureBridge: false,
      setupAgent: undefined,
      setupDryRun: false,
    });
  });

  it("--http switches transport", () => {
    expect(parseCliArgs([...base, "--http"], {}).transport).toBe("http");
  });

  it("--transport http switches transport", () => {
    expect(parseCliArgs([...base, "--transport", "http"], {}).transport).toBe("http");
  });

  it("supports --port value and --host value", () => {
    const o = parseCliArgs([...base, "--http", "--host", "0.0.0.0", "--port", "8080"], {});
    expect(o).toEqual({ transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 8080, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("supports --flag=value form", () => {
    const o = parseCliArgs([...base, "--transport=http", "--port=3000", "--host=0.0.0.0"], {});
    expect(o).toEqual({ transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 3000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("reads env defaults", () => {
    const o = parseCliArgs(base, { MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "5000" });
    expect(o).toEqual({ transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 5000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("--compact / --tool-mode / COMFYUI_MCP_TOOL_MODE select the compact tool mode", () => {
    expect(parseCliArgs(base, {}).toolMode).toBe("full");
    expect(parseCliArgs([...base, "--compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs([...base, "--tool-mode", "compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs([...base, "--tool-mode=compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode).toBe("compact");
    // explicit --tool-mode full / --full overrides the env opt-in
    expect(
      parseCliArgs([...base, "--tool-mode", "full"], { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode,
    ).toBe("full");
    expect(parseCliArgs([...base, "--full"], { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode).toBe("full");
    // unknown values fall back to full
    expect(parseCliArgs([...base, "--tool-mode", "bogus"], {}).toolMode).toBe("full");
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "bogus" }).toolMode).toBe("full");
  });

  it("`setup <agent>` captures the agent, --dry-run, --comfyui-url, and explicit tool mode", () => {
    expect(parseCliArgs(base, {}).setupAgent).toBeUndefined();
    const o = parseCliArgs(
      [...base, "setup", "hermes", "--dry-run", "--comfyui-url", "http://10.0.0.5:8188"],
      {},
    );
    expect(o.setupAgent).toBe("hermes");
    expect(o.setupDryRun).toBe(true);
    expect(o.comfyuiUrl).toBe("http://10.0.0.5:8188");
    expect(o.toolModeExplicit).toBe(false);
    expect(parseCliArgs([...base, "setup", "copilot", "--compact"], {}).toolModeExplicit).toBe(true);
    expect(parseCliArgs([...base, "setup", "hermes", "--tool-mode", "full"], {}).toolModeExplicit).toBe(true);
    // `setup` with no agent yields empty string so index.ts can print usage
    expect(parseCliArgs([...base, "setup"], {}).setupAgent).toBe("");
    expect(parseCliArgs([...base, "setup", "--dry-run"], {}).setupAgent).toBe("");
  });

  it("--insecure-bridge sets insecureBridge=true; COMFYUI_MCP_INSECURE_BRIDGE env works too", () => {
    expect(parseCliArgs(base, {}).insecureBridge).toBe(false);
    expect(parseCliArgs([...base, "--insecure-bridge"], {}).insecureBridge).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_INSECURE_BRIDGE: "1" }).insecureBridge).toBe(true);
    expect(parseCliArgs([...base, "connect", "https://pod.example.com"], {}).insecureBridge).toBe(false);
  });

  it("reads token from COMFYUI_MCP_HTTP_TOKEN env and --token flag (flag wins)", () => {
    expect(parseCliArgs(base, { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe("envtok");
    expect(parseCliArgs([...base, "--token", "flagtok"], { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe(
      "flagtok",
    );
    expect(parseCliArgs([...base, "--token=eq"], {}).token).toBe("eq");
  });

  it("--tunnel forces http transport and sets tunnel=true; MCP_TUNNEL env works too", () => {
    const o = parseCliArgs([...base, "--tunnel"], {});
    expect(o.tunnel).toBe(true);
    expect(o.transport).toBe("http");
    const e = parseCliArgs(base, { MCP_TUNNEL: "1" });
    expect(e.tunnel).toBe(true);
    expect(e.transport).toBe("http");
  });

  it("reads the unauthenticated escape hatch from flag and env", () => {
    expect(parseCliArgs(base, {}).allowUnauthenticated).toBe(false);
    expect(
      parseCliArgs([...base, "--allow-unauthenticated-non-loopback"], {}).allowUnauthenticated,
    ).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_ALLOW_UNAUTH: "1" }).allowUnauthenticated).toBe(true);
  });

  it("--panel-orchestrator enables orchestrator mode; env works too", () => {
    expect(parseCliArgs(base, {}).panelOrchestrator).toBe(false);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).panelOrchestrator).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_PANEL_ORCHESTRATOR: "1" }).panelOrchestrator).toBe(true);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {})).toMatchObject({
      panelOrchestrator: true,
      token: undefined,
      tunnel: false,
    });
  });

  it("`connect <url>` implies panelOrchestrator and captures comfyuiUrl", () => {
    const o = parseCliArgs([...base, "connect", "https://abcd-8188.proxy.runpod.net"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBe("https://abcd-8188.proxy.runpod.net");
    expect(o.transport).toBe("stdio");
  });

  it("`connect` with no URL is sugar for --panel-orchestrator (no comfyuiUrl)", () => {
    const o = parseCliArgs([...base, "connect"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBeUndefined();
  });

  it("`connect` followed by a flag does not swallow the flag as a URL", () => {
    const o = parseCliArgs([...base, "connect", "--port", "9999"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBeUndefined();
    expect(o.port).toBe(9999);
  });

  it("`connect <url>` still parses trailing flags", () => {
    const o = parseCliArgs([...base, "connect", "http://10.0.0.5:8188", "--port=9181"], {});
    expect(o.comfyuiUrl).toBe("http://10.0.0.5:8188");
    expect(o.port).toBe(9181);
  });

  it("no `connect` subcommand leaves comfyuiUrl undefined", () => {
    expect(parseCliArgs(base, {}).comfyuiUrl).toBeUndefined();
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).comfyuiUrl).toBeUndefined();
  });

  it("explicit --stdio flag overrides MCP_TRANSPORT=http env", () => {
    expect(parseCliArgs([...base, "--stdio"], { MCP_TRANSPORT: "http" }).transport).toBe("stdio");
  });

  it("explicit flags override env values", () => {
    const o = parseCliArgs([...base, "--port", "7000"], { MCP_PORT: "5000" });
    expect(o.port).toBe(7000);
  });
});

describe("validateConnectUrl", () => {
  it("accepts a full http(s) URL (returns null)", () => {
    expect(validateConnectUrl("https://abcd-8188.proxy.runpod.net")).toBeNull();
    expect(validateConnectUrl("http://127.0.0.1:8188")).toBeNull();
    expect(validateConnectUrl("https://comfy.example.com/comfyapi")).toBeNull();
  });

  it("rejects a non-URL token with a clear, actionable error", () => {
    const err = validateConnectUrl("not-a-url");
    expect(err).not.toBeNull();
    expect(err).toContain("not-a-url");
    expect(err).toMatch(/http\(s\) URL/);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(validateConnectUrl("ftp://example.com")).not.toBeNull();
    expect(validateConnectUrl("ws://127.0.0.1:8188")).not.toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateConnectUrl("")).not.toBeNull();
  });
});
