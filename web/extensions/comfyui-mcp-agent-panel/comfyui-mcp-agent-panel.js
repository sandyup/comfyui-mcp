// =============================================================================
// comfyui-mcp Agent Panel — v1 ComfyUI frontend extension.
//
// Registers a sidebar tab inside ComfyUI that hosts a chat UI talking to our
// experimental backend (src/experimental/agent-poc.ts). Drop this single file
// into ComfyUI's `web/extensions/` directory (or the user's
// `ComfyUI/custom_nodes/<pack>/web/` dir) and reload the page.
//
// Wire format: the backend's `POST /api/chat` returns an AI SDK v6 UI Message
// Stream (Server-Sent Events). We parse `text-start`/`text-delta`/`text-end`
// to append streaming text, and `tool-input-available` /
// `tool-output-available` to render a tool card.
//
// Settings (panel UI; persisted via window.localStorage under
// `comfyui-mcp.agent-panel.*`):
//   - `backendUrl`  — public URL the panel POSTs to (e.g. the cloudflared
//                     trycloudflare.com URL or `http://localhost:8765`).
//   - `token`       — bearer token printed on the server's stdout.
// Both are required before the first message can be sent.
//
// SECURITY NOTE: localStorage is per-origin readable by any script on the
// ComfyUI page. The bearer token grants spend on the user's provider keys —
// don't share workflow JSON containing it, and rotate it (restart the POC) if
// you suspect leakage.
//
// V1→V2 MIGRATION: this file uses `window.app.registerExtension(...)` (v1) and
// `app.extensionManager.registerSidebarTab(...)`. When the v2 npm package
// `@comfyorg/extension-api` (PRs #12142–#12145) ships, the equivalent calls
// are `defineExtension({ setup() { ... } })` + `defineSidebarTab({ id, title,
// type: 'custom', icon, render, destroy })`. Every v1-specific call below is
// marked `// TODO(v2):` — see
// `plugin/skills/comfyui-frontend-extensions/references/migrate-v1-to-v2.md`.
// =============================================================================

// ---------------------------------------------------------------------------
// AI SDK UI Message Stream parser. Kept byte-equivalent to the TS module at
// `src/experimental/ui-message-stream-parser.ts` (which has vitest coverage).
// We can't import that TS module here because this file is loaded directly
// by ComfyUI's browser with no bundler.
// ---------------------------------------------------------------------------
function parseUiMessageStream(buffer) {
  const chunks = [];
  let done = false;
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const frame of parts) {
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let payload = line.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      dataLines.push(payload);
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        chunks.push(parsed);
      }
    } catch {
      // ignore malformed frames
    }
  }
  return { chunks, remainder, done };
}

// ---------------------------------------------------------------------------
// localStorage-backed settings (small, sync, plenty for the POC).
// ---------------------------------------------------------------------------
const STORAGE_KEY_BACKEND = "comfyui-mcp.agent-panel.backendUrl";
const STORAGE_KEY_TOKEN = "comfyui-mcp.agent-panel.token";

function loadSettings() {
  try {
    return {
      backendUrl: window.localStorage.getItem(STORAGE_KEY_BACKEND) ?? "",
      token: window.localStorage.getItem(STORAGE_KEY_TOKEN) ?? "",
    };
  } catch {
    return { backendUrl: "", token: "" };
  }
}

function saveSettings(s) {
  try {
    window.localStorage.setItem(STORAGE_KEY_BACKEND, s.backendUrl ?? "");
    window.localStorage.setItem(STORAGE_KEY_TOKEN, s.token ?? "");
  } catch {
    // localStorage may be unavailable in private/locked-down browsers; the
    // panel just becomes session-scoped in that case.
  }
}

