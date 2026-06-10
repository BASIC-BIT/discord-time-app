#!/usr/bin/env python3
"""Run a trained TRL+PEFT Temporal Plan-IR adapter on JSONL inputs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from peft_runtime import TemporalPeftGenerator
from temporal_ir_prompts import PROMPT_PRESETS, format_prompt


DEFAULT_BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
DEFAULT_ADAPTER_DIR = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-peft"
DEFAULT_INPUT = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-eval-input.jsonl"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-eval-predictions.jsonl"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Temporal Plan-IR predictions from a PEFT adapter.")
    parser.add_argument("--base-model", default=os.environ.get("TEMPORAL_IR_BASE_MODEL", DEFAULT_BASE_MODEL))
    parser.add_argument("--adapter", default=os.environ.get("TEMPORAL_IR_ADAPTER_DIR", str(DEFAULT_ADAPTER_DIR)))
    parser.add_argument("--input", type=Path, default=Path(os.environ.get("TEMPORAL_IR_PREDICT_INPUT", DEFAULT_INPUT)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("TEMPORAL_IR_PREDICT_OUTPUT", DEFAULT_OUTPUT)))
    parser.add_argument("--max-new-tokens", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_NEW_TOKENS", "512")))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("TEMPORAL_IR_PREDICT_LIMIT", "0")))
    parser.add_argument(
        "--no-load-in-4bit",
        action="store_true",
        help="Load the base model in bf16/fp16 instead of BitsAndBytes 4-bit. Useful for hosted vLLM parity checks.",
    )
    parser.add_argument(
        "--instruction-preset",
        choices=sorted(PROMPT_PRESETS),
        default=os.environ.get("TEMPORAL_IR_INSTRUCTION_PRESET", "detailed"),
        help="Instruction preset used for inference prompts.",
    )
    args = parser.parse_args()

    generator = TemporalPeftGenerator(base_model=args.base_model, adapter=args.adapter, load_in_4bit=not args.no_load_in_4bit)

    rows = load_rows(args.input)
    if args.limit > 0:
        rows = rows[: args.limit]

    output_rows = []
    for row in rows:
        prompt = format_prompt(row, args.instruction_preset)
        result = generator.generate(prompt, max_new_tokens=args.max_new_tokens)
        output_rows.append({
            "id": row["id"],
            "caseId": row.get("caseId", row["id"]),
            "input": row.get("input"),
            "predicted": result.text,
            "predictionDurationMs": result.duration_ms,
            "model": args.adapter,
            "instructionPreset": args.instruction_preset,
        })
        print(f"{row['id']}: {result.duration_ms}ms")

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
