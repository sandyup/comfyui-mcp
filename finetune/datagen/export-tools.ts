/**
 * Dump the FULL comfyui-mcp tool surface (name + description + category +
 * JSON Schema for all ~113 tools) to finetune/data/tools-full.json.
 *
 * Every training trajectory and eval run renders its tool list from this file,
 * so the model always trains against the exact schemas it will see at runtime.
 *
 * Run:  npm run ft:tools     (tsx; sets COMFYUI_URL so config.ts skips its
 * network port-probe at import time, same trick as docs:gen)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Env must be set before the tool modules load (config.ts probes at import).
process.env.COMFYUI_URL ??= "http://127.0.0.1:8188";
// Keep a developer's autoloaded workflows out of the canonical tool list.
process.env.COMFYUI_WORKFLOWS_DIR = mkdtempSync(join(tmpdir(), "comfyui-mcp-ft-"));

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(repoRoot, "finetune", "data");

async function main() {
  const { z } = await import("zod");
  const { collectToolCatalog } = await import("../../src/tools/index.js");
  const { buildPanelToolDefs } = await import("../../src/orchestrator/panel-tools.js");

  mkdirSync(outDir, { recursive: true });

  // 1. Headless MCP surface (113 tools) — what the agent uses for generation,
  //    queue, models, workflows.
  const catalog = await collectToolCatalog();
  const tools = [...catalog.tools.values()].map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.schema ?? {}), { reused: "inline" }),
  }));
  const mcpPayload = JSON.stringify({ count: tools.length, tools }, null, 2);
  writeFileSync(join(outDir, "tools-full.json"), mcpPayload);

  // 2. Panel live-canvas surface (panel_* tools) — the second half of the panel
  //    agent's deployed surface. Same JSON-schema shape as the MCP tools.
  const panelTools = buildPanelToolDefs().map((t) => ({
    name: t.name,
    category: "panel",
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.schema ?? {}), { reused: "inline" }),
  }));
  const panelPayload = JSON.stringify({ count: panelTools.length, tools: panelTools }, null, 2);
  writeFileSync(join(outDir, "tools-panel.json"), panelPayload);

  // 3. Combined surface — what the panel agent deploys with in full mode.
  const combined = [...tools, ...panelTools];
  writeFileSync(join(outDir, "tools-combined.json"), JSON.stringify({ count: combined.length, tools: combined }, null, 2));

  const tok = (s: string) => Math.round(s.length / 4);
  console.log(`[ft:tools] MCP ${tools.length} tools (${mcpPayload.length} chars ≈ ${tok(mcpPayload)} tok) → tools-full.json`);
  console.log(`[ft:tools] panel ${panelTools.length} tools (${panelPayload.length} chars ≈ ${tok(panelPayload)} tok) → tools-panel.json`);
  console.log(`[ft:tools] combined ${combined.length} tools ≈ ${tok(mcpPayload) + tok(panelPayload)} tok → tools-combined.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
