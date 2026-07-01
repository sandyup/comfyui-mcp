import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolCatalog } from "../../tools/catalog.js";
import { buildManifest, registerCompactTools, summarize } from "../../tools/compact.js";
import { collectToolCatalog } from "../../tools/index.js";

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A small catalog standing in for the real tool surface. */
function fakeCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  const registrar = catalog.asRegistrar();
  catalog.setCategory("generation");
  registrar.tool(
    "gen_image",
    "Generate an image from a prompt. Long tail of details that should not appear in the manifest one-liner.",
    {
      prompt: z.string().describe("The prompt."),
      steps: z.number().int().min(1).max(100).optional().describe("Sampling steps."),
    },
    async (args: { prompt: string; steps?: number }) => ({
      content: [{ type: "text" as const, text: `generated:${args.prompt}:${args.steps ?? "default"}` }],
    }),
  );
  catalog.setCategory("diagnostics");
  registrar.tool(
    "ping",
    "Report server liveness.",
    {},
    async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
  );
  registrar.tool(
    "always_throws",
    "A tool whose handler throws.",
    {},
    async () => {
      throw new Error("boom");
    },
  );
  return catalog;
}

async function compactPair(catalog: ToolCatalog): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCompactTools(server, catalog);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("ToolCatalog", () => {
  it("captures 4-arg server.tool() registrations with category and schema", () => {
    const catalog = fakeCatalog();
    expect(catalog.tools.size).toBe(3);
    const gen = catalog.get("gen_image");
    expect(gen?.category).toBe("generation");
    expect(gen?.description).toMatch(/^Generate an image/);
    expect(Object.keys(gen?.schema ?? {})).toEqual(["prompt", "steps"]);
  });

  it("keeps the first registration on duplicate names", () => {
    const catalog = new ToolCatalog();
    const registrar = catalog.asRegistrar();
    registrar.tool("dup", "first", {}, async () => ({ content: [] }));
    registrar.tool("dup", "second", {}, async () => ({ content: [] }));
    expect(catalog.get("dup")?.description).toBe("first");
  });

  it("groups tools by category in first-seen order", () => {
    const grouped = fakeCatalog().byCategory();
    expect([...grouped.keys()]).toEqual(["generation", "diagnostics"]);
    expect(grouped.get("diagnostics")?.map((t) => t.name)).toEqual(["ping", "always_throws"]);
  });
});

describe("summarize", () => {
  it("keeps only the first sentence", () => {
    expect(summarize("Does a thing. Also does another thing.")).toBe("Does a thing.");
  });

  it("caps runaway first sentences with an ellipsis", () => {
    const line = summarize(`${"word ".repeat(60)}end.`, 80);
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("buildManifest", () => {
  it("lists every tool grouped by category with one-line summaries", () => {
    const manifest = buildManifest(fakeCatalog());
    expect(manifest).toContain("3 of 3 tools");
    expect(manifest).toContain("## generation (1)");
    expect(manifest).toContain("## diagnostics (2)");
    expect(manifest).toContain("- gen_image: Generate an image from a prompt.");
    expect(manifest).not.toContain("Long tail of details");
  });

  it("filters by category and search", () => {
    expect(buildManifest(fakeCatalog(), { category: "diagnostics" })).not.toContain("gen_image");
    expect(buildManifest(fakeCatalog(), { search: "liveness" })).toContain("ping");
    expect(buildManifest(fakeCatalog(), { search: "liveness" })).not.toContain("gen_image");
  });

  it("suggests categories when nothing matches", () => {
    const manifest = buildManifest(fakeCatalog(), { search: "no-such-thing" });
    expect(manifest).toContain("No tools matched");
    expect(manifest).toContain("generation, diagnostics");
  });
});

describe("compact mode over a real MCP client/server pair", () => {
  it("exposes exactly the three meta-tools", async () => {
    const client = await compactPair(fakeCatalog());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "describe_tool", "list_tools"]);
  });

  it("list_tools returns the manifest", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "list_tools", arguments: {} });
    expect(textOf(res as never)).toContain("- ping: Report server liveness.");
  });

  it("describe_tool returns the full description and JSON schema", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "describe_tool", arguments: { name: "gen_image" } });
    const text = textOf(res as never);
    expect(text).toContain("Long tail of details");
    expect(text).toContain('"prompt"');
    expect(text).toContain('"required"');
  });

  it("call_tool dispatches to the underlying handler", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: { prompt: "a cat", steps: 4 } },
    });
    expect(textOf(res as never)).toBe("generated:a cat:4");
  });

  it("call_tool accepts JSON-string args (small models double-encode)", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: '{"prompt": "a dog"}' },
    });
    expect(textOf(res as never)).toBe("generated:a dog:default");
  });

  it("call_tool works with omitted args for zero-arg tools", async () => {
    const client = await compactPair(fakeCatalog());
    const res = await client.callTool({ name: "call_tool", arguments: { name: "ping" } });
    expect(textOf(res as never)).toBe("pong");
  });

  it("call_tool returns a schema-bearing validation error on bad args", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "gen_image", args: { steps: 4 } },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const text = textOf(res as never);
    expect(text).toContain("Invalid arguments for gen_image");
    expect(text).toContain("prompt");
    expect(text).toContain("Expected schema");
  });

  it("call_tool and describe_tool suggest alternatives for unknown names", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "gen" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("gen_image");
  });

  it("call_tool converts handler throws into isError results", async () => {
    const client = await compactPair(fakeCatalog());
    const res = (await client.callTool({
      name: "call_tool",
      arguments: { name: "always_throws" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("boom");
  });
});

describe("collectToolCatalog (real tool surface)", () => {
  it("captures the full registered tool surface with schemas intact", async () => {
    const catalog = await collectToolCatalog();
    expect(catalog.tools.size).toBeGreaterThanOrEqual(100);
    for (const expected of ["generate_image", "health_check", "enqueue_workflow", "list_local_models"]) {
      expect(catalog.get(expected), `missing ${expected}`).toBeDefined();
      expect(catalog.get(expected)?.description.length).toBeGreaterThan(20);
    }
    // every static category from the registration table shows up
    const categories = [...catalog.byCategory().keys()];
    for (const c of ["generation", "workflows", "models", "custom-nodes", "server", "diagnostics"]) {
      expect(categories, `missing category ${c}`).toContain(c);
    }
    // and the manifest over the real surface stays token-light (< ~30KB ≈ 7k tokens)
    const manifest = buildManifest(catalog);
    expect(manifest.length).toBeLessThan(30_000);
  }, 30_000);
});
