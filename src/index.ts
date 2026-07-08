#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { JobWatcher } from "./services/job-watcher.js";
import { parseCliArgs } from "./transport/cli.js";
import { startHttpServer } from "./transport/http.js";

async function createConfiguredServer(): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "comfyui-mcp",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );
  await registerAllTools(server);
  return server;
}

async function main() {
  const cli = parseCliArgs(process.argv);
  await JobWatcher.cleanupOldFiles();

  if (cli.transport === "http") {
    await startHttpServer({
      host: cli.host,
      port: cli.port,
      createServer: createConfiguredServer,
    });
    logger.info(`ComfyUI MCP server running on http://${cli.host}:${cli.port}/mcp`);
  } else {
    const server = await createConfiguredServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("ComfyUI MCP server running on stdio");
  }
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
