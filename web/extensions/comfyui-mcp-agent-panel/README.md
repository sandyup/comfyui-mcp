# comfyui-mcp Agent Panel — v1 ComfyUI extension

> **⚠️ DEPRECATED — install [`comfyui-mcp-panel`](https://github.com/artokun/comfyui-mcp-panel) instead.**
> The panel now ships as a proper custom-node pack (installable via
> ComfyUI-Manager / the Comfy Registry) and gained **live graph edits** —
> the agent can add/remove/connect nodes and set widget values on your open
> graph, all Ctrl+Z-undoable. This manual drop-in file will be removed in the
> next minor release. Settings carry over automatically (same localStorage
> keys, same extension id — having both installed won't double-register).

A drop-in sidebar tab for ComfyUI that hosts a chat UI talking to the
[experimental agent backend](../../../src/experimental/agent-poc.ts) shipped
with `comfyui-mcp`. This is the **v1 implementation** — built against today's
`app.registerExtension(...)` API. It will be ported to the v2
`@comfyorg/extension-api` package the moment that ships
(Comfy-Org PRs #12142–#12145); v1-specific call sites are tagged
`// TODO(v2):` in the source.

## Install

1. Copy **`comfyui-mcp-agent-panel.js`** (single file, no dependencies) into
   one of these locations — ComfyUI auto-loads any `.js` it finds inside them:
   - `<ComfyUI>/web/extensions/comfyui-mcp-agent-panel.js`, or
   - `<ComfyUI>/custom_nodes/<your-pack>/web/comfyui-mcp-agent-panel.js`.
2. Hard-reload the ComfyUI page (`Cmd/Ctrl+Shift+R`).
3. A new **Agent** tab (chat icon) appears in the left sidebar.

The README and this directory layout exist for repo hygiene only — ComfyUI
does **not** consume the README.

## Start the backend

In a separate terminal at the repo root:

```bash
COMFYUI_MCP_AGENT_POC=1 \
  COMFYUI_MCP_AGENT_TUNNEL=1 \
  ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
  npm run dev:agent-poc
```

The server prints two values you need:

- `chat server listening on http://127.0.0.1:8765/api/chat` — the local URL,
  fine if ComfyUI runs on the same machine over `http://`.
- `public URL: https://<random>.trycloudflare.com` — required if ComfyUI is
  served over HTTPS or on a remote host (browser mixed-content would block a
  plain-`localhost` POST otherwise).
- `session token: <hex>` — the bearer token.

## Configure the panel

Open the **Agent** tab → **Connection** section, then paste:

- **Backend URL** — `https://<random>.trycloudflare.com` (or
  `http://localhost:8765` for same-machine HTTP setups).
- **Bearer token** — the hex string from the server stdout.

Click **Save** (or just hit **Send** — the panel persists the live input
values whenever a request is dispatched, so explicit Save is optional).
Both values persist in `window.localStorage` under
`comfyui-mcp.agent-panel.backendUrl` / `comfyui-mcp.agent-panel.token`.

> **Backend URL forms accepted.** The panel normalizes `…/`, `…/api`, and
> `…/api/chat` suffixes — paste whatever the server logged.

> **Security:** the bearer token can spend on your provider API keys.
> `localStorage` is per-origin readable by every script on the ComfyUI page —
> rotate the token (restart the POC) if you suspect leakage.

## What it can do (POC scope)

- Stream chat replies from the configured provider (Claude / Codex / Gemini —
  picked server-side via `src/experimental/provider-registry.ts`).
- Surface a tool card whenever the model calls the POC `generate_image` tool;
  the backend stubs the actual ComfyUI workflow execution and returns a
  placeholder result.

Live graph edits (`set_widget_value`, `add_node`, etc.) are **not yet** wired
— that's step 4 in `design/embedded-agent-panel.md` and depends on either
the v2 `extension-api` `WidgetHandle` surface or our own v1 shims around
`LiteGraph`.

## Files

- `comfyui-mcp-agent-panel.js` — the entire extension (one file, no build).
- `README.md` — this file.

The SSE parser embedded in the panel JS is byte-equivalent to
`src/experimental/ui-message-stream-parser.ts` (which has vitest coverage at
`src/__tests__/experimental/ui-message-stream-parser.test.ts`). Keep them in
sync if you change either.

## V1 → V2 migration plan

When `@comfyorg/extension-api` lands on npm:

| v1 (this file) | v2 |
|----------------|----|
| `window.app.registerExtension({ name, setup })` | `defineExtension({ name, setup() {} })` |
| `app.extensionManager.registerSidebarTab({ id, title, icon, type:'custom', render, destroy })` | `defineSidebarTab({ id, title, icon, type:'custom', render, destroy })` |
| Embedded `parseUiMessageStream` JS | `import { parseUiMessageStream } from '...'` (a real bundler enters the picture) |

See `plugin/skills/comfyui-frontend-extensions/references/migrate-v1-to-v2.md`
for the full mapping.
