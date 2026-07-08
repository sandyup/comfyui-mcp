#!/usr/bin/env node
// Slice ONE pipeline out of a toggle-template pack workflow into a standalone,
// activated graph. Picks the SaveImage/output nodes inside the named groups,
// takes their backward dependency closure (through links + Set/Get buses),
// un-bypasses the kept nodes (leaving the opt-in enhancer LLM off), and writes a
// standalone UI workflow with only the subgraph defs it uses.
//
//   node scripts/slice-pipeline.mjs <src/workflow.json> <out.json> "<grpA>,<grpB>,..."
//
// Group args are case-insensitive substrings of group titles whose output nodes
// seed the slice (shared post-proc like UPSCALE/GRAIN/SHARP are pulled in
// automatically via the closure). Verify the result with verify-render.mjs.

import { readFileSync, writeFileSync } from "node:fs";

const [src, out, groupCsv] = process.argv.slice(2);
if (!src || !out || !groupCsv) {
  console.error('usage: slice-pipeline.mjs <src.json> <out.json> "<grp substrs csv>"');
  process.exit(2);
}
const wantGroups = groupCsv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const wf = JSON.parse(readFileSync(src, "utf8"));
const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
const links = new Map((wf.links ?? []).filter((l) => Array.isArray(l) && l.length >= 6).map((l) => [l[0], l]));
const groups = wf.groups ?? [];
const KEEP_BYPASSED = new Set(["TextGenerate"]);

const inBox = (pos, b) => pos && b && pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3];
const groupOf = (n) => groups.find((g) => inBox(n.pos, g.bounding))?.title ?? "";
const wantNode = (n) => { const t = groupOf(n).toLowerCase(); return wantGroups.some((w) => t.includes(w)); };

// bus maps
const setByBus = new Map(), getBus = new Map();
for (const n of wf.nodes) {
  if (n.type === "SetNode") setByBus.set(n.widgets_values?.[0], n.id);
  else if (n.type === "GetNode") getBus.set(n.id, n.widgets_values?.[0]);
}
const incoming = (id) => {
  const n = nodes.get(id), s = new Set();
  for (const inp of n?.inputs ?? []) { const l = links.get(inp.link); if (l) s.add(l[1]); }
  if (n?.type === "GetNode" && setByBus.has(getBus.get(id))) s.add(setByBus.get(getBus.get(id)));
  return s;
};
const closure = (seed) => {
  const seen = new Set(), st = [...seed];
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); for (const s of incoming(x)) st.push(s); }
  return seen;
};

const SINK = new Set(["SaveImage", "VHS_VideoCombine", "SaveVideo", "SaveAudio", "PreviewImage"]);
const seeds = wf.nodes.filter((n) => SINK.has(n.type) && wantNode(n)).map((n) => n.id);
if (!seeds.length) { console.error("no output/SaveImage nodes found in the named groups:", groupCsv); process.exit(1); }
const keep = closure(seeds);

const isSg = (id) => String(nodes.get(id)?.type ?? "").length === 36;
const newNodes = [...keep].map((id) => structuredClone(nodes.get(id)));
let un = 0;
for (const n of newNodes) if ((n.mode === 2 || n.mode === 4) && !KEEP_BYPASSED.has(n.type)) { n.mode = 0; un++; }
const newLinks = (wf.links ?? []).filter((l) => Array.isArray(l) && l.length >= 6 && keep.has(l[1]) && keep.has(l[3]));
const usedDefs = new Set([...keep].filter(isSg).map((id) => nodes.get(id).type));
const newWf = { ...wf, nodes: newNodes,
  links: newLinks,
  groups: groups.filter((g) => [...keep].some((id) => inBox(nodes.get(id)?.pos, g.bounding))),
  definitions: { subgraphs: (wf.definitions?.subgraphs ?? []).filter((d) => usedDefs.has(d.id)) } };

// integrity
const kept = new Set(keep);
const bad = newLinks.filter((l) => !kept.has(l[1]) || !kept.has(l[3])).length;
const orphanGets = newNodes.filter((n) => n.type === "GetNode" && !(setByBus.has(getBus.get(n.id)) && kept.has(setByBus.get(getBus.get(n.id))))).length;
writeFileSync(out, JSON.stringify(newWf, null, 2));
console.log(`${out}: ${newNodes.length} nodes (un-bypassed ${un}), ${newLinks.length} links, ${newWf.definitions.subgraphs.length} subgraphs | seeds=${seeds.length} bad_links=${bad} orphan_gets=${orphanGets}`);
