#!/usr/bin/env python3
"""QLoRA fine-tune of huihui-ai's abliterated Gemma 4 into a ComfyUI-MCP expert.

Run on the training pod (see finetune/README.md for the RunPod recipe):
  python train_qlora.py [--config config.yaml] [--dry-run]

Design notes:
- The base is the ABLITERATED checkpoint loaded directly from HF — abliteration
  is baked into the weights (refusal direction orthogonalized out), so QLoRA on
  top preserves it. We do NOT re-apply any abliteration step here.
- Domain records reference the shared comfyui tool list; it is injected via
  apply_chat_template(tools=...) so the model trains against the EXACT schemas
  it will see at inference. Never hand-roll the template — Gemma 4's tool-call
  tokens (<|tool_call>...<tool_call|>) come from the tokenizer.
- Loss is masked to assistant turns via Unsloth's train_on_responses_only with
  the turn markers from config.yaml (verify them on-pod with --dry-run first).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "config.yaml"))
    ap.add_argument("--size", default=None, help="size-ladder key (e2b/e4b/12b/31b); default: config 'size'")
    ap.add_argument("--dry-run", action="store_true", help="render 2 samples and exit (verify template + masking)")
    ap.add_argument("--max-steps", type=int, default=0, help="cap training steps (canary run); 0 = full num_train_epochs")
    args = ap.parse_args()
    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))

    # Resolve the size-ladder rung: the same dataset trains onto every Gemma 4
    # size (e2b→31b) so users pick by VRAM budget. --size overrides config 'size'.
    size = args.size or cfg.get("size")
    rung = (cfg.get("size_ladder") or {}).get(size) if size else None
    if rung:
        cfg["base_model"] = rung["base_model"]
        cfg["max_seq_length"] = rung.get("max_seq_length", cfg["max_seq_length"])
        cfg["output_dir"] = f"outputs/gemma4-{size}-comfyui-mcp"
        print(f"[train] size={size} base={cfg['base_model']} seq_len={cfg['max_seq_length']}")

    from unsloth import FastLanguageModel  # import first: patches transformers

    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=cfg["base_model"],
        max_seq_length=cfg["max_seq_length"],
        load_in_4bit=cfg["load_in_4bit"],
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=cfg["lora"]["r"],
        lora_alpha=cfg["lora"]["alpha"],
        lora_dropout=cfg["lora"]["dropout"],
        target_modules=cfg["lora"]["target_modules"],
        use_gradient_checkpointing="unsloth",
        random_state=cfg["training"]["seed"],
    )

    import random as _random

    # Tool pool the per-example menu is drawn from (combined comfyui+panel
    # surface). Trimmed-context training: each example is rendered with the tools
    # it actually calls plus random distractors (capped), NOT all 113 — the full
    # list per example blows seq len to 48K (~900s/step). The model still sees the
    # full surface at inference; training on variable menus generalizes better.
    pool_path = HERE / cfg["data"].get("tools_pool_file", cfg["data"]["tools_file"])
    pool = json.loads(pool_path.read_text(encoding="utf-8"))["tools"]
    tool_by_name = {
        t["name"]: {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}}
        for t in pool
    }
    all_tool_names = list(tool_by_name)
    max_tools = int(cfg["data"].get("max_tools_per_example", 24))
    menu_rng = _random.Random(cfg["training"]["seed"])

    def tool_menu(messages: list[dict]) -> list[dict]:
        used = []
        seen = set()
        for m in messages:
            for tc in m.get("tool_calls") or []:
                n = (tc.get("function") or {}).get("name")
                if n in tool_by_name and n not in seen:
                    seen.add(n)
                    used.append(n)
        distractors = [n for n in all_tool_names if n not in seen]
        menu_rng.shuffle(distractors)
        chosen = used + distractors[: max(0, max_tools - len(used))]
        menu_rng.shuffle(chosen)  # vary tool ORDER so the model can't memorize position
        return [tool_by_name[n] for n in chosen]

    def normalize_messages(messages: list[dict]) -> list[dict]:
        """Coerce OpenAI-shaped messages into what the Gemma 4 Jinja template
        expects:
        - content is always a string (assistant-with-tool_calls has content=None
          in OpenAI form, but the template concatenates it → TypeError);
        - tool-call arguments are a dict (we store them as a JSON string);
        - every tool-RESULT message carries an explicit `name` (the function it
          answers). The template otherwise resolves the name by matching
          tool_call_id back to the assistant's tool-call id, and Jinja's
          `default('unknown')` does NOT replace a Python None from a failed
          match, so `tool_name` stays None and crashes. Setting `name` directly
          sidesteps that fragile lookback."""
        out = []
        id_to_name: dict[str, str] = {}
        for m in messages:
            m = dict(m)
            if m.get("content") is None:
                m["content"] = ""
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        fn["arguments"] = json.loads(args) if args.strip() else {}
                    except json.JSONDecodeError:
                        fn["arguments"] = {}
                if tc.get("id") and fn.get("name"):
                    id_to_name[tc["id"]] = fn["name"]
            if m.get("role") == "tool" and not m.get("name"):
                m["name"] = id_to_name.get(m.get("tool_call_id"), "unknown")
            out.append(m)
        return out

    def to_text(rec: dict) -> str:
        # comfyui/panel domain records → a trimmed per-example tool menu; external
        # (Toucan/xLAM) records carry their own inline tool list.
        tools = tool_menu(rec["messages"]) if rec["tools"] == "comfyui" else rec.get("inline_tools") or None
        return tokenizer.apply_chat_template(normalize_messages(rec["messages"]), tools=tools, tokenize=False)

    # Load JSONL with plain Python and render to text BEFORE building the
    # Dataset — the HF json loader (pyarrow) chokes on our nested/variable
    # messages schema ("Trailing data"), and once rendered every row is just
    # {"text": str}, a trivial schema pyarrow handles cleanly.
    def read_jsonl(path: Path) -> list[dict]:
        return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]

    from datasets import Dataset, DatasetDict

    ds = DatasetDict(
        {
            split: Dataset.from_list(
                [{"text": to_text(r)} for r in read_jsonl((HERE / cfg["data"][key]).resolve())]
            )
            for split, key in (("train", "train_file"), ("val", "val_file"))
        }
    )

    if args.dry_run:
        for i in range(2):
            sample = ds["train"][i]["text"]
            print(f"\n===== SAMPLE {i} ({len(sample)} chars) =====")
            print(sample[:2000])
            print("..." if len(sample) > 2000 else "")
            for marker in (cfg["template"]["instruction_part"], cfg["template"]["response_part"]):
                print(f"marker {marker!r}: {'FOUND' if marker in sample else 'MISSING — fix config.yaml template markers'}")
        return

    tr = cfg["training"]
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds["train"],
        eval_dataset=ds["val"],
        args=SFTConfig(
            output_dir=cfg["output_dir"],
            dataset_text_field="text",
            max_seq_length=cfg["max_seq_length"],
            # --max-steps caps a canary run; otherwise train full epochs.
            **({"max_steps": args.max_steps} if args.max_steps else {"num_train_epochs": tr["num_train_epochs"]}),
            per_device_train_batch_size=tr["per_device_train_batch_size"],
            gradient_accumulation_steps=tr["gradient_accumulation_steps"],
            learning_rate=tr["learning_rate"],
            lr_scheduler_type=tr["lr_scheduler_type"],
            warmup_ratio=tr["warmup_ratio"],
            weight_decay=tr["weight_decay"],
            optim=tr["optim"],
            logging_steps=tr["logging_steps"],
            save_steps=tr["save_steps"],
            seed=tr["seed"],
            report_to="none",
        ),
    )
    trainer = train_on_responses_only(
        trainer,
        instruction_part=cfg["template"]["instruction_part"],
        response_part=cfg["template"]["response_part"],
    )
    trainer.train()

    out = Path(cfg["output_dir"])
    model.save_pretrained_merged(str(out / "merged-16bit"), tokenizer, save_method="merged_16bit")
    for quant in cfg["export"]["gguf_quants"]:
        model.save_pretrained_gguf(str(out / f"gguf-{quant}"), tokenizer, quantization_method=quant)
    if cfg["export"]["hf_repo"]:
        model.push_to_hub_merged(cfg["export"]["hf_repo"], tokenizer, save_method="merged_16bit")
    print(f"[train] done → {out}")


if __name__ == "__main__":
    main()
