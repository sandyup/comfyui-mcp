#!/usr/bin/env node
// Verify that a pack workflow actually RENDERS on a live ComfyUI: optionally
// activate it (strip the rgthree group-toggle bypass into a standalone graph),
// convert UI->API via the same converter the MCP uses, POST to /prompt, and
// poll for success. This is the codified slice/strip/verify recipe — the engine
// behind splitting the toggle-template packs into standalone validated packs.
//
//   npm run build   # convertUiToApi comes from dist/
//   node scripts/verify-render.mjs packs/<pack>/workflow.json [--activate] \
//        [--input <name>] [--comfy http://127.0.0.1:8188] [--timeout 600]
//
// --activate    un-bypass every node (top-level + subgraph internals) EXCEPT the
//               opt-in prompt-enhancer LLM (TextGenerate), mirroring how a pipeline
//               group's toggle would activate it. Use on a raw toggle-template
//               slice; omit for an already-activated pack workflow.
// --input NAME  set every LoadImage's image widget to NAME (for img2img graphs).
// Exits non-zero if /prompt rejects the graph or execution errors.

import { readFileSync } from "node:fs";
import { convertUiToApi, collectNodeTypes } from "../dist/services/workflow-converter.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const COMFY = val("--comfy", process.env.COMFYUI_URL || "http://127.0.0.1:8188");
const TIMEOUT = Number(val("--timeout", "600")) * 1000;
const KEEP_BYPASSED = new Set(["TextGenerate"]); // opt-in enhancer LLM, default off

if (!file) { console.error("usage: verify-render.mjs <workflow.json> [--activate] [--input name]"); process.exit(2); }

const ui = JSON.parse(readFileSync(file, "utf8"));

if (has("--activate")) {
  let n = 0;
  const unbyp = (nd) => { if ((nd.mode === 2 || nd.mode === 4) && !KEEP_BYPASSED.has(nd.type)) { nd.mode = 0; n++; } };
  for (const nd of ui.nodes ?? []) unbyp(nd);
  for (const d of ui.definitions?.subgraphs ?? []) for (const nd of d.nodes ?? []) unbyp(nd);
  console.log(`activated: un-bypassed ${n} nodes (enhancer LLM left off)`);
}

const objectInfo = await fetch(`${COMFY}/object_info`).then((r) => r.json());
// Backfill node types missing from the bulk /object_info (e.g. controlnet_aux's
// DWPreprocessor registers individually but isn't in the bulk response).
for (const t of collectNodeTypes(ui)) {
  if (!t || t in objectInfo) continue;
  try {
    const r = await fetch(`${COMFY}/object_info/${encodeURIComponent(t)}`);
    if (r.ok) { const d = await r.json(); if (d && d[t]) { objectInfo[t] = d[t]; console.log(`backfilled object_info: ${t}`); } }
  } catch {}
}
const { workflow, warnings } = convertUiToApi(ui, objectInfo);
const left = Object.values(workflow).filter((v) => ["SetNode", "GetNode"].includes(v.class_type));
console.log(`converted: ${Object.keys(workflow).length} api nodes, ${warnings.length} warnings, ${left.length} unresolved Set/Get`);
for (const w of warnings) console.log("  warn:", w);

// Static check only: convert + report unresolved nodes/buses, no GPU render.
// Use this from parallel agents so they don't contend for the single ComfyUI GPU.
if (has("--convert-only")) {
  const unknown = warnings.filter((w) => /not found in object_info/.test(w)).length;
  const ok = warnings.length === 0 && left.length === 0;
  console.log(ok ? "CONVERT-OK" : `CONVERT-ISSUES (${unknown} unknown nodes, ${left.length} unresolved Set/Get)`);
  process.exit(ok ? 0 : 1);
}

const input = val("--input", null);
if (input) for (const v of Object.values(workflow)) if (v.class_type === "LoadImage") v.inputs.image = input;

// POST
const res = await fetch(`${COMFY}/prompt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: workflow, client_id: "verify-render" }),
});
if (!res.ok) {
  const j = await res.json().catch(() => ({}));
  console.error("REJECTED:", j.error?.message ?? res.status);
  for (const [nid, info] of Object.entries(j.node_errors ?? {}).slice(0, 8))
    console.error(`  node ${nid} (${workflow[nid]?.class_type}):`, JSON.stringify(info.errors ?? info).slice(0, 160));
  process.exit(1);
}
const { prompt_id } = await res.json();
console.log("queued:", prompt_id);

// poll
const t0 = Date.now();
while (Date.now() - t0 < TIMEOUT) {
  const h = await fetch(`${COMFY}/history/${prompt_id}`).then((r) => r.json());
  const rec = h[prompt_id];
  if (rec) {
    const st = rec.status ?? {};
    const imgs = Object.values(rec.outputs ?? {}).flatMap((o) => (o.images ?? []).map((i) => i.filename));
    const err = (st.messages ?? []).find((m) => m[0] === "execution_error");
    if (err) {
      console.error(`FAILED: ${err[1].node_type} — ${err[1].exception_message?.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(`RENDERED: ${st.status_str}, ${imgs.length} image(s):`, imgs.slice(0, 8).join(", "));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error("TIMEOUT waiting for render");
process.exit(1);
