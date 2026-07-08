#!/usr/bin/env node
// Build + push the FULL (fat) RunPod template image to Docker Hub.
//
//   npm run runpod:release            # auto-increments the 1.x tag
//   npm run runpod:release -- 2.0     # explicit tag
//
// This is the image the RunPod template pulls (artokun/comfyui-mcp-runpod on
// Docker Hub) — the GitHub Actions workflow only builds the LEAN variant to
// ghcr.io (standard runners can't hold the 63 GB donor pull), so the fat
// template image is released from a dev machine with Docker + the layer cache.
//
// The panel git-clone layer is cache-busted with the CURRENT panel main SHA so
// every release bakes the latest panel (boot auto-update then keeps it fresh).
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "artokun/comfyui-mcp-runpod";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CTX = join(ROOT, "docker", "runpod");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
const capture = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// current panel main SHA (no local clone needed)
const panelSha = capture(
  "git ls-remote https://github.com/artokun/comfyui-mcp-panel.git refs/heads/main",
).split(/\s+/)[0];
if (!/^[0-9a-f]{40}$/.test(panelSha)) {
  console.error("could not resolve panel main SHA");
  process.exit(1);
}

// tag: explicit arg, or auto-increment the highest local 1.x
let tag = process.argv[2];
if (!tag) {
  const tags = capture(`docker images ${REPO} --format "{{.Tag}}"`)
    .split(/\r?\n/)
    .map((t) => /^(\d+)\.(\d+)$/.exec(t))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2])])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const last = tags.at(-1) ?? [1, 0];
  tag = `${last[0]}.${last[1] + 1}`;
}

console.log(`building ${REPO}:${tag} (+latest) — panel @ ${panelSha.slice(0, 8)}, fat (extras + spotcheck)`);
run("docker", [
  "build",
  "--build-arg", `PANEL_CACHEBUST=${panelSha}`,
  "-t", `${REPO}:${tag}`,
  "-t", `${REPO}:latest`,
  CTX,
]);
run("docker", ["push", `${REPO}:${tag}`]);
run("docker", ["push", `${REPO}:latest`]);
console.log(`\nreleased ${REPO}:${tag} and :latest — new RunPod pods pick it up on creation.`);
