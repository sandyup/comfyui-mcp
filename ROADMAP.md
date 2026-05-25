# ComfyUI MCP — Roadmap

**Vision:** an agent can author, run, *fix*, and *ship* ComfyUI — from a prompt, to a working
workflow, to an in-UI assistant that edits the graph live, to a published custom node. comfyui-mcp
is the backend tool surface; the pieces below extend it up into the ComfyUI frontend and out to the
Comfy Registry.

> Tracking: themes map to beads **epics**; items map to issues. Run `bd ready` for what's actionable.
> This file is the human-readable map; beads is the source of truth for status.

---

## ✅ Shipped (0.6.x)
- comfy-cli capability port (custom-node mgmt, snapshots, bisect, workflow deps, install/update,
  models, workspace/env, API nodes, manager config) — tools surface ~70+.
- `upload_video` / `upload_audio`.
- Mintlify docs site (schema-generated tool reference) at comfyui-mcp.artokun.io/docs.
- Glama listing + TDQS A-grade pass; blog post (TDQS case study).

---

## Theme A — Frontend extension authoring (enabler)
The new ComfyUI frontend extension API (`@comfyorg/extension-api`, v2; replaces
`app.registerExtension`) is brand-new and absent from model training data. Teach it so we (and any
user) can write correct frontend extensions — the substrate for Theme B.

- **A1 — Skill: author v2 extensions.** `defineNode`/`defineExtension`/`defineWidget`,
  `defineSidebarTab`, `NodeHandle`/`WidgetHandle`, event namespaces (`execution`/`graph`/`server`/
  `workbench`), `DisposableHandle` contract, identity helpers, the event+getter/setter idiom.
- **A2 — Skill: migrate v1 → v2.** Map legacy `app.registerExtension` / prototype-patching patterns
  to the v2 API (the ecosystem dashboard's api-diff/patterns are the source). DrJKL collaboration hook.
  > Source: `Comfy-Org/ComfyUI_frontend` PRs #12142–#12145; `src/extension-api/`. Package not yet on npm.

## Theme B — Embedded agent panel (north star)
A ComfyUI **sidebar tab** (AI icon) hosting an [AI SDK](https://sdk.vercel.ai) chat window. You chat
with Claude Code / Codex / Gemini and it reads + **fixes the live workflow in the UI**. Connection
to the agent "app" is via a **cloudflared tunnel** (Ungate-style). Full design:
[`design/embedded-agent-panel.md`](./design/embedded-agent-panel.md).

- **B1 — Tunnel helper.** Port Ungate's `tunnel-manager` (the `cloudflared` npm lib:
  `Tunnel.quick(localUrl) → public https URL`) into our server as `startQuickTunnel(port)`, behind a flag.
- **B2 — AI SDK chat endpoint.** `POST /api/chat` → `streamText(...).toUIMessageStreamResponse()`,
  provider registry (Anthropic/OpenAI/Google), one real server-side tool end-to-end.
- **B3 — Sidebar panel.** `defineSidebarTab` + AI SDK `useChat` pointed at the tunnel; render stream.
- **B4 — Live graph edits.** Graph-mutation tools (`set_widget_value`, `add_node`, `connect`, …) as
  AI SDK **client-side tools** resolved in the panel via extension-api (`NodeHandle`/`WidgetHandle`).
  *This is the magic — "fix it in the UI."*
- **B5 — Wire comfyui-mcp** as the server-side tool surface via AI SDK MCP client.
- **B6 — Provider switch + connection/key UX + ship** as a node pack.

## Theme C — Custom-node authoring lifecycle (NEW)
Create a Python custom node from a template, install + restart to test, then publish to the
[Comfy Registry](https://docs.comfy.org/registry/overview). The full "agent builds & ships a node" loop.

- **C1 — Skill: ComfyUI Registry + custom-node authoring.** Minimal node structure
  (`__init__.py`, `NODE_CLASS_MAPPINGS`/`NODE_DISPLAY_NAME_MAPPINGS`, `INPUT_TYPES`/`RETURN_TYPES`/
  `FUNCTION`/`CATEGORY`, optional `WEB_DIRECTORY`), `pyproject.toml` (`[project]` + `[tool.comfy]`:
  `PublisherId`/`DisplayName`/`Icon`), publisher + API key flow, `comfy node init`/`publish`, the
  `Comfy-Org/publish-node-action` CI workflow + `REGISTRY_ACCESS_TOKEN`.
- **C2 — MCP `scaffold_custom_node`.** Generate a node pack into `custom_nodes/<name>/` from a
  template (prefer `comfy node init`; fall back to our own template). Local-only.
- **C3 — Test loop.** Install → `restart_comfyui` (have it) → verify the new `class_type` appears in
  `/object_info` → enqueue a smoke-test workflow using it.
- **C4 — MCP `publish_custom_node`.** `comfy node publish` with token; validate `pyproject.toml`
  metadata first. Token via env (never in URLs/logs), like the CivitAI pattern.
- **C5 — Template + CI scaffold.** A spawnable starter (Python node + optional v2 frontend +
  `publish_action.yml`) so `create → restart → test → publish` is one smooth path.

## Theme D — Discovery (from prior notes)
- **D1 — `comfy-researcher` agent + skill cache.** Problem→packs research over the Registry +
  HF + community, with a cached skill layer. (Folded in from `TODO.md`.)

---

## "Roadmap to the roadmap" — sequencing

| Phase | Goal | Items |
| --- | --- | --- |
| **0 — now (parallel)** | Enablers + node lifecycle + panel backend POC | A1, A2, C1, C2, C4, B1, B2 |
| **1 — prove the loop** | Live in-UI editing works | B3, B4, C3, C5 |
| **2 — productionize** | Full agent panel + discovery | B5, B6, D1 |

Phase 0 ships value immediately (skills + node tooling) and de-risks the panel (tunnel + streaming)
before any frontend work. Phase 1 needs the v2 package closer to publish for the panel UI.
