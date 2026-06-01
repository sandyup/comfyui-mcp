// ---------------------------------------------------------------------------
// AI SDK UI Message Stream Protocol — consumer-side parser.
//
// `POST /api/chat` returns a Server-Sent Events stream whose every `data:`
// frame is a JSON-encoded `UIMessageChunk` (the AI SDK v6 UI message stream
// protocol — see `node_modules/ai/dist/index.d.ts` for the full union). The
// terminator frame is the literal `data: [DONE]`.
//
// This module provides a single pure function that turns an arbitrary slice of
// the raw text body (i.e. however much arrived in the latest `reader.read()`)
// into:
//   - a list of decoded chunk objects, and
//   - a `remainder` string (an unterminated partial event) the caller must
//     prepend to the NEXT slice before re-invoking.
//
// Keeping the parser pure (no state, no DOM, no fetch) makes it cheap to test
// against canned byte streams in vitest. The exact same logic is *also*
// inlined into the browser-side panel (web/extensions/...) because that file
// is dropped directly into ComfyUI's `web/extensions/` directory with no
// bundler; the two implementations are kept byte-equivalent.
// ---------------------------------------------------------------------------

export interface UiMessageStreamChunk {
  type: string;
  // The full union lives in `ai`'s type defs; we keep this open so callers
  // can introspect any field without dragging the optional `ai` dep into the
  // parser module.
  [k: string]: unknown;
}

export interface ParseResult {
  chunks: UiMessageStreamChunk[];
  /** Unterminated trailing fragment; pass to the next call. */
  remainder: string;
  /** Whether the `[DONE]` sentinel was seen. */
  done: boolean;
}

/**
 * Parse a slice of an AI SDK UI message stream. Stateless — the caller owns
 * the remainder buffer.
 *
 * Frame grammar: events are separated by `\n\n`; each event is one or more
 * `data: <payload>` lines. The terminator is the literal `[DONE]`. We
 * tolerate `\r\n\n` and stray blank lines.
 */
export function parseUiMessageStream(buffer: string): ParseResult {
  const chunks: UiMessageStreamChunk[] = [];
  let done = false;

  // Normalize line endings so the split below works regardless of transport.
  const normalized = buffer.replace(/\r\n/g, "\n");

  // Split on the blank-line frame boundary. The trailing element is whatever
  // is *after* the last `\n\n` — i.e. an unterminated frame in progress.
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const frame of parts) {
    // A frame can contain multiple `data:` lines (SSE spec joins them with
    // `\n`). In practice AI SDK emits a single line per frame, but we honor
    // the spec to keep the parser interoperable.
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      // Strip `data:` then a single optional leading space (per SSE spec).
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
      const parsed = JSON.parse(payload) as UiMessageStreamChunk;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        chunks.push(parsed);
      }
    } catch {
      // Malformed frame — skip silently. The AI SDK never emits invalid
      // JSON; this is just defensive for non-conforming proxies.
    }
  }

  return { chunks, remainder, done };
}
