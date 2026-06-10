#!/usr/bin/env python3
"""Merge a Temporal IR Unsloth/PEFT LoRA adapter into a full model artifact.

Run from WSL/Linux after installing requirements-unsloth.txt. The merged output
is intended for hosted inference backends that can load a normal Hugging Face
causal-LM repo but do not expose enough environment variables for adapter-only
serving.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_ADAPTER = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-expanded-bounded-minimal-lora"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-expanded-bounded-minimal-merged"


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge a Temporal IR LoRA adapter for hosted inference.")
    parser.add_argument("--adapter", type=Path, default=DEFAULT_ADAPTER)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument(
        "--save-method",
        default="merged_16bit",
        choices=["merged_16bit", "merged_4bit", "lora"],
        help="Unsloth save_pretrained_merged method.",
    )
    parser.add_argument("--hub-repo", default="", help="Optional Hugging Face repo ID to upload to.")
    parser.add_argument("--private", action="store_true", help="Create/upload the optional Hugging Face repo as private.")
    args = parser.parse_args()

    if not args.adapter.exists():
        raise FileNotFoundError(f"Adapter directory not found: {args.adapter}")

    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(args.adapter),
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=True,
    )

    args.output.mkdir(parents=True, exist_ok=True)
    model.save_pretrained_merged(str(args.output), tokenizer, save_method=args.save_method)
    write_merge_summary(args)
    print(f"Saved merged Temporal IR model to {args.output}")

    if args.hub_repo:
        model.push_to_hub_merged(args.hub_repo, tokenizer, save_method=args.save_method, private=args.private)
        print(f"Uploaded merged Temporal IR model to https://huggingface.co/{args.hub_repo}")


def write_merge_summary(args: argparse.Namespace) -> None:
    source_summary = args.adapter / "temporal_ir_run_summary.json"
    merged_summary = {
        "adapter": str(args.adapter),
        "saveMethod": args.save_method,
        "maxSeqLength": args.max_seq_length,
        "hubRepo": args.hub_repo or None,
        "private": bool(args.private) if args.hub_repo else None,
    }
    if source_summary.exists():
        merged_summary["sourceRun"] = json.loads(source_summary.read_text(encoding="utf-8"))
    (args.output / "temporal_ir_merge_summary.json").write_text(
        json.dumps(merged_summary, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
