#!/usr/bin/env node
// Validate every model URL in every pack manifest WITHOUT downloading the file:
//  - the link resolves (HTTP 200 via HEAD, or 206 via a 1-byte ranged GET)
//  - Content-Length falls in a sane band for the model type (folder), so a dead
//    link returning a small HTML error page is caught as "too small".
//
//   node scripts/check-model-urls.mjs            # all packs
//   node scripts/check-model-urls.mjs packs/anima
//
// Exit non-zero if any URL is unreachable or implausibly sized.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Minimum plausible size per model category (top folder under models/).
// Generous on the ceiling; the floor is the real signal (catches error pages).
const FLOOR = {
  diffusion_models: 100 * MB,
  unet: 80 * MB,
  checkpoints: 100 * MB,
  text_encoders: 40 * MB,
  clip: 40 * MB,
  vae: 8 * MB,
  loras: 512 * 1024,
  controlnet: 512 * 1024,
  upscale_models: 1 * MB,
  ultralytics: 1 * MB,
  sams: 40 * MB,
};
const DEFAULT_FLOOR = 256 * 1024;
const CEILING = 80 * GB;
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsRoot = join(repoRoot, "packs");

function packDirs() {
  const arg = process.argv[2];
  if (arg) return [join(repoRoot, arg)];
  return readdirSync(packsRoot)
    .map((n) => join(packsRoot, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "manifest.yaml")));
}

function category(m) {
  if (m.local_path) return m.local_path.split(/[\\/]/)[0];
  return m.model_type || "checkpoints";
}

function human(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= GB) return (n / GB).toFixed(2) + "GB";
  if (n >= MB) return (n / MB).toFixed(1) + "MB";
  return (n / 1024).toFixed(0) + "KB";
}

const RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch with retries: transient network errors, timeouts, 429s and 5xx are
// retried with linear backoff so one hiccup against a CDN doesn't fail CI.
async function fetchRetry(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`HTTP ${r.status}`);
      } else {
        return r;
      }
    } catch (e) {
      lastErr = new Error(e?.name === "AbortError" ? "timeout" : e?.message ?? String(e));
    } finally {
      clearTimeout(t);
    }
    if (attempt < RETRIES - 1) await sleep(600 * (attempt + 1));
  }
  throw lastErr ?? new Error("request failed");
}

async function probe(url) {
  try {
    const r = await fetchRetry(url, { method: "HEAD", redirect: "follow" });
    // Gated repos (HF 🔒) answer 401/403 without a token — the link is valid,
    // it just needs auth. Treat as OK (size unverifiable without the token).
    if (r.status === 401 || r.status === 403) return { ok: true, gated: true, status: r.status, size: NaN };
    const len = r.headers.get("content-length");
    if (r.ok && len) return { ok: true, status: r.status, size: Number(len) };
    // Fallback: a 1-byte ranged GET yields the total via Content-Range, no download.
    const g = await fetchRetry(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
    try { await g.body?.cancel(); } catch { /* ignore */ }
    const cr = g.headers.get("content-range"); // "bytes 0-0/12345"
    if (cr && cr.includes("/")) {
      const total = Number(cr.split("/").pop());
      if (Number.isFinite(total)) return { ok: g.status === 206 || g.ok, status: g.status, size: total };
    }
    const len2 = g.headers.get("content-length");
    return { ok: r.ok || g.ok, status: g.ok ? g.status : r.status, size: len2 ? Number(len2) : NaN };
  } catch (e) {
    return { ok: false, status: 0, size: NaN, error: e?.message ?? String(e) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const tasks = [];
for (const dir of packDirs()) {
  const manifest = parse(readFileSync(join(dir, "manifest.yaml"), "utf8")) || {};
  for (const m of manifest.models || []) {
    tasks.push({ pack: basename(dir), model: m, cat: category(m) });
  }
}

console.log(`Checking ${tasks.length} model URLs across ${new Set(tasks.map((t) => t.pack)).size} packs...\n`);

let bad = 0;
const results = await mapLimit(tasks, CONCURRENCY, async (t) => {
  const r = await probe(t.model.url);
  const floor = FLOOR[t.cat] ?? DEFAULT_FLOOR;
  let verdict = "OK";
  if (!r.gated) {
    if (!r.ok) verdict = `BAD LINK (${r.error || "HTTP " + r.status})`;
    else if (!Number.isFinite(r.size)) verdict = "NO SIZE (server gave no length)";
    else if (r.size < floor) verdict = `TOO SMALL (${human(r.size)} < floor ${human(floor)} for ${t.cat})`;
    else if (r.size > CEILING) verdict = `TOO BIG (${human(r.size)})`;
  }
  if (verdict !== "OK") bad++;
  return { ...t, ...r, verdict };
});

let curPack = "";
for (const r of results) {
  if (r.pack !== curPack) { curPack = r.pack; console.log(`# ${curPack}`); }
  const name = r.model.local_path ? basename(r.model.local_path) : basename(new URL(r.model.url).pathname);
  const mark = r.verdict === "OK" ? "ok " : "ERR";
  console.log(`  [${mark}] ${name.padEnd(48)} ${human(r.size).padStart(8)}  ${r.verdict === "OK" ? "" : "<- " + r.verdict}`);
}

console.log(`\n${results.length - bad}/${results.length} OK`);
if (bad) { console.error(`${bad} model URL(s) failed validation.`); process.exit(1); }
