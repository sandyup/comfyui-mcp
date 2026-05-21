import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Factory invoked once per session to build a fully-configured McpServer. */
  createServer: () => Promise<McpServer> | McpServer;
  /** Path the MCP endpoint is served on (default /mcp). */
  path?: string;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Start a streamable-HTTP MCP server using the canonical SDK session pattern:
 * a new transport + McpServer is created on the initialize request and reused
 * for subsequent requests carrying the mcp-session-id header.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<http.Server> {
  const path = opts.path ?? "/mcp";
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== path) {
        sendJsonError(res, 404, `Not found. MCP endpoint is ${path}`);
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!transport) {
          if (!isInitializeRequest(body)) {
            sendJsonError(res, 400, "No valid session: first request must be an initialize request");
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport!);
              logger.info("HTTP MCP session initialized", { session: sid });
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) transports.delete(sid);
          };
          const server = await opts.createServer();
          await server.connect(transport);
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) {
          sendJsonError(res, 400, "Missing or unknown mcp-session-id");
          return;
        }
        await transport.handleRequest(req, res);
      } else {
        sendJsonError(res, 405, "Method not allowed");
      }
    } catch (err) {
      logger.error("HTTP MCP request error", {
        error: err instanceof Error ? err.message : err,
      });
      if (!res.headersSent) sendJsonError(res, 500, "Internal server error");
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  return httpServer;
}
