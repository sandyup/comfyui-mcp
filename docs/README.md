# ComfyUI MCP — documentation

[Mintlify](https://mintlify.com) docs for `comfyui-mcp`. Config lives in `docs.json`.

## Local preview

```bash
cd docs
npx mint dev        # http://localhost:3000
```

## The Tool Reference is generated

The pages under `tools/` and the **Tool Reference** navigation tab are generated from the
**live MCP tool schemas** — do not edit them by hand. After changing tools, run from the repo
root:

```bash
npm run docs:gen
```

then commit the result. The generator (`scripts/gen-tool-docs.ts`) boots the MCP server with a
capturing mock, reads each tool's name/description/zod schema, and emits one MDX page per
category plus the matching `navigation` tab in `docs.json`.

## Images / examples

Screenshots use a `[Screenshot coming soon]` placeholder (`images/placeholder.svg`). Drop real
images under `images/` and update the `<Frame>` `src` (and fill in the example skeletons) as
they become available.

## Deploy

Hosted by Mintlify via its GitHub app — it auto-deploys on push to the default branch (and
creates preview deployments for PRs).
