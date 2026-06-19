---
name: report-bug
description: Self-heal + report bugs to make the ecosystem better. When you hit a reproducible bug in comfyui-mcp / the sidebar panel, OR in a third-party custom node / ComfyUI core, use this: diagnose it, attempt a local fix so the user can keep working, and report it the right way (our intake Worker for our repos; the node's own GitHub for third-party). Acts autonomously and just informs the user — it does not ask permission for each step. Triggers on tool/panel/orchestrator errors you can't work around, or when the user says "report this" / "fix this bug".
---

# Self-heal & report bugs (make the ecosystem better)

Goal: when something is broken, don't just stop — **diagnose it, try to fix it so
the user keeps working, and get the fix/report to whoever can fix it upstream.**
Do this **autonomously**: act, then **inform** the user with a short summary —
don't pepper them with permission prompts. (Exceptions where you DO pause: a fix
that touches the user's own workflow/data, anything large/risky, or anything you
can't make safe — explain and ask.)

This is for **bugs in software**, not ordinary workflow/generation errors (OOM,
missing model, bad params → use `troubleshooting`). First decide whose bug it is.

## Step 1 — Diagnose (root cause, not symptom)

- Read the exact error + stack. For ComfyUI runs: `get_history`, `get_logs`.
- Follow the stack to the actual file/line. Read the code there.
- Form a concrete root cause + a minimal fix you can defend.

## Step 2 — Classify whose bug it is

- **OURS** — `comfyui-mcp` (server/tools/orchestrator/agent) or
  `comfyui-mcp-panel` (the sidebar pack / panel JS / `__init__.py`). → Steps 3–5 (self-heal + Worker/PR).
- **THIRD-PARTY** — a custom node pack, or **ComfyUI core** itself. → Step 6 (their GitHub; our Worker can't file there).

## Step 3 — Attempt a local fix (so the user keeps working)

Patch the code **where it actually runs** so relief is immediate:

- `comfyui-mcp`: find the running install from the stack path. If a source
  checkout exists, fix the `.ts` source and `npm run build`; if only the built
  package is present, patch the `dist/*.js` directly. Then it takes effect on the
  next orchestrator respawn (`panel_reload`, or Disconnect→Connect).
- `comfyui-mcp-panel`: patch the file under the pack (`web/js/…` for UI,
  `__init__.py` for the pack) — UI changes need a hard-refresh.

Keep the patch **minimal and reversible**. It's fine that a future update will
overwrite it — that's expected; the user runs the patched version in the
meantime. If you genuinely **can't** fix it locally (the bug is upstream-only —
in the SDK, ComfyUI, or needs a release), say so and skip to reporting, marked
upstream-only.

## Step 4 — Verify the fix

- `comfyui-mcp`: run the safety gate — `npm run build` (exit 0), `npm test`,
  `npm run test:agent`. Don't claim a fix that fails the gate.
- Otherwise: re-run the operation that failed and confirm it now works.

## Step 5 — Report it to US (autonomous)

**Always scrub secrets first** (you're sending this off-machine without a human
reading it — this is non-negotiable): replace any `sk-…`, `ghp_…`,
`github_pat_…`, `Bearer …`, `ANTHROPIC_API_KEY`, `CIVITAI_API_TOKEN`, `HF_TOKEN`,
`.env`/`.dev.vars` contents, `Authorization:` headers, `?token=`/`?key=` query
params with `[REDACTED]`; shorten home paths to `~/…`.

Build the body (reuse this shape) — and when you fixed it, **include the diff**
so we can reproduce and merge:

```
### What happened / root cause
### Steps to reproduce
### Exact error (scrubbed)
### Fix
<applied locally: yes/no>  <upstream-only: yes/no>
<the diff / patch, or the precise change needed if upstream-only>
### Environment
OS / ComfyUI version / GPU+VRAM / comfyui-mcp branch or version
```

Then file it (no need to ask):

- **Engineer path (preferred when `gh` is authed and the fix is clean):** run
  `gh auth status`; if authed, branch/`gh repo fork`, apply the fix, run the gate
  (Step 4), push, `gh pr create --fill`. **Never merge** — it's for our review.
- **Default path (everyone):** POST the report to our intake Worker — no GitHub
  account needed:

  ```bash
  # URL is baked in; override with $COMFYUI_MCP_ISSUE_WORKER_URL if set. The
  # client key is a soft anti-spam gate — read it from $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  WORKER_URL="${COMFYUI_MCP_ISSUE_WORKER_URL:-https://comfyui-mcp-issue-worker.artokun.workers.dev}"
  # Soft anti-spam gate (ships with the panel; not a real secret — the GitHub
  # token is server-side in the Worker). Override with $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  CLIENT_KEY="${COMFYUI_MCP_ISSUE_CLIENT_KEY:-9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2}"
  curl -fsS -X POST "$WORKER_URL" \
    -H "Content-Type: application/json" -H "X-Client-Key: $CLIENT_KEY" \
    --data @"$BODY_JSON_FILE"
  # body: { "repo": "comfyui-mcp" | "comfyui-mcp-panel", "title", "body", "labels": ["via-panel"] }
  ```
  Write the JSON to a temp file (the body has newlines/quotes). On success it
  returns `{ ok, url, number, deduped? }`. A `401 unauthorized` means
  `$COMFYUI_MCP_ISSUE_CLIENT_KEY` is unset/wrong — fall back to `report_issue`.
- **Fallback** (no `gh`, no Worker URL): use the `report_issue` tool → a prefilled
  GitHub issue link the user can submit in one click.

## Step 6 — Third-party / ComfyUI-core bugs

Our Worker only files into OUR repos, so these go to **their** GitHub:

- Still attempt a **local workaround** if you safely can (e.g. patch the custom
  node so the user isn't blocked) — same keep-the-patch logic.
- To report: identify the node/project's GitHub repo (from its metadata /
  `list_installed_nodes` / its folder), then use `report_issue` with that
  `owner/repo` to produce a prefilled issue link, OR `gh issue create -R owner/repo`
  if `gh` is authed.
- If the user has **no GitHub account**, briefly offer to walk them through
  creating one (github.com/signup) so they can file it — that's how the bug
  reaches the people who can fix it. We can't file it for them.

## Step 7 — Inform the user (the only message they need)

A short, concrete summary — not a request. e.g.:

> Hit a bug in `panel_set_widget` (it errored on subgraph inner nodes). I
> patched it locally so it works now, and filed a bugfix report on your behalf
> (#123). You're running the patched version; a future update will replace the
> patch once we ship the fix upstream.

If upstream-only: say it's logged with us (or the third-party project) and what
the temporary workaround is, if any.

## Absolute rules

- **Scrub secrets** before anything leaves the machine — every time.
- **Never merge** a PR; humans review.
- Patches stay **minimal and reversible**; never touch the user's workflow data
  without asking.
- Don't claim a fix you didn't verify (Step 4).
