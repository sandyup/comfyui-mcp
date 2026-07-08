# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added

- **Multi-tab panel bridge.** Each ComfyUI browser tab now holds its own
  identified bridge connection — the panel sends a `hello` frame with a
  per-tab session id and the open workflow's title, `panel_status` lists
  every connected tab, and all graph tools accept an optional `tab_id`
  (full id or 8-char prefix). Routing default when omitted: the only
  connected tab → the tab the user most recently typed in → an error
  listing the tabs. `panel_say` broadcasts unless targeted; inbox entries
  and channel notifications carry which tab/workflow spoke. Previously a
  second tab silently stole the single connection.
- **`panel_clear` tool** — remove every node from the open graph in one
  step; the whole wipe is a single Ctrl+Z undo (panel pack executes it
  inside one `beforeChange`/`afterChange` pair).
- **Panel v0.3 (in progress, [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel)):**
  native ComfyUI design-system restyle (PrimeVue semantic tokens, theme-
  tracking), activity cards for every agent graph edit, empty-state
  onboarding, "Claude is working…" typing indicator. Polished registry
  release **coming soon**.

## [0.11.1] - 2026-06-12

### Added

- **`model-registry` plugin skill** — one curated table of download URLs +
  target `models/` subdirs for every model the skills reference (Flux, WAN,
  LTX, Qwen, Z-Image, shared VAEs/text-encoders), consolidating rows that
  were scattered across `model-settings.json` and individual skills. Grows
  each release. Plugin is now **15 skills**.
- **Plugin ships channels mode by default** — `plugin/.mcp.json` now passes
  `--channels`, so plugin users get the panel bridge + `panel_*` tools
  automatically (pair with the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack).

### Changed

- **Discoverability:** README leads with "the Claude Code plugin for
  ComfyUI" and the real asset counts (88 tools / 15 skills / 11 commands /
  4 agents / 4 hooks — previously undersold as 6 skills / 10 commands);
  corrected the plugin install command (`/plugin marketplace add` +
  `/plugin install comfy`); npm description + keywords expanded; GitHub
  repo topics added (both repos had zero); new docs page
  [`/plugin`](https://comfyui-mcp.artokun.io/docs/plugin) documenting the
  full skill/command/agent/hook surface.

## [0.11.0] - 2026-06-12

### Added

- **Channels mode (`--channels`) — your own agent session drives the ComfyUI
  sidebar panel. No LLM API keys.** The server hosts a loopback WebSocket
  bridge (`COMFYUI_MCP_BRIDGE_PORT`, default 9101) that the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack
  connects to, and registers nine `panel_*` MCP tools (`status`, `get_graph`,
  `add_node`, `remove_node`, `connect`, `disconnect`, `set_widget`, `say`,
  `inbox`). The agent — your existing Claude Code (or any MCP client) session,
  subscription-billed — edits the user's live graph through its MCP
  connection; every mutation is Ctrl+Z-undoable. Messages typed into the panel
  queue for `panel_inbox` and are pushed as `notifications/claude/channel`
  events on hosts that surface them. Bridge design (rid-correlated
  request/reply, loopback-only, last-writer-wins) ported from the author's
  node-lab project. New dependency: `ws`.
- **Live graph edits for the agent panel** (superseded same-day by channels
  mode above, retained as the legacy API-key path). The experimental
  `/api/chat` backend declares six client-side `graph_*` tools that the
  sidebar panel executes against the user's open LiteGraph graph. The panel
  ships as the **comfyui-mcp-panel** pack (the manual drop-in under
  `web/extensions/` is deprecated and will be removed next minor). Epic B
  step 4, built on v1 LiteGraph shims instead of waiting for
  `@comfyorg/extension-api` v2.

## [0.10.1] - 2026-06-12

### Fixed

- **Long jobs no longer killed at 10 minutes.** The job watcher's completion
  timeout was hardcoded to 10 minutes — a 15-minute LTX/WAN video render lost
  its completion notification mid-run. The timeout is now `COMFYUI_JOB_TIMEOUT_S`
  (default 1800 s = 30 min) and the poll cadence is
  `COMFYUI_JOB_POLL_INTERVAL_S` (default 2 s). Gap flagged by
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Changed

- **`/object_info` is now memoized for the life of the server process.**
  `validate_workflow`, dependency extraction, and `lock_workflow` each
  triggered a fresh 300–800 ms `/object_info` fetch; repeat validations now
  serve from cache (comfy-cozy reports the same change took their re-validate
  from ~7 s to ~0.5 s). The cache resets automatically on
  `stop_comfyui` / `restart_comfyui` (the only paths that change the node
  set), with in-flight coalescing on the first fetch. Cloud mode is
  unaffected. Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

## [0.10.0] - 2026-06-11

### Added

- **`lock_workflow` + `verify_workflow_lock`** — provenance sidecars for
  saved workflows. `lock_workflow` walks a workflow's model loaders
  (`CheckpointLoaderSimple`, `UNETLoader`, `VAELoader`, `LoraLoader`,
  `ControlNetLoader`, `CLIPLoader`/`DualCLIPLoader`, `UpscaleModelLoader`,
  …), SHA-256s every referenced model, records the git commit currently
  checked out for every custom node pack the workflow's `class_type`s
  resolve to, captures ComfyUI's reported version, and writes
  `<filename>.lock.json` next to the workflow in ComfyUI's user library.
  `verify_workflow_lock` re-computes the lock and surfaces structured drift
  (changed model SHA-256s, packs on different commits, ComfyUI version
  bumps). Local install required for v1 (SHA-256 needs file bytes;
  commits come from `custom_nodes/*/.git/HEAD`). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).
