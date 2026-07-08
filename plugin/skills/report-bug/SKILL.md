---
name: report-bug
description: Report or self-heal a bug in comfyui-mcp / the panel. When you hit a reproducible bug in the MCP server or sidebar panel itself (not a user workflow error) that you can't work around, use this to file it the right way — auto-pick between opening a PR (if the user has an authed `gh`) and filing a GitHub issue via the panel's intake Worker, with secrets scrubbed. Also use when the user says "report this bug" / "file an issue" / "open a PR for that".
---

# Reporting & self-healing comfyui-mcp / panel bugs

Use this when the bug is in **comfyui-mcp itself or the sidebar panel** (a tool
errors, a panel command misbehaves, the orchestrator does something wrong) — NOT
for ordinary ComfyUI/workflow errors (those go through `troubleshooting` +
`get_history`/`get_logs`). Pick the repo:

- `comfyui-mcp` — the MCP server, tools, orchestrator, agent behavior.
- `comfyui-mcp-panel` — the ComfyUI sidebar pack (the panel UI / `__init__.py`).

## 0. Always: assemble a clean report

Gather, in this shape (reuse it verbatim as the issue/PR body):

```
### What happened
<one or two sentences>

### Steps to reproduce
1. …
2. …

### Exact error
<paste the precise error text / stack — trimmed to the relevant lines>

### Environment
- OS: <e.g. Windows 11>
- ComfyUI: <version if known>   GPU/VRAM: <if relevant>
- comfyui-mcp / panel: <branch or version if known>
```

**SCRUB SECRETS before sending anything** (we have leaked a token before — take
this seriously). Remove/replace with `[REDACTED]`:

- API keys / tokens: `sk-…`, `ghp_…`, `github_pat_…`, `Bearer …`,
  `ANTHROPIC_API_KEY`, `CIVITAI_API_TOKEN`, `HF_TOKEN`, anything that looks like
  a credential.
- `.env` / `.dev.vars` contents, `Authorization:` headers, query-string `?token=`/`?key=`.
- Full home paths if they contain a real username — shorten to `~/…` where it
  doesn't hurt the repro.

If you're unsure whether a string is a secret, redact it.

## 1. Confirm with the user (opt-in)

This sends data off the machine (or opens a PR). Show the user the **title** and
the **scrubbed body**, say which path you'll take (issue vs PR) and where it
goes, and only proceed once they say yes. Never auto-file silently.

## 2. Choose the path

### Engineer path — open a PR (preferred when the fix is clear AND `gh` is authed)

Only when you can make a concrete code fix AND `gh` is available:

1. Probe: run `gh auth status`. If it fails / not installed → skip to the issue path.
2. If the user is working in a local checkout of the repo (e.g. the dev's
   `comfyui-mcp` clone), branch there; otherwise `gh repo fork <owner>/<repo> --clone`.
3. Create a branch, apply the **minimal** fix.
4. **Run the safety gate — do not open a PR if it fails:**
   - `npm run build`  (must exit 0)
   - `npm test`  and  `npm run test:agent`  (must pass)
5. Commit (end the message with the project's Co-Authored-By line if present),
   push to the branch/fork, then `gh pr create --fill` (or with a clear title/body).
6. **Never merge.** Hand the PR URL to the user for review.

If any gate fails or the fix isn't safe/clear, fall back to filing an issue.

### Everyone path — file an issue via the intake Worker (default)

No GitHub account or auth needed. Requires the Worker to be configured — read
its URL and client key from the environment:

```bash
# Both are inherited from the user's environment; if unset, use the fallback below.
echo "$COMFYUI_MCP_ISSUE_WORKER_URL"
echo "$COMFYUI_MCP_ISSUE_CLIENT_KEY"
```

If `COMFYUI_MCP_ISSUE_WORKER_URL` is set, POST the (scrubbed) report:

```bash
curl -fsS -X POST "$COMFYUI_MCP_ISSUE_WORKER_URL" \
  -H "Content-Type: application/json" \
  -H "X-Client-Key: $COMFYUI_MCP_ISSUE_CLIENT_KEY" \
  --data @- <<'JSON'
{
  "repo": "comfyui-mcp",
  "title": "<short, specific title>",
  "body": "<the scrubbed report body>",
  "labels": ["via-panel"]
}
JSON
```

(Build the JSON safely — pass `repo`/`title`/`body` as real JSON strings; if the
body has quotes/newlines, write it to a temp file and `--data @file` instead of
inlining.) On success the Worker returns `{ ok, url, number, deduped? }` — share
the `url` with the user. `deduped: true` means it matched an existing open issue
(that's fine — point them at it).

### Fallback — prefilled link (no `gh`, no Worker configured)

If `gh` isn't authed AND `COMFYUI_MCP_ISSUE_WORKER_URL` is empty, use the
`report_issue` MCP tool: it returns a prefilled GitHub "new issue" URL (no auth,
no network) that the user can review and submit in one click. Pass the same
scrubbed title/body and `repo: "artokun/comfyui-mcp"` (or `artokun/comfyui-mcp-panel`).

## 3. Report back

Tell the user exactly what you did and give them the link: the **PR URL**, the
**filed-issue URL**, or the **prefilled link to submit**. Keep a human in the
loop — never merge a PR or claim something was fixed upstream that wasn't.
