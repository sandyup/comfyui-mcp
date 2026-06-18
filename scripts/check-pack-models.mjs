#!/usr/bin/env node
// Cross-check every pack's workflow.json against its manifest.yaml so a loader
// node can't reference a model file the pack never downloads (and vice versa).
//
// This is the guard that was missing when two packs shipped a VAELoader pointing
// at `ae.safetensors` while their installers only fetched a different VAE — the
// node throws a missing-model error on load, but nothing caught it in review.
//
//   node scripts/check-pack-models.mjs              # all packs
//   node scripts/check-pack-models.mjs packs/ernie  # one pack
//
// Exit non-zero if any workflow references a model the manifest doesn't provide.
// Dead downloads (provided but never referenced) are reported as warnings only.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsRoot = join(repoRoot, "packs");

// File extensions that denote a model weight the pack must provide.
const MODEL_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$/i;

// Loader widget values are sometimes a sentinel rather than a real file.
const SENTINELS = new Set(["none", "undefined", "null", ""]);

// Node types that fetch their own weights on first run (the model is NOT the
// manifest's responsibility): controlnet-aux preprocessors, RIFE interpolation,
// and the kijai DownloadAndLoad* nodes. A reference from one of these is never
// a manifest gap.
const SELF_MANAGING = /(^DownloadAndLoad)|Preprocessor$|RIFE|InsightFace/i;
const isSelfManaging = (type) => SELF_MANAGING.test(String(type || ""));

function packDirs() {
  const arg = process.argv[2];
  if (arg) return [join(repoRoot, arg)];
  return readdirSync(packsRoot)
    .map((n) => join(packsRoot, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "manifest.yaml")));
}

// Compare by basename, lowercased — manifest local_paths and workflow widget
// values disagree on subfolders (e.g. "loras\\style\\x.safetensors" vs
// "loras/x.safetensors"), but the filename ComfyUI loads is the same.
const norm = (p) => basename(String(p).replace(/\\/g, "/")).toLowerCase();

// Files a manifest downloads (basename of local_path, else filename, else URL).
function providedFiles(manifest) {
  const out = new Map(); // norm -> display name
  for (const m of manifest.models || []) {
    let name;
    if (m.local_path) name = basename(m.local_path);
    else if (m.filename) name = m.filename;
    else if (m.url) {
      try {
        name = basename(new URL(m.url).pathname);
      } catch {
        name = m.url;
      }
    }
    if (name) out.set(norm(name), name);
  }
  return out;
}

// Model files referenced by a workflow's loader nodes. We scan widgets_values
// (the value ComfyUI actually loads) for strings ending in a model extension —
// NOT node.properties.models, which is a download hint that is often stale.
function referencedFiles(workflow) {
  const refs = new Map(); // norm -> { name, nodes: [{type,id,bypassed}] }
  const record = (val, node) => {
    if (typeof val !== "string") return;
    if (SENTINELS.has(val.toLowerCase())) return;
    if (!MODEL_EXT.test(val)) return;
    const key = norm(val);
    if (!refs.has(key)) refs.set(key, { name: val, nodes: [] });
    refs.get(key).nodes.push({
      type: node.type,
      id: node.id,
      bypassed: node.mode === 2 || node.mode === 4,
    });
  };
  const walk = (v, node) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, node));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, node));
    else record(v, node);
  };
  for (const node of workflow.nodes || []) walk(node.widgets_values, node);
  return refs;
}

let errors = 0;
let warnings = 0;

for (const dir of packDirs()) {
  const name = basename(dir);
  const manifest = parse(readFileSync(join(dir, "manifest.yaml"), "utf8")) || {};
  const packPath = join(dir, "pack.yaml");
  const pack = existsSync(packPath) ? parse(readFileSync(packPath, "utf8")) || {} : {};
  const wfFile = pack.workflow || "workflow.json";
  const wfPath = join(dir, wfFile);
  if (!existsSync(wfPath)) {
    console.log(`SKIP ${name} — no ${wfFile}`);
    continue;
  }

  const provided = providedFiles(manifest);
  const referenced = referencedFiles(JSON.parse(readFileSync(wfPath, "utf8")));
  // Files the workflow legitimately references but the pack intentionally does
  // not download (user-supplied LoRAs, etc.). Declared in pack.yaml so the gap
  // is explicit and reviewed, not silent. Compared by basename.
  const allowed = new Set((pack.external_models || []).map(norm));

  // An ACTIVE loader pointing at a file the manifest doesn't provide is a hard
  // error (ComfyUI flags it missing on load). The same from a bypassed node, a
  // self-managing node, or an allow-listed file is a warning at most.
  const hardMissing = [];
  const softMissing = [];
  for (const [key, info] of referenced) {
    if (provided.has(key)) continue;
    if (allowed.has(key)) continue;
    const liveLoaders = info.nodes.filter((n) => !n.bypassed && !isSelfManaging(n.type));
    (liveLoaders.length ? hardMissing : softMissing).push(info);
  }
  // Dead downloads: provided but no loader references them. Often intentional
  // (alt quants, optional upscalers), so this is a warning, not an error.
  const unused = [];
  for (const [key, disp] of provided) {
    if (!referenced.has(key)) unused.push(disp);
  }

  if (hardMissing.length === 0) {
    console.log(`OK   ${name} — ${referenced.size} model refs, no live gaps`);
  }
  for (const info of hardMissing) {
    const where = info.nodes
      .map((n) => `${n.type}#${n.id}${n.bypassed ? "(bypassed)" : ""}`)
      .join(", ");
    console.error(`FAIL ${name} — workflow references "${info.name}" not downloaded by manifest [${where}]`);
    errors++;
  }
  for (const info of softMissing) {
    console.warn(`warn ${name} — "${info.name}" referenced only by bypassed/self-managing nodes, not in manifest`);
    warnings++;
  }
  for (const disp of unused) {
    console.warn(`warn ${name} — manifest downloads "${disp}" but no loader references it`);
    warnings++;
  }
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
