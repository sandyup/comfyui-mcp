#!/usr/bin/env python3
"""Build the final train/val JSONL mix for gemma4-abliterated-comfyui-mcp.

Inputs (produced by the Node datagen pipeline — see finetune/README.md):
  finetune/data/seed-trajectories.jsonl      arena compact->full rewrites
  arena-results-full/trajectories.jsonl      teacher runs over synthesized tasks
Optional general tool-calling mixes (anti-forgetting, from HuggingFace):
  --toucan N   sample N trajectories from Agent-Ark/Toucan-1.5M
  --xlam N     sample N from Salesforce/xlam-function-calling-60k

Every record is normalized to {"messages": [...], "tools": "comfyui" | "inline"}.
Domain records reference the shared comfyui tool list (rendered at train time
from tools-full.json); external records carry their own tool definitions.

Usage (on the training pod):
  python prepare_dataset.py --val-frac 0.03 [--toucan 8000 --xlam 4000] [--print-sample]
"""
from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
REPO = HERE.parent.parent

# Providers whose outputs may not train other models. The Node pipeline
# already filters; this is defense-in-depth before anything reaches the GPU.
BLOCKED_TEACHER_PREFIXES = ("anthropic/", "openai/", "google/", "x-ai/", "claude", "gpt-", "gemini")


def load_domain(paths: list[Path]) -> list[dict]:
    out = []
    for path in paths:
        if not path.exists():
            print(f"  [skip] {path} (missing)")
            continue
        n_blocked = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            teacher = (rec.get("teacher") or "").lower()
            if any(teacher.startswith(p) for p in BLOCKED_TEACHER_PREFIXES):
                n_blocked += 1
                continue
            out.append({"messages": rec["messages"], "tools": "comfyui", "id": rec.get("id", "")})
        print(f"  [load] {path.name}: {len(out)} total so far" + (f" ({n_blocked} ToS-blocked DROPPED)" if n_blocked else ""))
    return out


def load_toucan(n: int, rng: random.Random) -> list[dict]:
    from datasets import load_dataset  # lazy: heavy import

    # Toucan-1.5M is split into configs by the teacher that generated each
    # trajectory: ['Kimi-K2', 'OSS', 'Qwen3', 'SFT']. 'SFT' is the ready
    # supervised-fine-tuning-formatted mixture — the one we blend in.
    config = os.environ.get("TOUCAN_CONFIG", "SFT")
    ds = load_dataset("Agent-Ark/Toucan-1.5M", config, split="train", streaming=True)
    picked = []
    # Reservoir-free cheap sample: take every record with prob ~n/1.5M until n.
    for rec in ds.shuffle(seed=rng.randint(0, 2**31), buffer_size=10_000):
        msgs = rec.get("messages") or rec.get("conversations")
        if not msgs:
            continue
        picked.append({"messages": msgs, "tools": "inline", "id": f"toucan-{len(picked)}"})
        if len(picked) >= n:
            break
    return picked


def load_xlam(n: int, rng: random.Random) -> list[dict]:
    from datasets import load_dataset

    ds = load_dataset("Salesforce/xlam-function-calling-60k", split="train")
    idx = rng.sample(range(len(ds)), min(n, len(ds)))
    picked = []
    for i in idx:
        rec = ds[i]
        # xlam rows are {query, tools(json str), answers(json str of calls)}.
        try:
            tools = json.loads(rec["tools"])
            answers = json.loads(rec["answers"])
        except (KeyError, json.JSONDecodeError):
            continue
        calls = [
            {
                "id": f"call_{j}",
                "type": "function",
                "function": {"name": a["name"], "arguments": json.dumps(a.get("arguments", {}))},
            }
            for j, a in enumerate(answers)
        ]
        picked.append(
            {
                "messages": [
                    {"role": "user", "content": rec["query"]},
                    {"role": "assistant", "tool_calls": calls},
                ],
                "inline_tools": tools,
                "tools": "inline",
                "id": f"xlam-{i}",
            }
        )
    return picked


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--toucan", type=int, default=0)
    ap.add_argument("--xlam", type=int, default=0)
    ap.add_argument("--val-frac", type=float, default=0.03)
    ap.add_argument("--seed", type=int, default=3407)
    ap.add_argument("--print-sample", action="store_true")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    # Gather EVERY harvested trajectory source: the seed rewrites plus every
    # arena-results*/trajectories.jsonl (full/pod/panel/local-batch/bake-offs).
    # New harvest dirs are picked up automatically — no need to edit this list.
    print("[prepare] loading domain trajectories")
    sources = [DATA / "seed-trajectories.jsonl"]
    sources += sorted(REPO.glob("arena-results*/trajectories.jsonl"))
    records = load_domain(sources)
    n_domain = len(records)
    if args.toucan:
        print(f"[prepare] sampling {args.toucan} Toucan trajectories")
        records += load_toucan(args.toucan, rng)
    if args.xlam:
        print(f"[prepare] sampling {args.xlam} xLAM records")
        records += load_xlam(args.xlam, rng)

    # Dedupe on the user-turn text + assistant call sequence.
    seen: set[str] = set()
    unique = []
    for rec in records:
        key_parts = []
        for m in rec["messages"]:
            if m.get("role") == "user":
                key_parts.append((m.get("content") or "")[:200])
            for tc in m.get("tool_calls") or []:
                key_parts.append(tc["function"]["name"])
        key = "|".join(key_parts)
        if key in seen:
            continue
        seen.add(key)
        unique.append(rec)

    rng.shuffle(unique)
    n_val = max(1, int(len(unique) * args.val_frac))
    val, train = unique[:n_val], unique[n_val:]

    for name, split in (("train.jsonl", train), ("val.jsonl", val)):
        path = DATA / name
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in split) + "\n", encoding="utf-8")
        print(f"[prepare] {path}: {len(split)} records")
    print(f"[prepare] domain={n_domain} total_unique={len(unique)} (dupes dropped: {len(records) - len(unique)})")

    if args.print_sample:
        print(json.dumps(train[0], indent=2)[:4000])


if __name__ == "__main__":
    main()
