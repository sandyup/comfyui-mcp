# Design — Remote ComfyUI and Comfy Cloud modes

**Status:** Draft, 2026-06-01
**Beads:** `comfyui-mcp-m1p` (Comfy Cloud evaluation)
**Sources surveyed:**
- `picoSols/comfyui-cloud-mcp` — added Comfy Cloud (`cloud.comfy.org`) as a deployment target
- `joaolvivas/comfyui-mcp-byjlucas` — HTTP-first refactor of file-bound tools for remote setups

## Why this doc

Today `comfyui-mcp` is **local-first**: many tools need `config.comfyuiPath` (process control, model removal, manifest, install, etc.) and the rest reach a "ComfyUI" identified by host:port. Two forks have independently pushed the project toward two related but distinct deployment shapes:

1. **Remote ComfyUI** — user runs ComfyUI on a RunPod / server / VPS, reaches it via `--comfyui-url`. The HTTP API works; filesystem and process control do not. Today some of our "remote-friendly" tools still have local-filesystem fallbacks that hide failures.
2. **Comfy Cloud** — `cloud.comfy.org` exposes a ComfyUI-shaped REST API (no WebSocket, no `/internal/logs`, no process control) authenticated with `X-API-Key`. Users in this mode don't have a "ComfyUI process" at all.

We have a strategic decision to make: do we want to be the canonical MCP for **all three** (local, remote, cloud), or stay opinionated about local-first?

## Survey: picoSols Comfy Cloud fork

PR-equivalent: `picoSols/comfyui-cloud-mcp@7a812069` (feat: Comfy Cloud API support).

### Architecture they shipped

- Added `comfyuiApiKey` + `comfyuiCloudUrl` to `configSchema`. New env vars: `COMFYUI_API_KEY`, `COMFYUI_CLOUD_URL` (defaults to `https://cloud.comfy.org`).
- `isCloudMode(): boolean` — returns `!!parsedConfig.comfyuiApiKey`. Acts as the dispatch switch.
- In cloud mode, **skip local port auto-detection** entirely (no `detectComfyUIPort` call).
- New file `src/comfyui/cloud-client.ts` (~346 LOC) — re-implements the surface area that `src/comfyui/client.ts` exposes (enqueue, history, system stats, queue, interrupt, view, object info, samplers/schedulers/checkpoints/loras/vaes/upscalers/logs) against `cloud.comfy.org` using `X-API-Key` headers and raw `fetch`.
- `src/comfyui/client.ts` becomes a **dispatcher**:
  - Functions that have a cloud equivalent get an `if (isCloudMode()) return cloudClient.fn(...)` prologue.
  - Functions that fundamentally can't work in cloud mode (`getClient`, `connectClient`, `ensureConnected` — anything WebSocket-bound) call `requireLocalMode("op")` that throws `ComfyUIError("CLOUD_UNSUPPORTED")`.
- `JobWatcher` gate: WebSocket attach is wrapped in `if (!isCloudMode())`. Cloud mode falls through to the existing HTTP-polling path that the local watcher already uses as a fallback.

### What's missing / opinionated

- No model-management tools touched. In cloud mode, models are pre-provisioned by Comfy-Org — `download_model`, `remove_model`, `list_local_models` should either be no-ops or surface a cloud-specific listing endpoint.
- No `/internal/logs` equivalent in cloud — picoSols returns `[]`. Our `health_check` (just landed from João Lucas) would degrade gracefully there.
- No process control coverage — the fork doesn't say what happens, but our `requireLocalMode` shim would correctly reject `start_comfyui`/`stop_comfyui`/`restart_comfyui`/`install_comfyui`/`apply_manifest`/etc.

## Survey: João Lucas remote-HTTP refactor

PR-equivalents:
- `joaolvivas/comfyui-mcp-byjlucas@089180ad` — `upload_image` HTTP-only (removed deceptive filesystem fallback)
- `joaolvivas/comfyui-mcp-byjlucas@e2ae39c8` — same pattern across `image-management.ts` + `model-resolver.ts`

### The deceptive-fallback bug

Current `src/tools/image-management.ts:104-119` (and `upload_video` / `upload_audio` mirrors at L:208–230):

```ts
try {
  // HTTP first (works remote)
  const result = await uploadImageAuto(...);
  return success;
} catch (httpErr) {
  // Fallback: filesystem copy if COMFYUI_PATH is set
  const result = await uploadImage(...);
  return success;  // ← LIES when COMFYUI_PATH is auto-detected stale
}
```

