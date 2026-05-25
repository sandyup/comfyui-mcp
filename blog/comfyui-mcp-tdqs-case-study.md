# From B to A: sharpening 70+ tool descriptions with TDQS

*by [artokun](https://github.com/artokun) · May 25, 2026 · MCP, TDQS, case study*

[comfyui-mcp](https://github.com/artokun/comfyui-mcp) is an MCP server that lets an AI agent
drive [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — generate images, run and author
workflows, manage models and custom nodes. It exposes 70+ tools. When it landed on Glama, the
dashboard gave it a **Tool Definition Quality Score of B**. Here's what fixing that taught us —
and a few rules any MCP author can steal.

## The number that actually matters

[TDQS](https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs) blends **Tool
Definition Quality (70%)** and **Server Coherence (30%)**. Each tool is scored 1–5 across six
dimensions, but the part that bit us is how the per-tool scores roll up into the server score:

> server definition quality = 60% × **mean** TDQS + 40% × **minimum** TDQS

That 40%-on-the-minimum is the whole game. Our *average* tool was already ~4.1 — solidly A. Most
tools scored 4.3–4.7. But the grade was a B, because our single weakest tool, `cancel_job`,
scored **3.1** and dragged everything down with it.

**One vague tool caps your whole server.** So the highest-leverage work isn't polishing your best
tools — it's finding and fixing your worst one.

## The pattern hiding in the dimensions

Expanding the low scorers, the same two dimensions were weak almost everywhere — even on
otherwise-strong tools:

- **Usage Guidelines** (2/5 at worst): the description never said *when* to use this tool versus
  a sibling that does something similar.
- **Behavior** (2/5): it didn't disclose side effects, preconditions, or whether the tool is even
  read-only.

A third, **Parameters**, was quietly capped: our zod schemas already described every parameter,
so when the prose merely *restated* the schema, the dimension maxed out at 3. Descriptions have to
add something the schema can't.

## What we changed

We rewrote descriptions against three rules:

**1. Disambiguate against siblings.** If you ship three ways to cancel things, say which is which.

**2. Disclose behavior up front.** Read-only? Mutates disk? Requires a running server?
Asynchronous (returns an id you poll later)? Local-only vs. works-against-remote? Destructive and
irreversible?

**3. Add meaning beyond the schema.** Units, valid ranges, what omitting an optional param does,
and what comes back.

Here's `cancel_job`, our 3.1, before and after:

> **Before:** "Cancel or interrupt a running ComfyUI job. Optionally target by prompt_id."

> **After:** "Interrupt the **currently running** ComfyUI job, optionally only when its prompt_id
> matches. Stops in-progress execution — the partial result is discarded and not recoverable — and
> does **not** remove pending/queued jobs. Requires a reachable ComfyUI server. Use this for the
> job executing right now; use `cancel_queued_job` to remove one specific pending job, or
> `clear_queue` to drop all pending jobs."

Same tool, same parameters. The second version tells an agent when to reach for it, what it does
to the world, and what *not* to use it for.

## A gotcha: score what the checker actually sees

One of the lowest-scoring definitions in our own audit was the template behind *auto-loaded
workflow* tools — tools the server generates from `*.json` files a user drops in a directory. We
almost spent time polishing it. But TDQS scores the tools the **running server actually exposes**,
and Glama boots the server in a clean environment with no workflow files — so those tools never
register and never get scored.

Lesson: audit against the tool list your server emits on a *fresh* boot, not the theoretical
maximum.

## Keeping it from rotting

Descriptions drift. To keep ours honest, the tool reference is **generated from the live schemas**
— a script boots the server with a capturing mock, reads each tool's name, description, and zod
schema, and emits the docs. One source of truth for both the agent and humans, so a sloppy edit
shows up immediately. (Our [docs](https://comfyui-mcp.artokun.io/docs) are built this way.)

## The result

Raising the floor — `cancel_job`, `list_local_models`, `search_models`, and the rest of the
sub-3.5 cluster — plus the cross-cutting Usage/Behavior pass took the minimum from **3.1 to ~4.0**.
With the 60/40 split, that pulls the server out of B and into A on the next re-index.

## Takeaways for MCP authors

1. **Fix your worst tool first** — the 40%-minimum weighting means it sets your grade.
2. **Every description should answer three questions:** what does this do to the world, when do I
   use it instead of a sibling, and what do the parameters mean beyond their types?
3. **Don't just echo the schema** — it already covers structure; prose should add intent.
4. **Audit the fresh-boot tool list**, not your theoretical one.
5. **Generate the reference from the schema** so quality can't silently regress.

---

comfyui-mcp is open source: [github.com/artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp)
· docs at [comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs).
