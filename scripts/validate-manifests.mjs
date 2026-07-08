#!/usr/bin/env node
// Validate every pack manifest against the real manifestSchema (the same schema
// apply_manifest uses). Requires a prior `npm run build` (imports from dist/).
//
//   npm run build && node scripts/validate-manifests.mjs

import { loadManifestFile } from "../dist/services/manifest.js";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
let bad = 0;

for (const name of readdirSync(packsRoot)) {
  const dir = join(packsRoot, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifest = join(dir, "manifest.yaml");
  if (!existsSync(manifest)) continue;
  try {
    const m = await loadManifestFile(manifest);
    console.log(`OK   ${name} — ${m.custom_nodes.length} nodes, ${m.models.length} models`);
  } catch (e) {
    console.error(`FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`);
    bad = 1;
  }
}

process.exit(bad);