// ---------------------------------------------------------------------------
// Tiny id helper for UIMessage ids. The AI SDK accepts any unique string.
// ---------------------------------------------------------------------------
function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Build the panel DOM. Returns { root, destroy } so the host can mount/unmount.
// ---------------------------------------------------------------------------
function buildPanel() {
  const root = document.createElement("div");
  root.className = "comfyui-mcp-agent-panel";
  root.style.cssText = `
    display: flex; flex-direction: column; height: 100%;
    padding: 8px; gap: 8px; box-sizing: border-box;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--input-text, #ddd); background: var(--comfy-menu-bg, #222);
  `;

  // ---- Settings strip ------------------------------------------------------
  const settingsBox = document.createElement("details");
  settingsBox.style.cssText = "border: 1px solid #444; border-radius: 4px; padding: 6px;";
  const settingsSummary = document.createElement("summary");
  settingsSummary.textContent = "Connection";
  settingsSummary.style.cssText = "cursor: pointer; user-select: none; font-weight: 600;";
  settingsBox.appendChild(settingsSummary);

  const settings = loadSettings();
  settingsBox.open = !settings.backendUrl || !settings.token;

  const makeRow = (labelText, type, value, placeholder) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; flex-direction: column; gap: 2px; margin-top: 6px;";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.cssText = "font-size: 11px; opacity: 0.7;";
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.style.cssText = `
      width: 100%; padding: 4px 6px; border: 1px solid #555; border-radius: 3px;
      background: var(--comfy-input-bg, #181818); color: inherit; box-sizing: border-box;
    `;
    row.append(label, input);
    return { row, input };
  };

  const { row: urlRow, input: urlInput } = makeRow(
    "Backend URL",
    "url",
    settings.backendUrl,
    "https://<random>.trycloudflare.com",
  );
  const { row: tokenRow, input: tokenInput } = makeRow(
    "Bearer token",
    "password",
    settings.token,
    "from server stdout: 'session token: ...'",
  );

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.style.cssText =
    "margin-top: 8px; padding: 4px 10px; cursor: pointer; align-self: flex-start;";
  saveBtn.addEventListener("click", () => {
    saveSettings({
      backendUrl: urlInput.value.trim(),
      token: tokenInput.value.trim(),
    });
    appendSystem("Connection saved.");
    settingsBox.open = false;
  });

  settingsBox.append(urlRow, tokenRow, saveBtn);
  root.appendChild(settingsBox);

  // ---- Message log ---------------------------------------------------------
  const log = document.createElement("div");
  log.style.cssText = `
    flex: 1 1 auto; overflow-y: auto; padding: 6px;
    border: 1px solid #444; border-radius: 4px;
    display: flex; flex-direction: column; gap: 6px;
  `;
  root.appendChild(log);

  // ---- Input row -----------------------------------------------------------
  const form = document.createElement("form");
  form.style.cssText = "display: flex; gap: 6px;";
  const input = document.createElement("textarea");
  input.placeholder = "Ask the agent... (Enter to send, Shift+Enter for newline)";
  input.rows = 2;
  input.style.cssText = `
    flex: 1; padding: 6px; border: 1px solid #555; border-radius: 3px;
    background: var(--comfy-input-bg, #181818); color: inherit; resize: vertical;
    font: inherit;
  `;
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";
  sendBtn.style.cssText = "padding: 6px 12px; cursor: pointer;";
  form.append(input, sendBtn);
  root.appendChild(form);

  // ---- DOM helpers ---------------------------------------------------------
  const messages = []; // UIMessage[] for /api/chat history.

  function makeBubble(role) {
    const bubble = document.createElement("div");
    bubble.style.cssText = `
      padding: 6px 8px; border-radius: 4px; max-width: 95%;
      white-space: pre-wrap; word-wrap: break-word;
    `;
    if (role === "user") {
      bubble.style.background = "#2a4d6e";
      bubble.style.alignSelf = "flex-end";
    } else if (role === "system") {
      bubble.style.background = "#3a3a3a";
      bubble.style.fontStyle = "italic";
      bubble.style.opacity = "0.8";
      bubble.style.alignSelf = "center";
      bubble.style.fontSize = "11px";
    } else {
      bubble.style.background = "#333";
      bubble.style.alignSelf = "flex-start";
    }
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function appendUser(text) {
    const bubble = makeBubble("user");
    bubble.textContent = text;
  }

  function appendSystem(text) {
    const bubble = makeBubble("system");
    bubble.textContent = text;
  }

  function appendAssistantStub() {
    const bubble = makeBubble("assistant");
    bubble.dataset.role = "assistant";
    return bubble;
  }

  function appendToolCard({ toolCallId, toolName, input: toolInput, output }) {
    const card = document.createElement("div");
    card.style.cssText = `
      align-self: flex-start; padding: 6px 8px; border-radius: 4px;
      background: #2c2c2c; border-left: 3px solid #6aa84f;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
      max-width: 95%; white-space: pre-wrap; word-wrap: break-word;
    `;
    const head = document.createElement("div");
    head.style.cssText = "font-weight: 600; margin-bottom: 4px;";
    head.textContent = `tool ${toolName ?? "?"} (${toolCallId.slice(0, 8)}…)`;
    card.appendChild(head);
    if (toolInput !== undefined) {
      const inDiv = document.createElement("div");
      inDiv.textContent = `input: ${safeStringify(toolInput)}`;
      card.appendChild(inDiv);
    }
    if (output !== undefined) {
      const outDiv = document.createElement("div");
      outDiv.style.opacity = "0.85";
      outDiv.textContent = `output: ${safeStringify(output)}`;
      card.appendChild(outDiv);
    }
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    return card;
  }

  function safeStringify(v) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  // ---- Send pipeline -------------------------------------------------------
  let inFlight = null; // AbortController for the current request.

  /** Read the live connection settings, preferring the form inputs over storage
   *  so that a user who types into Connection and hits Send (without clicking
   *  Save first) gets the expected behavior — and we silently persist the
   *  values they implicitly approved by sending. */
  function readConnection() {
    const liveUrl = urlInput.value.trim();
    const liveToken = tokenInput.value.trim();
    const stored = loadSettings();
    const backendUrl = liveUrl || stored.backendUrl;
    const token = liveToken || stored.token;
    if (
      backendUrl &&
      token &&
      (backendUrl !== stored.backendUrl || token !== stored.token)
    ) {
      saveSettings({ backendUrl, token });
    }
    return { backendUrl, token };
  }

  /** Normalize a user-pasted backend URL into a `/api/chat` endpoint.
   *  Accepts forms like:
   *    https://abc.trycloudflare.com
   *    https://abc.trycloudflare.com/
   *    https://abc.trycloudflare.com/api
   *    https://abc.trycloudflare.com/api/chat
   *  and returns the canonical `<origin>/api/chat`. */
  function toChatUrl(raw) {
    // Strip whitespace + trailing slashes.
    let s = raw.trim().replace(/\/+$/, "");
    // Strip a trailing `/api/chat` or `/api` segment if the user copied either.
    s = s.replace(/\/api\/chat$/i, "").replace(/\/api$/i, "");
    return s + "/api/chat";
  }

  async function sendMessage(text) {
    const { backendUrl, token } = readConnection();
    if (!backendUrl || !token) {
      appendSystem("Set the backend URL and bearer token in the Connection section first.");
      settingsBox.open = true;
      return;
    }

    const userMsg = {
      id: uid(),
      role: "user",
      parts: [{ type: "text", text }],
    };
    messages.push(userMsg);
    appendUser(text);

    sendBtn.disabled = true;
    input.disabled = true;
    const assistantBubble = appendAssistantStub();
    let assistantText = "";
    // Track open tool calls so we can fill in their output when it arrives,
    // AND so the assistant message we persist to history includes the
    // dynamic-tool parts the model actually emitted (otherwise multi-turn
    // tool conversations lose the tool context — the model can't see what
    // it called or got back on the next turn).
    const toolCards = new Map();
    const toolParts = new Map(); // toolCallId -> dynamic-tool UIMessagePart

    // Single chunk-dispatcher; closes over the per-request mutable state.
    // Declared as a `const` so its binding is unambiguously available before
    // the read loop runs (block-scoped function decls in `try` are spec-fuzzy
    // across engines and strict mode).
    const processChunk = (chunk) => {
      switch (chunk.type) {
        case "text-start":
          // Nothing to render; bubble is already in place.
          break;
        case "text-delta":
          if (typeof chunk.delta === "string") {
            assistantText += chunk.delta;
            assistantBubble.textContent = assistantText;
            log.scrollTop = log.scrollHeight;
          }
          break;
        case "text-end":
          break;
        case "tool-input-available": {
          const id = String(chunk.toolCallId ?? uid());
          const toolName = String(chunk.toolName ?? "");
          const card = appendToolCard({
            toolCallId: id,
            toolName,
            input: chunk.input,
          });
          toolCards.set(id, card);
          // Build the assistant-message part so a follow-up turn can see
          // this call. Mirrors the AI SDK's DynamicToolUIPart shape.
          toolParts.set(id, {
            type: "dynamic-tool",
            toolName,
            toolCallId: id,
            state: "input-available",
            input: chunk.input,
          });
          break;
        }
        case "tool-output-available": {
          // The backend POC `generate_image` tool resolves server-side and
          // the result rides this chunk. We just surface the payload in
          // the corresponding card (or open a new one if we missed the
          // input event for some reason). This is the "one tool-execution
          // path end-to-end" required by the build order.
          const id = String(chunk.toolCallId ?? uid());
          let card = toolCards.get(id);
          if (!card) {
            card = appendToolCard({ toolCallId: id, toolName: "(tool)" });
            toolCards.set(id, card);
          }
          const outDiv = document.createElement("div");
          outDiv.style.opacity = "0.85";
          outDiv.textContent = `output: ${safeStringify(chunk.output)}`;
          card.appendChild(outDiv);
          log.scrollTop = log.scrollHeight;
          // Promote the persisted part to output-available so multi-turn
          // history carries the tool result back to the model.
          const prior = toolParts.get(id) ?? {
            type: "dynamic-tool",
            toolName: "(tool)",
            toolCallId: id,
          };
          toolParts.set(id, {
            ...prior,
            state: "output-available",
            output: chunk.output,
          });
          break;
        }
        case "tool-output-error": {
          const id = String(chunk.toolCallId ?? uid());
          const card = toolCards.get(id);
          const errDiv = document.createElement("div");
          errDiv.style.color = "#f08";
          errDiv.textContent = `error: ${chunk.errorText ?? "tool failed"}`;
          (card ?? appendToolCard({ toolCallId: id, toolName: "(tool)" })).appendChild(
            errDiv,
          );
          const prior = toolParts.get(id) ?? {
            type: "dynamic-tool",
            toolName: "(tool)",
            toolCallId: id,
          };
          toolParts.set(id, {
            ...prior,
            state: "output-error",
            errorText: String(chunk.errorText ?? "tool failed"),
          });
          break;
        }
        case "error":
          assistantBubble.textContent = String(chunk.errorText ?? "stream error");
          assistantBubble.style.background = "#5a2828";
          break;
        case "finish":
          // Loop exits on `[DONE]`.
          break;
        default:
          // Unknown chunk types (data-*, reasoning-*, etc.) are silently
          // ignored for the POC.
          break;
      }
    };

    inFlight = new AbortController();
    try {
      const res = await fetch(toChatUrl(backendUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messages }),
        signal: inFlight.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        assistantBubble.textContent = `Error ${res.status}: ${errText || res.statusText}`;
        assistantBubble.style.background = "#5a2828";
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamDone = false;

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush any pending multi-byte UTF-8 bytes the decoder is buffering
          // (a final TCP read could split a multi-byte char in half; without
          // this flush the trailing bytes are silently dropped).
          buffer += decoder.decode();
          const tail = parseUiMessageStream(buffer);
          buffer = tail.remainder;
          if (tail.done) streamDone = true;
          for (const chunk of tail.chunks) processChunk(chunk);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const result = parseUiMessageStream(buffer);
        buffer = result.remainder;
        if (result.done) streamDone = true;

        for (const chunk of result.chunks) processChunk(chunk);
      }

      // Persist the assistant message so subsequent turns include it. We
      // record any tool parts FIRST (matching the AI SDK's typical part
      // order — tool invocations precede the final text summary) and only
      // emit a message if the model produced any content this turn.
      const parts = [];
      for (const part of toolParts.values()) parts.push(part);
      if (assistantText) parts.push({ type: "text", text: assistantText });
      if (parts.length > 0) {
        messages.push({ id: uid(), role: "assistant", parts });
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        assistantBubble.textContent += "\n[aborted]";
      } else {
        const msg = err && err.message ? err.message : String(err);
        assistantBubble.textContent = `Request failed: ${msg}`;
        assistantBubble.style.background = "#5a2828";
      }
    } finally {
      inFlight = null;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || inFlight) return;
    input.value = "";
    void sendMessage(text);
  });

  input.addEventListener("keydown", (ev) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  return {
    root,
    destroy() {
      try {
        inFlight?.abort();
      } catch {}
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// v1 registration. We reach for `window.app` lazily — at module-eval time
// `app` may not yet be on `window`, but `registerExtension` itself queues.
// ---------------------------------------------------------------------------
const app = window.app ?? globalThis.app;
if (!app || typeof app.registerExtension !== "function") {
  console.error(
    "[comfyui-mcp] window.app.registerExtension is unavailable. " +
      "This extension targets the v1 ComfyUI frontend API.",
  );
} else {
  // TODO(v2): replace with `defineExtension({ name, setup() {...} })`.
  app.registerExtension({
    name: "comfyui-mcp.agent-panel",
    async setup() {
      const tabId = "comfyui-mcp.agent";
      let mounted = null; // { root, destroy }

      const tabSpec = {
        id: tabId,
        title: "Agent",
        // ComfyUI ships PrimeIcons; `pi-comments` is the closest "chat" glyph.
        icon: "pi pi-comments",
        tooltip: "comfyui-mcp Agent",
        type: "custom",
        render: (container) => {
          if (mounted) mounted.destroy();
          mounted = buildPanel();
          container.appendChild(mounted.root);
        },
        destroy: () => {
          mounted?.destroy();
          mounted = null;
        },
      };

      // TODO(v2): replace with `defineSidebarTab({ id, title, type: 'custom',
      // icon, render, destroy })` imported from '@comfyorg/extension-api'.
      const mgr = app.extensionManager;
      if (mgr && typeof mgr.registerSidebarTab === "function") {
        mgr.registerSidebarTab(tabSpec);
      } else {
        console.error(
          "[comfyui-mcp] app.extensionManager.registerSidebarTab is unavailable; " +
            "the agent panel cannot mount. Update ComfyUI to a version that exposes the extension manager.",
        );
      }
    },
  });
}
