# Embedded agent panel — Ungate extraction → AI-SDK chat inside ComfyUI

> North star: a ComfyUI **sidebar tab** (AI icon) that hosts a chat window. You talk to a coding
> agent (Claude Code / Codex / Gemini) and it **reads and fixes the live workflow in the UI**.
> Connection to the agent "app" is set up via a **cloudflared tunnel**, modeled on how the
> [Ungate](https://github.com/orchidfiles/ungate) VS Code extension connects Cursor to a local proxy.

## 1. What Ungate is (reference architecture, MIT)

Three tiers in a pnpm monorepo (`~/code/ungate`):

- **`apps/extension`** (VS Code host) — lifecycle + supervision:
  - `tunnel-manager.ts` — wraps the [`cloudflared`](https://www.npmjs.com/package/cloudflared) npm package.
  - `api-server.ts` — spawns the local proxy as a detached child, parses its port from stdout,
    health-checks `/health`, restarts/auto-stops.
  - `dashboard.ts` + webview — hosts the Svelte UI, relays messages.
- **`apps/api`** (local proxy) — Fastify server: provider OAuth (Claude/ChatGPT), Anthropic↔OpenAI
  translation, tool-call mapping, streaming, `/health`. Listens on `0.0.0.0:PORT`, prints
  `localhost:PORT` to stdout. This is the part that turns a **subscription** into an OpenAI-shaped endpoint.
- **`apps/web`** (webview UI) — Svelte dashboard: tunnel panel, provider auth, analytics. Talks to
  the host via `postMessage` (`start-tunnel` / `tunnel-status` / …).

Flow: `Cursor chat → Cursor backend → Cloudflare tunnel → Ungate proxy → Provider API → back`.
Tunnel exists because **Cursor's backend can't call `localhost`** — it needs a public HTTPS URL.

## 2. The bits that matter (verbatim mechanics)

### 2a. Tunnel mechanic — the crux (`tunnel-manager.ts`)
```ts
import { bin, install, use, Tunnel } from 'cloudflared';
// ensure binary: if !fs.existsSync(bin) → install(<path>) then use(<path>)
const t = Tunnel.quick(`http://localhost:${port}`, {
  '--config': process.platform === 'win32' ? 'NUL' : '/dev/null',
  '--edge-ip-version': '4',
});
t.on('url',   (url)  => { /* public https://<rand>.trycloudflare.com */ });
t.on('stderr',(line) => { /* logs */ });
t.on('error', (err)  => { /* error state */ });
t.on('exit',  (code) => { /* stopped/error */ });
t.stop();
```
State machine: `stopped → starting → (installing) → running → error`. Auto-stops on an interval
when there are no live clients. **This is plain Node — it drops straight into our server; no VS Code needed.**

### 2b. Local-server supervision (`api-server.ts`)
- `cp.spawn(node, [entry], { detached: true })`, `.unref()`.
- Detect ready by regex-matching `localhost:(\d+)` on stdout.
- Poll `GET /health` on an interval; restart on crash; stop after a no-clients grace period.
- Reattach to an already-running instance on `EADDRINUSE` (multi-window safe).

### 2c. Connection UX + messaging (`apps/web` tunnel-store + `$shared/vscode`)
- Reactive `TunnelState { status, url, error }` rendered in a panel.
- Buttons post intents to the host (`start-tunnel`/`stop-tunnel`/`restart-tunnel`); host pushes
  `tunnel-status` back. User **copies the public URL + a proxy key** into the client.

### 2d. Security model (README)
- CORS `origin: '*'` on the proxy (tunnel is the perimeter).
- **Tunnel URL + proxy key are secrets**; anyone with both can drive your proxy. Key is rotatable.
- OAuth/provider creds stored locally only.

## 3. Mapping → our stack (AI SDK + ComfyUI extension-api)

| Ungate piece | Our equivalent | Keep / Replace / New |
| --- | --- | --- |
| `tunnel-manager.ts` (cloudflared) | Same lib, lifted into our local app | **Keep** (port nearly verbatim) |
| `api-server.ts` supervisor | We *are* the server (no separate child needed at first) | **Simplify** |
| `apps/api` Fastify proxy + provider OAuth/translation | **AI SDK** `streamText` + provider registry (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) | **Replace** (AI SDK does translation/streaming/tools) |
| Cursor (the client) | **ComfyUI sidebar tab** with AI SDK `useChat` | **Replace** |
| VS Code webview + `postMessage` | ComfyUI `defineSidebarTab` (Vue) + HTTP/WS to tunnel | **Replace** |
| Webview tunnel panel (copy URL+key) | Panel "Connection" section (paste/auto URL + key) | **Keep shape** |
| — (Ungate has none) | **Live graph edits** via `NodeHandle`/`WidgetHandle` as AI SDK *client-side tools* | **New (the magic)** |
| comfyui-mcp tools | Server-side tools via AI SDK MCP client (`experimental_createMCPClient`) | **Keep + wire in** |

## 4. Target shape

### "The app" — local bridge (we build; likely extends comfyui-mcp)
A Node HTTP server on `localhost:PORT`:
- `POST /api/chat` → AI SDK `streamText({ model, messages, tools }).toUIMessageStreamResponse()`.
- **Provider registry** picks Claude / Codex(OpenAI) / Gemini per request (the pluggable "agent").
- **Tools**:
  - *server-side* (have `execute`): generate, search/download models, build/modify/enqueue big
    workflows, queue mgmt — backed by **comfyui-mcp** (consumed as MCP tools).
  - *client-side* (no `execute`; resolved in the panel): `read_graph`, `set_widget_value`,
    `add_node`, `connect`, `move_node`, … → executed via extension-api in the browser.
- `GET /health` for supervision; CORS open (tunnel is the perimeter); a bearer **session key**.
- **cloudflared `Tunnel.quick`** exposes it → public HTTPS URL the ComfyUI page can reach (even when
  ComfyUI is remote or served over HTTPS — solves mixed-content + remote installs).

### ComfyUI panel — `defineSidebarTab` (AI icon)
- AI SDK `useChat({ api: <tunnelURL>/api/chat, headers: { Authorization: Bearer <key> } })`.
- **Connection** section: paste/auto-discover tunnel URL + key (Ungate `TunnelPanel` analog).
- Renders streamed messages + tool-call cards.
- `onToolCall` → for graph-mutation tools, call extension-api (`NodeHandle.setValue(...)`, etc.),
  then `addToolResult(...)`. This is how "fix the workflow directly in the UI" happens — through the
  same undo-able command path a human uses. Live context comes from `graph`/`execution` events.

## 5. Key adaptations vs. Ungate
- **Same tunnel direction** (expose local app over HTTPS so a remote/HTTPS ComfyUI reaches it).
- **Drop the OAuth-subscription proxy for v1** — AI SDK + provider keys is far less code. (If we
  later want Ungate's "use your subscription, not API tokens," `apps/api/src/auth/*` is the part to lift.)
- **Client-side tool execution is the novel core** — Ungate only proxies; we additionally let the
  model *act on the open graph* via extension-api.

## 6. Build order
0. **v2 authoring skill** (enabler — write the extension correctly).
1. **Tunnel helper** — port `tunnel-manager` into our server (`startQuickTunnel(port) → url`), behind a flag.
2. **AI SDK chat endpoint** — `/api/chat` with one server-side tool (`generate_image`) end-to-end.
3. **Sidebar skeleton** — `defineSidebarTab` + `useChat` hitting the tunnel; render stream.
4. **Live edit** — one client-side tool (`set_widget_value`) applied via `WidgetHandle`; prove the loop.
5. **Wire comfyui-mcp** as the server-side tool surface (MCP client); expand client-side graph tools.
6. **Provider switch** (Claude/Codex/Gemini) + connection/key UX + polish into a shippable node pack.

## References
- Ungate (MIT): https://github.com/orchidfiles/ungate — clone at `~/code/ungate`.
- `cloudflared` npm: https://www.npmjs.com/package/cloudflared
- ComfyUI v2 extension API: `Comfy-Org/ComfyUI_frontend` PRs #12142–#12145; `src/extension-api/`.
- AI SDK: provider registry, `streamText`, `useChat`, client-side tools (`onToolCall`/`addToolResult`),
  MCP client (`experimental_createMCPClient`).
