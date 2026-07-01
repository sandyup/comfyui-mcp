#!/usr/bin/env node
// E2E: a small local model (via Ollama) drives the compact tool mode
// (COMFYUI_MCP_TOOL_MODE=compact) over real MCP stdio — the setup issue #97
// asks for. Requires: `npm run build`, an Ollama server, and a pulled
// tool-calling model (default qwen3:4b; gemma3 has no native tool support).
//
//   npm run test:local-llm
//   OLLAMA_MODEL=llama3.2:3b OLLAMA_HOST=http://127.0.0.1:11434 npm run test:local-llm
//
// Pass criteria:
//   1. the compact server exposes exactly 3 meta-tools
//   2. the model navigates the catalog (list_tools and/or describe_tool) unaided
//   3. call_tool dispatches a real underlying tool successfully
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:4b";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

try {
  const res = await fetch(`${OLLAMA}/api/version`);
  if (!res.ok) throw new Error(`http ${res.status}`);
} catch (err) {
  fail(`Ollama not reachable at ${OLLAMA} (${err.message}). Start it with \`ollama serve\` and pull the model: \`ollama pull ${MODEL}\`.`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: {
    ...process.env,
    COMFYUI_MCP_TOOL_MODE: "compact",
    COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
    COMFYUI_MCP_AUTOUPDATE: "0",
    LOG_LEVEL: "error",
  },
});
const mcp = new Client({ name: "local-llm-e2e", version: "0.0.0" });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
console.log(`[mcp] compact mode exposes: ${tools.map((t) => t.name).join(", ")}`);
if (tools.length !== 3) fail(`expected exactly 3 meta-tools, got ${tools.length}`);

const ollamaTools = tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

const messages = [
  {
    role: "system",
    content:
      "You control a ComfyUI MCP server through exactly three tools: list_tools (catalog), " +
      "describe_tool (one tool's parameters), call_tool (run a tool by name with args). " +
      "Always look up a tool with describe_tool before running it with call_tool. " +
      "Catalog entries are tool NAMES, not data — never answer from the catalog alone; " +
      "complete every task by actually running a tool with call_tool.",
  },
  {
    role: "user",
    content:
      "Search the ComfyUI custom-node registry for 'controlnet' and tell me the name of one node pack you found.",
  },
];

const stats = { toolCalls: [], sawCallTool: false, callToolOk: false, nudges: 0 };

for (let round = 0; round < 10; round++) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: ollamaTools,
      stream: false,
      options: { num_ctx: 16384, temperature: 0 },
    }),
  });
  if (!res.ok) fail(`ollama /api/chat http ${res.status}: ${await res.text()}`);
  const { message } = await res.json();
  messages.push(message);

  if (!message.tool_calls?.length) {
    // Small models sometimes answer straight off the catalog. Real harnesses
    // (Hermes, OpenClaw) nudge here; allow the same correction once.
    if (!stats.sawCallTool && stats.nudges < 1) {
      stats.nudges++;
      console.log(`[nudge] model answered without running a tool — correcting`);
      messages.push({
        role: "user",
        content:
          "You have not run any tool yet — catalog entries are tool names, not data. " +
          "Use describe_tool on a search tool, then run it with call_tool, and answer from its results.",
      });
      continue;
    }
    console.log(`\n[model final answer]\n${message.content}\n`);
    break;
  }

  for (const tc of message.tool_calls) {
    const name = tc.function.name;
    const args =
      typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
    console.log(`[round ${round + 1}] model -> ${name}(${JSON.stringify(args).slice(0, 160)})`);
    stats.toolCalls.push(name);
    if (name === "call_tool") stats.sawCallTool = true;

    let text;
    try {
      const result = await mcp.callTool({ name, arguments: args });
      text = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (name === "call_tool" && !result.isError) stats.callToolOk = true;
    } catch (err) {
      text = `MCP error: ${err.message}`;
    }
    console.log(`  [mcp result ${text.length} chars] ${text.slice(0, 120).replace(/\n/g, " ")}…`);
    messages.push({ role: "tool", tool_name: name, content: text.slice(0, 12000) });
  }
}

await mcp.close();
// let the stdio child finish tearing down — avoids a libuv assert on Windows
// when process.exit races the transport's child-process close.
await new Promise((r) => setTimeout(r, 250));

console.log(`[stats] toolCalls=[${stats.toolCalls.join(", ")}]`);
const usedCatalog =
  stats.toolCalls.includes("list_tools") || stats.toolCalls.includes("describe_tool");
if (stats.sawCallTool && stats.callToolOk && usedCatalog) {
  console.log("PASS: local model completed the compact-mode loop (catalog -> dispatch -> answer).");
  process.exit(0);
}
fail(`sawCallTool=${stats.sawCallTool} callToolOk=${stats.callToolOk} usedCatalog=${usedCatalog}`);
