import { describe, expect, it, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../transport/http.js";

function stubServerFactory(): McpServer {
  const server = new McpServer(
    { name: "test-comfyui-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.tool("ping", "Returns pong", {}, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  server.tool(
    "echo",
    "Echoes the message",
    { message: z.string() },
    async ({ message }) => ({ content: [{ type: "text" as const, text: message }] }),
  );
  return server;
}

let httpServer: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  httpServer = undefined;
});

async function connectClient(): Promise<{ client: Client; port: number }> {
  httpServer = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer: stubServerFactory,
  });
  const port = (httpServer.address() as AddressInfo).port;
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  client = c;
  return { client: c, port };
}

describe("startHttpServer (streamable-HTTP)", () => {
  it("completes an MCP handshake and lists tools over HTTP", async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["echo", "ping"]);
  });

  it("executes a tool call over HTTP", async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: "echo", arguments: { message: "hi there" } });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    );
    expect(text?.text).toBe("hi there");
  });

  it("returns 404 for non-/mcp paths", async () => {
    httpServer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      createServer: stubServerFactory,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("rejects a POST that is not an initialize request with 400", async () => {
    httpServer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      createServer: stubServerFactory,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