- **Resumable model downloads.** Big-model fetches (10–40 GB checkpoints over
  flaky connections to HuggingFace / CivitAI / S3) used to start from byte 0
  every retry. The download cache now writes to a deterministic
  `~/.comfyui-mcp/cache/.<hash>.<ext>.partial` file, sends `Range: bytes=N-`
  on the next attempt, appends on `206 Partial Content`, and falls back
  cleanly to a full overwrite when the server replies `200` (Range
  unsupported). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Fixed

- **`list_local_models` now sees `extra_model_paths.yaml` redirects + works
  remotely.** The tool previously did only a filesystem scan of
  `${COMFYUI_PATH}/models/`, so models the user had pointed at via
  `extra_model_paths.yaml` (symlinked to a shared drive, mounted from a NAS,
  etc.) were invisible — a common setup for serious rigs. It also threw
  `ModelError: COMFYUI_PATH is not configured` against remote/cloud
  ComfyUI. We now query ComfyUI's `/models/<dir>` REST endpoint first
  (which reports what's actually available to workflows), fall back to the
  filesystem scan only when the HTTP path yields nothing, and return an
  empty list rather than throwing when neither is available. Size and
  modified time are only populated when the filesystem path is taken.
  Originally contributed by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@e2ae39c8`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/e2ae39c8).

## [0.9.5] - 2026-06-11

Interoperability + paperwork.

### Added

- **MIT `LICENSE` file** at the repo root — `package.json` and the npm registry
  have always declared MIT, but the file itself was absent and downstream
  paperwork checks flagged it. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#27](https://github.com/artokun/comfyui-mcp/issues/27).

### Fixed

- **Federation timeouts on `resources/list` / `prompts/list`** — federating
  clients (LiteLLM, etc.) probe every standard list endpoint on `initialize`
  fan-out regardless of advertised capabilities. We don't expose resources or
  prompts today, so those calls hit the SDK's default "Method not found" path
  and each downstream paid a per-server timeout (~30 s default). We now
  declare both capabilities and answer with empty lists from
  `resources/list`, `resources/templates/list`, and `prompts/list`. No
  behavioral change for clients that only use `tools/*`. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#29](https://github.com/artokun/comfyui-mcp/issues/29).

## [0.9.4] - 2026-06-03

### Fixed

- **TS2742 portability error on pnpm builds (e.g. Glama)** — `tsc` previously
  failed to emit `dist/experimental/provider-registry.d.ts` under pnpm because
  the inferred return type of `getRegistry()` referenced a transitive type from
  `@ai-sdk/provider`, whose pnpm store path (`.pnpm/@ai-sdk+provider@…`) TS
  considers non-portable. We're a CLI/executable, not a library, so declaration
  emission was useless overhead — disabled `declaration` + `declarationMap` in
  `tsconfig.json`. `dist/` now contains only `.js` + `.js.map`; builds pass
  under both `npm` and `pnpm`.

## [0.9.3] - 2026-06-01

### Added

- **`llms-install.md`** — agent-focused install guide at the repo root, what
  Cline and similar agents read preferentially over `README.md` when setting up
  the MCP server. Covers the Node ≥ 22 prerequisite, the three deployment modes
  (local/remote/Comfy Cloud), Claude Code / Cline / Cursor settings recipes,
  optional env vars, verification, and common issues.
- **400×400 marketplace logo** at `docs/logo/mcpmarket-icon-400.png` for the
  Cline MCP Marketplace listing.

## [0.9.2] - 2026-06-01

### Fixed

- **Docker build hang on rate-limited CI (e.g. Glama)** — `npm ci` in the
  Dockerfile no longer runs the `cloudflared` postinstall, which fetches a
  ~40 MB binary from GitHub releases over an `https.get()` call with no
  timeout. On networks where GitHub rate-limits (or otherwise stalls)
  unauthenticated requests, that fetch hung indefinitely and blocked image
  builds. Install scripts are now skipped with `--ignore-scripts` and the
  two native deps we actually need (`better-sqlite3`, `sharp`) are rebuilt
  explicitly. The runtime tunnel helper already downloads the cloudflared
  binary lazily on first use, so no functionality is lost.

## [0.9.1] - 2026-06-01

### Added

- **`get_job_status` cloud-mode coverage** — when `COMFYUI_API_KEY` is set,
  `get_job_status` now dispatches to `cloud-client.getJobStatus` (which calls
  `/api/job/<id>/status`) and maps the cloud
  `{ pending | in_progress | completed | failed }` shape to the existing
  local `JobStatus`. Completed jobs are still enriched from history when
  available; failed jobs surface the cloud's error string via
  `error.exception_message`. Closes part of `comfyui-mcp-eik`.

### Changed

- Refined the `CLOUD_UNSUPPORTED` error message surfaced by tools that need
  a direct ComfyUI session (workflow library, memory management, etc.). The
  message no longer leaks the internal `getClient` function name and clearly
  tells the user to unset `COMFYUI_API_KEY` to target a local or remote
  ComfyUI.
- **Upgraded vitest to ^4.1.0** (dev-only). Clears
  [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
  (Vitest UI server arbitrary file read/exec). Test infrastructure tweaks:
  S3 mock now uses a `function` declaration (vitest 4 invokes mocked
  constructors via `new`) and manager-config fallback tests call
  `vi.clearAllMocks()` explicitly (vitest 4's `restoreAllMocks` no longer
  resets `.mock.calls`). Closes `comfyui-mcp-g6e`.

## [0.9.0] - 2026-06-01

Three deployment modes, slimmer install footprint, and first-class
[Comfy Cloud](https://cloud.comfy.org) support — built from a survey of
forks and a port of the cloud-dispatch architecture from
[@picoSols](https://github.com/picoSols)'s `comfyui-cloud-mcp` fork.

### Added

- **Comfy Cloud mode** — set `COMFYUI_API_KEY` to route HTTP-backed primitives
  (enqueue, history, system stats, queue, view, upload) to `cloud.comfy.org`
  with `X-API-Key` authentication. WebSocket-bound and local-FS/process
  tools throw a clear `CLOUD_UNSUPPORTED` error in this mode. New
  `src/comfyui/cloud-client.ts` mirrors the local client interface so the
  rest of the server is transparent to which backend it's talking to.
  Architecture and dispatcher pattern originally shipped by
  [@picoSols](https://github.com/picoSols) in
  [`picoSols/comfyui-cloud-mcp@7a812069`](https://github.com/picoSols/comfyui-cloud-mcp/commit/7a812069).
- **Explicit remote mode + smart-detect** — when `--comfyui-url` points at a
  non-loopback host (anything other than `127.0.0.1` / `localhost` / `::1` /
  `0.0.0.0`), the server skips `COMFYUI_PATH` auto-detection. This closes
  the root cause behind the 0.8.1 `upload_*` fix — a stale local install can
  no longer silently absorb uploads/downloads the agent intended for the
  remote target. An explicit `COMFYUI_PATH` env var still wins.
- **`isCloudMode()` / `isRemoteMode()` / `isLocalMode()`** config helpers and
  `COMFYUI_CLOUD_URL` (defaults to `https://cloud.comfy.org`).

### Changed

- **Slim install** — moved seven heavy/feature-gated packages out of
  `dependencies` into `optionalDependencies` and dynamic-import them lazily
  via a new `requireOptionalDep` helper:
  `@aws-sdk/client-s3`, `@azure/storage-blob`, `cloudflared`,
  `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`. A
  `npm install --no-optional comfyui-mcp` now yields a working core server;
  features that need a missing optional dep surface a clear
  `OPTIONAL_DEP_MISSING` error with the exact `npm install <pkg>` hint.

### Documentation

- New "Deployment modes" section in `docs/configuration.mdx` covering the
  local / remote / cloud feature parity matrix and the `COMFYUI_API_KEY` /
  `COMFYUI_CLOUD_URL` env vars.

## [0.8.1] - 2026-06-01

Bug-fix release picking up upstream contributions from
[@joaolvivas](https://github.com/joaolvivas)'s fork of comfyui-mcp.

### Added

- **`health_check`** — single-call pre-flight diagnostic that reports
  ComfyUI/Python/PyTorch versions, GPU + VRAM, queue depth, per-category
  `/models` populations (catches empty-dropdown surprises from a
  misconfigured `extra_model_paths.yaml`), and recent errors from
  `/internal/logs`. Read-only. Useful before a long batch or when triaging an
  unexplained failure. Originally contributed by
  [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@de82ecda`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/de82ecda).

### Fixed

- **`search_custom_nodes`** — `api.comfy.org/nodes` accepts a `search` query
  parameter but ignores it server-side, returning the same paginated default
  list regardless of query. We now fetch a larger window (limit=100) and
  rank-filter client-side by id / name / author / description with a
  popularity boost, so query-relevant packs actually appear. Diagnosed and
  patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@f066b597`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/f066b597);
  port adds a guard so popularity no longer inflates non-matching packs.
- **`upload_image` / `upload_video` / `upload_audio`** — HTTP-only.
  Previously these tools fell back to a local filesystem copy if HTTP upload
  failed and `COMFYUI_PATH` was set. When `COMFYUI_PATH` was auto-detected to
  an unrelated install (common for users targeting a remote `--comfyui-url`),
  the fallback wrote the file to the wrong tree and reported success, while
  the remote ComfyUI never received it — the next `LoadImage` then failed
  mysteriously. Now HTTP-only against the connected ComfyUI's
  `/upload/image` endpoint, which works for both local and remote. Diagnosed
  and patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@089180ad`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/089180ad).

## [0.8.0] - 2026-05-26

Completes the custom-node authoring lifecycle, adds cloud storage I/O and
declarative setup, and adds node discovery — all built and reviewed in a
codex implement→review→fix loop.

### Added

- **`apply_manifest`** — declarative environment setup from an inline object or
  a JSON/YAML manifest: `pip` packages, `custom_nodes` (registry ids or git URLs
  with `@ref`), and `models`. Idempotent, per-item structured report; `apt`
  entries are accepted but skipped (manual/root). Local-only.
- **`verify_custom_node`** — the "test" step of the author loop: restarts ComfyUI
  (with a bounded readiness wait) and confirms a pack's `NODE_CLASS_MAPPINGS`
  class_types registered in `/object_info` (a failed import simply never appears).
- **`scaffold_custom_node`** now also emits `.comfyignore`/`.gitignore` and, with
  `with_ci`, a `.github/workflows/publish_action.yml` (Comfy-Org/publish-node-action).
- **`convert_image`** — re-encode a generated image (by `asset_id` or output-dir
  path) to PNG/JPEG/WebP via `sharp`; returns inline base64 + optional file write
  (output-dir confined), and reports bytes saved.
- **Cloud storage** — model downloads may be `s3://` or Azure Blob URLs
  (`download_model` gains `s3` auth); new **`upload_output`** pushes a generated
  output to S3 / Azure / HTTP / Hugging Face and returns URL(s).
- **`download_model` `auth`** — per-request `bearer`/`basic`/`header`/`query`
  authentication for gated/private hosts (carried over and extended).
- **`comfy-researcher` agent** — turns a problem statement into ranked custom-node
  pack recommendations (searches the Registry, evaluates, delegates deep dives to
  `comfy-explorer`).
- **Cached `generate_node_skill`** — read-through cache keyed by source@version
  (`COMFYUI_SKILL_CACHE_DIR`; `refresh` to bypass), so repeat analyses are instant.

### Security

- `apply_manifest` rejects pip argv-option injection; realpath/symlink-safe path
  containment for manifest model paths, `convert_image`, and upload sources;
  `convert_image` caps source size + sharp pixels.
- Cloud storage: Azure SAS / AWS presigned secrets redacted from logs/errors;
  Azure URL-vs-env account mismatch rejected; HF-CLI remote-path argv hardening;
  manual redirect handling (no cross-origin auth replay or upload-redirect SSRF).

### Fixed

- `generate_node_skill` cache resolves the current pack version before lookup
  (no stale docs served after a pack updates) and writes atomically (temp +
  rename with a content-hash check).

### Dependencies

- Added `yaml` (manifest parsing), `sharp` (image conversion), `@aws-sdk/client-s3`
  and `@azure/storage-blob` (cloud storage). `npm audit`: 0 high vulnerabilities.

## [0.7.0] - 2026-05-25

Stability + authoring release: hardens model downloads and the ComfyUI process
lifecycle, makes failures actionable, and adds a custom-node authoring/publishing
lifecycle. Plus a hosted docs site and an experimental embedded-agent backend.

### Added

- **Custom-node authoring** — `scaffold_custom_node` (generate a Python node pack
  from a template) and `publish_custom_node` (publish to the Comfy Registry via
  comfy-cli; key via `REGISTRY_ACCESS_TOKEN`, never logged) (#24).
- **`install_custom_node` ref pinning** — pin a pack to a commit/branch/tag, parsed
  from GitHub/GitLab/Bitbucket URLs or `repo@ref`, or an explicit `ref` arg.
- **`download_model` auth** — per-request `bearer` / `basic` / `header` / `query`
  authentication for gated/private model hosts.
- **Model download cache** — content-addressed dedup, concurrent-download coalescing,
  and optional LRU eviction (`COMFYUI_DOWNLOAD_CACHE_DIR`, `COMFYUI_LRU_CACHE_SIZE_GB`).
- **ComfyUI process supervision** — bounded startup readiness checks
  (`COMFYUI_STARTUP_CHECK_INTERVAL_S`/`_MAX_TRIES`) and opt-in bounded
  auto-restart-on-crash (`COMFYUI_ALWAYS_RESTART`, `COMFYUI_RESTART_MAX_ATTEMPTS`,
  `COMFYUI_RESTART_WINDOW_S`).
- **Plugin skills** — `comfyui-frontend-extensions` (v2 `@comfyorg/extension-api`
  authoring + v1→v2 migration) and `comfyui-node-registry` (node authoring/publishing).
- **Hosted docs** — Mintlify site with a schema-generated tool reference at
  [comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs).

### Changed

- **`get_job_status` + completion notifications** now surface ComfyUI
  `execution_error` detail (node id/type, exception type/message, truncated traceback,
  `current_inputs`, OOM flag) and optional per-node + total execution timing.
  Additive and backward-compatible.

### Security

- `download_model` auth inputs are validated (reject CR/LF/control chars; HTTP-token
  header names); query-auth secrets are redacted from logs and error details.
- `install_custom_node` git refs are validated and run via `git checkout
  --end-of-options <ref>`, closing an argv-option-injection vector.
- Spawned ComfyUI children now have `error` listeners so a missing/failed executable
  can't crash the MCP server.

### Experimental

- **Embedded-agent backend POC** (flag-gated via `COMFYUI_MCP_AGENT_POC`): a cloudflared
  quick-tunnel helper + an AI SDK `/api/chat` endpoint with bearer auth, a request body
  cap, and a server-side model allowlist. Not part of default startup. See
  `design/embedded-agent-panel.md` and `ROADMAP.md`.

### Dependencies

- Added `ai` + `@ai-sdk/anthropic`/`openai`/`google` + `cloudflared` (experimental POC)
  and declared `zod-to-json-schema` (docs generation). `npm audit`: 0 high vulnerabilities.

## [0.6.1] - 2026-05-25

### Added

- **Media upload** — `upload_video` and `upload_audio` copy local video/audio
  files into ComfyUI's input directory so they can be referenced as workflow
  inputs, mirroring the existing `upload_image` (closes #12).

## [0.6.0] - 2026-05-25

A large feature release that ports much of the [`comfy-cli`](https://github.com/Comfy-Org/comfy-cli)
workflow into MCP tools. New tools operate on the connected ComfyUI (local or a
remote `--comfyui-url` target), preferring the ComfyUI-Manager HTTP API with a
subprocess fallback where the API can't do the job.

### Added — comfy-cli capability port

- **Custom-node management** — `install_custom_node`, `update_custom_node`,
  `reinstall_custom_node`, `fix_custom_node`, `list_installed_nodes`,
  `sync_node_dependencies` (#15)
- **Node snapshots** — `save_node_snapshot`, `restore_node_snapshot`,
  `list_node_snapshots`; honors comfy-cli's `.json`/`.yaml` snapshot contract (#13)
- **Node bisect** — `bisect_start`, `bisect_good`, `bisect_bad`, `bisect_reset`,
  `bisect_status` to isolate a faulty custom node; never re-enables packs you had
  disabled before the session (#14)
- **Workflow dependencies** — `extract_workflow_dependencies`,
  `install_workflow_dependencies` (handles API- and UI-format workflows) (#16)
- **Install ComfyUI** — `install_comfyui`: clones ComfyUI (+ ComfyUI-Manager) and
  installs requirements into a dedicated workspace virtualenv (#17)
- **Update** — `update_comfyui` (core) and `update_all` (all custom nodes) (#18)
- **Models** — `remove_model` (path-safe) and `download_civitai_model` (#19)
- **Workspace & environment** — `get_workspace`, `set_default_workspace`,
  `list_workspaces`, `get_environment` (#20)
- **API / partner nodes** — `list_api_nodes`, `get_api_node_schema`,
  `generate_with_api_node` (#21)
- **ComfyUI-Manager configuration** — `configure_manager` (#22)

### Changed

- Rewrote tool descriptions and parameter docs across the core tool set for
  clearer purpose, usage guidance, and behavioral transparency — improving agent
  tool-selection quality (#23).
- Added a `Dockerfile`, `.dockerignore`, `glama.json`, and Glama quality badges
  for the [glama.ai](https://glama.ai) listing.

### Security

- CivitAI authentication is now sent as an `Authorization: Bearer` header instead
  of a `?token=` query parameter, so the API token no longer leaks into logs,
  errors, or redirect URLs. Model-download filenames are validated to stay within
  the models directory (closes a path-traversal hole shared with `download_model`) (#19).
- `COMFY_API_KEY` is delivered to API nodes via the `/prompt` `extra_data` payload
  rather than being placed in the workflow (#21).

### Notes

- Local-management tools (install/update ComfyUI, custom-node installs, model
  removal) require a local install (`COMFYUI_PATH`) and return a clear error when
  targeting a remote instance where the operation cannot apply.

Earlier releases predate this changelog.

[0.11.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.1
[0.11.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.0
[0.10.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.1
[0.10.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.0
[0.9.5]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.5
[0.9.4]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.4
[0.9.3]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.3
[0.9.2]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.2
[0.9.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.1
[0.9.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.0
[0.8.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.1
[0.8.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.0
[0.7.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.7.0
[0.6.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.1
[0.6.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.0
