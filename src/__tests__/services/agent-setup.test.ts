import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultCompact, defaultConfigPath, setupAgent } from "../../services/agent-setup.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "agent-setup-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("setupAgent", () => {
  it("creates a fresh Hermes config.yaml with mcp_servers.comfyui in compact mode by default", async () => {
    const configPath = join(dir, "config.yaml");
    const res = await setupAgent({ agent: "hermes", configPath });
    expect(res.wrote).toBe(true);
    expect(res.compact).toBe(true);
    const parsed = parseYaml(await fs.readFile(configPath, "utf8"));
    expect(parsed.mcp_servers.comfyui).toEqual({
      command: "npx",
      args: ["-y", "comfyui-mcp", "--compact"],
    });
  });

  it("preserves existing Hermes YAML content and comments", async () => {
    const configPath = join(dir, "config.yaml");
    await fs.writeFile(
      configPath,
      "# my hermes config\nmodel: qwen3\nmcp_servers:\n  github: # gh server\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-github\"]\n",
      "utf8",
    );
    await setupAgent({ agent: "hermes", configPath });
    const text = await fs.readFile(configPath, "utf8");
    expect(text).toContain("# my hermes config");
    expect(text).toContain("# gh server");
    const parsed = parseYaml(text);
    expect(parsed.model).toBe("qwen3");
    expect(parsed.mcp_servers.github.command).toBe("npx");
    expect(parsed.mcp_servers.comfyui.args).toContain("--compact");
  });

  it("writes OpenClaw JSON with transport stdio and merges alongside existing servers", async () => {
    const configPath = join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ theme: "dark", mcpServers: { fs: { command: "npx", args: ["x"] } } }),
      "utf8",
    );
    await setupAgent({ agent: "openclaw", configPath, comfyuiUrl: "http://10.0.0.5:8188" });
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.fs).toBeDefined();
    expect(parsed.mcpServers.comfyui).toEqual({
      command: "npx",
      args: ["-y", "comfyui-mcp", "--compact"],
      transport: "stdio",
      env: { COMFYUI_URL: "http://10.0.0.5:8188" },
    });
  });

  it("writes Copilot CLI JSON with type stdio, tools wildcard, and full mode by default", async () => {
    const configPath = join(dir, "mcp-config.json");
    const res = await setupAgent({ agent: "copilot", configPath });
    expect(res.compact).toBe(false);
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(parsed.mcpServers.comfyui).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "comfyui-mcp"],
      env: {},
      tools: ["*"],
    });
  });

  it("honors an explicit compact override per agent", async () => {
    const copilot = await setupAgent({ agent: "copilot", configPath: join(dir, "c.json"), compact: true });
    expect(JSON.parse(copilot.content).mcpServers.comfyui.args).toContain("--compact");
    const hermes = await setupAgent({ agent: "hermes", configPath: join(dir, "h.yaml"), compact: false });
    expect(hermes.content).not.toContain("--compact");
  });

  it("is idempotent: running twice leaves one comfyui entry", async () => {
    const configPath = join(dir, "openclaw.json");
    await setupAgent({ agent: "openclaw", configPath });
    await setupAgent({ agent: "openclaw", configPath, compact: false });
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["comfyui"]);
    expect(parsed.mcpServers.comfyui.args).toEqual(["-y", "comfyui-mcp"]);
  });

  it("dry run returns content without touching disk", async () => {
    const configPath = join(dir, "config.yaml");
    const res = await setupAgent({ agent: "hermes", configPath, dryRun: true });
    expect(res.wrote).toBe(false);
    expect(res.content).toContain("comfyui");
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it("refuses to clobber a corrupt JSON config", async () => {
    const configPath = join(dir, "mcp-config.json");
    await fs.writeFile(configPath, "{not json", "utf8");
    await expect(setupAgent({ agent: "copilot", configPath })).rejects.toThrow(/did not parse as JSON/);
    expect(await fs.readFile(configPath, "utf8")).toBe("{not json");
  });

  it("default paths land in the harness dotdirs", () => {
    expect(defaultConfigPath("hermes")).toMatch(/[/\\]\.hermes[/\\]config\.yaml$/);
    expect(defaultConfigPath("openclaw")).toMatch(/[/\\]\.openclaw[/\\]openclaw\.json$/);
    expect(defaultConfigPath("copilot")).toMatch(/[/\\]\.copilot[/\\]mcp-config\.json$/);
    expect(defaultCompact("hermes")).toBe(true);
    expect(defaultCompact("openclaw")).toBe(true);
    expect(defaultCompact("copilot")).toBe(false);
  });
});