The auto-detection in `config.ts` happily resolves `~/ComfyUI` or `/opt/ComfyUI` even when the user is targeting a remote `--comfyui-url`. If HTTP fails (server down, wrong URL, network blip), the fallback writes the file into an **unrelated local install** and returns "success" — but the remote ComfyUI the agent will actually `enqueue` against never received the file. The next workflow run fails with "LoadImage: file not found" and the agent has no breadcrumb back to the upload step.

João's fix: drop the fallback entirely. HTTP-only, fail loud. His tool description updates to "Works with both local and remote ComfyUI instances" (because the local HTTP endpoint of course also works).

**Recommendation:** Pull this in, separately from cloud support, as a 0.8.1 fix. Affects three tools: `upload_image`, `upload_video`, `upload_audio`.

### Other João changes in scope

- `model-resolver.ts` (+37/-7) — likely makes model-existence checks remote-friendly (instead of `existsSync(localPath)`, ask ComfyUI via `/object_info` or `/models/{cat}`). Worth a closer read before deciding whether to port.
- `client.ts` (+70/-1) — HTTP-first paths for things we currently do filesystem-first.
- Partner-node auto-inject `api_key_comfy_org` (4b989e47) — comparison vs our existing `COMFY_API_KEY → extra_data` mechanism from 0.6.0. Likely duplicative.

## Proposed direction

### Three modes, three roles

| Mode | How user opts in | Local FS? | Process control? | WebSocket? | Process tools should… |
|---|---|---|---|---|---|
| **Local** | `COMFYUI_PATH` set or auto-detected | yes | yes | yes | work |
| **Remote** | `--comfyui-url` and no FS path (or FS path explicitly cleared) | no | no | yes | throw "remote-only target" |
| **Cloud** | `COMFYUI_API_KEY` set | no | no | no | throw "cloud-only target" |

Today we conflate "local" and "remote" because auto-detection silently fills in a local `COMFYUI_PATH` that may not match the `--comfyui-url` target. That's the root cause of João's deceptive-fallback bug.

### Phased adoption

**Phase 1 — Pull the bug fixes (no architecture change).** [0.8.1 patch]
- João's `upload_image`/`upload_video`/`upload_audio` HTTP-only fix.
- Read `model-resolver.ts` diff and decide on remote-aware model checks.
- Credit @joaolvivas in CHANGELOG.

**Phase 2 — Explicit remote mode.** [0.9.0]
- Add a `--remote-only` / `COMFYUI_REMOTE_ONLY=true` flag that suppresses `COMFYUI_PATH` auto-detection.
- All local-only tools (process control, install, manifest, model removal, model download cache materialization) check `config.comfyuiPath` and throw a clear `ProcessControlError("remote target — tool requires a local install path")` instead of silently degrading.
- Document the three modes explicitly in `docs/configuration.mdx`.

**Phase 3 — Comfy Cloud first-class.** [0.9.0 stretch or 0.10.0]
- Adopt picoSols's `isCloudMode()` + `cloud-client.ts` shape.
- Build the feature-parity matrix (which tools work in cloud? which throw?).
- Decide cloud-model-listing API (does `cloud.comfy.org` expose pre-provisioned model lists? if yes, wire `list_local_models` to it).
- Consider reaching out to Comfy-Org about a partnership listing.
- Credit @picoSols in CHANGELOG; consider co-authorship in commits.

### Open questions for the maintainer

1. Do we want to commit to cloud support? Strategic: it makes `comfyui-mcp` the right MCP for anyone using Comfy Cloud, which broadens the audience but also makes us a partner-of-record. If yes, an outreach to Comfy-Org alongside the implementation feels right.
2. For Phase 2's explicit remote mode — do we silently fix the auto-detection (don't fill in `COMFYUI_PATH` if `--comfyui-url` is a non-loopback host) or require users to opt in?
3. For the `upload_*` fix: ship as 0.8.1 patch alongside the search/health fixes from `df8050e`, or wait for the bigger 0.9.0 mode rework?

## Attribution

- **Comfy Cloud architecture, dispatch pattern, cloud-client.ts shape:** [@picoSols](https://github.com/picoSols) — `picoSols/comfyui-cloud-mcp@7a812069` (2026-03-25).
- **HTTP-first refactor + deceptive-fallback diagnosis:** [@joaolvivas](https://github.com/joaolvivas) — `joaolvivas/comfyui-mcp-byjlucas@089180ad` and `@e2ae39c8` (2026-05-12).
