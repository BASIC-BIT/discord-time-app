#!/usr/bin/env python3
"""Run a trained Temporal Plan-IR LoRA adapter on JSONL inputs."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

from temporal_ir_prompts import PROMPT_FORMATS, PROMPT_PRESETS, format_inference_prompt


DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-lora"
DEFAULT_INPUT = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-eval-input.jsonl"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-eval-predictions.jsonl"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Temporal Plan-IR predictions from a trained adapter.")
    parser.add_argument("--model", type=Path, default=Path(os.environ.get("TEMPORAL_IR_MODEL_DIR", DEFAULT_MODEL_DIR)))
    parser.add_argument("--input", type=Path, default=Path(os.environ.get("TEMPORAL_IR_PREDICT_INPUT", DEFAULT_INPUT)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("TEMPORAL_IR_PREDICT_OUTPUT", DEFAULT_OUTPUT)))
    parser.add_argument("--max-seq-length", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_SEQ_LENGTH", "4096")))
    parser.add_argument("--max-new-tokens", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_NEW_TOKENS", "512")))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("TEMPORAL_IR_PREDICT_LIMIT", "0")))
    parser.add_argument(
        "--prompt-format",
        choices=sorted(PROMPT_FORMATS),
        default=os.environ.get("TEMPORAL_IR_PROMPT_FORMAT", "custom"),
        help="Prompt format used for inference prompts.",
    )
    parser.add_argument(
        "--enable-thinking",
        action="store_true",
        default=os.environ.get("TEMPORAL_IR_ENABLE_THINKING", "").lower() in {"1", "true", "yes", "on"},
        help="When using chat prompt format, let the Qwen chat template start a thinking block.",
    )
    parser.add_argument(
        "--no-load-in-4bit",
        action="store_true",
        default=os.environ.get("TEMPORAL_IR_NO_LOAD_IN_4BIT", "").lower() in {"1", "true", "yes", "on"},
        help="Load the model in bf16/fp16 instead of the default 4-bit path.",
    )
    parser.add_argument(
        "--instruction-preset",
        choices=sorted(PROMPT_PRESETS),
        default=os.environ.get("TEMPORAL_IR_INSTRUCTION_PRESET", "detailed"),
        help="Instruction preset used for inference prompts.",
    )
    args = parser.parse_args()

    from unsloth import FastLanguageModel
    import torch

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(args.model),
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=not args.no_load_in_4bit,
    )
    FastLanguageModel.for_inference(model)

    rows = load_rows(args.input)
    if args.limit > 0:
        rows = rows[: args.limit]

    output_rows = []
    for row in rows:
        prompt = format_inference_prompt(row, args.instruction_preset, args.prompt_format, tokenizer, args.enable_thinking)
        inputs = tokenizer(text=[prompt], return_tensors="pt").to("cuda")
        started = time.perf_counter()
        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                use_cache=True,
                do_sample=False,
                temperature=None,
                top_p=None,
                eos_token_id=tokenizer.eos_token_id,
                pad_token_id=tokenizer.eos_token_id,
            )
        duration_ms = round((time.perf_counter() - started) * 1000)
        continuation = tokenizer.decode(generated[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True).strip()
        output_rows.append({
            "id": row["id"],
            "caseId": row.get("caseId", row["id"]),
            "input": row.get("input"),
            "predicted": continuation,
            "predictionDurationMs": duration_ms,
            "model": str(args.model),
            "instructionPreset": args.instruction_preset,
            "promptFormat": args.prompt_format,
            "loadIn4Bit": not args.no_load_in_4bit,
        })
        print(f"{row['id']}: {duration_ms}ms")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row) + "\n" for row in output_rows), encoding="utf-8")
    print(f"Wrote {len(output_rows)} predictions to {args.output}")


def load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Input JSONL not found: {path}")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError(f"Input JSONL is empty: {path}")
    return rows


if __name__ == "__main__":
    main()
