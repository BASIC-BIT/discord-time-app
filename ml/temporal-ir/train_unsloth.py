#!/usr/bin/env python3
"""Fine-tune a small model to emit Temporal Plan-IR JSON.

Run from WSL/Linux after installing requirements-unsloth.txt. This script is
intentionally outside the production app path; it produces experiment artifacts
under ml/temporal-ir/outputs by default.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from temporal_ir_prompts import PROMPT_FORMATS, PROMPT_PRESETS, format_training_chat_text, format_training_text, instruction_for_preset


DEFAULT_MODEL = "unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit"
DEFAULT_DATASET = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-ir-expanded.jsonl"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-lora"

TRAIN_MIX_TARGETS = {
    "standard": (0.50, 0.65),
    "common_messy": (0.15, 0.30),
    "ambiguity": (0.10, 0.25),
    "hard_boundary": (0.05, 0.12),
}
HARD_BOUNDARY_TAGS = {"unsupported", "recurrence", "explicit-epoch-rejection", "critical-boundary", "recursive-composition"}
COMMON_MESSY_TAGS = {
    "weekday-typo",
    "relative-typo",
    "month-typo",
    "casing",
    "whitespace",
    "noise",
    "multiline",
    "date-separator-variance",
    "clock-separator-variance",
    "fuzzy-clock",
    "clock-suffix-ambiguity",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a Temporal text-to-IR LoRA adapter with Unsloth.")
    parser.add_argument("--dataset", type=Path, default=Path(os.environ.get("TEMPORAL_IR_DATASET", DEFAULT_DATASET)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("TEMPORAL_IR_OUTPUT_DIR", DEFAULT_OUTPUT)))
    parser.add_argument("--model", default=os.environ.get("TEMPORAL_IR_BASE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--max-seq-length", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_SEQ_LENGTH", "4096")))
    parser.add_argument("--epochs", type=float, default=float(os.environ.get("TEMPORAL_IR_EPOCHS", "3")))
    parser.add_argument("--batch-size", type=int, default=int(os.environ.get("TEMPORAL_IR_BATCH_SIZE", "2")))
    parser.add_argument("--grad-accum", type=int, default=int(os.environ.get("TEMPORAL_IR_GRAD_ACCUM", "4")))
    parser.add_argument("--learning-rate", type=float, default=float(os.environ.get("TEMPORAL_IR_LR", "2e-4")))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("TEMPORAL_IR_TRAIN_LIMIT", "0")))
    parser.add_argument(
        "--prompt-format",
        choices=sorted(PROMPT_FORMATS),
        default=os.environ.get("TEMPORAL_IR_PROMPT_FORMAT", "custom"),
        help="Prompt format used for training examples.",
    )
    parser.add_argument(
        "--no-load-in-4bit",
        action="store_true",
        default=is_truthy(os.environ.get("TEMPORAL_IR_NO_LOAD_IN_4BIT", "")),
        help="Load the base model in bf16/fp16 instead of the default 4-bit QLoRA path.",
    )
    parser.add_argument("--skip-mix-check", action="store_true", default=is_truthy(os.environ.get("TEMPORAL_IR_SKIP_MIX_CHECK", "")))
    parser.add_argument("--check-mix-only", action="store_true", default=is_truthy(os.environ.get("TEMPORAL_IR_CHECK_MIX_ONLY", "")))
    parser.add_argument(
        "--instruction-preset",
        choices=sorted(PROMPT_PRESETS),
        default=os.environ.get("TEMPORAL_IR_INSTRUCTION_PRESET", "detailed"),
        help="Instruction preset used in training examples.",
    )
    parser.add_argument("--wandb-project", default=os.environ.get("WANDB_PROJECT", ""))
    args = parser.parse_args()

    rows = load_rows(args.dataset)
    if args.limit > 0:
        rows = rows[: args.limit]
    if not args.skip_mix_check:
        validate_dataset_mix(rows)
    if args.check_mix_only:
        return

    # Heavy ML imports stay inside main so syntax checks do not require the GPU stack.
    from unsloth import FastLanguageModel
    from trl import SFTTrainer, SFTConfig

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=not args.no_load_in_4bit,
    )
    dataset = build_dataset(rows, tokenizer, args.instruction_preset, args.prompt_format)

    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    report_to = ["wandb"] if args.wandb_project else []
    if args.wandb_project:
        os.environ.setdefault("WANDB_PROJECT", args.wandb_project)

    train_args = SFTConfig(
        output_dir=str(args.output),
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        warmup_ratio=0.03,
        logging_steps=1,
        eval_strategy="steps" if "validation" in dataset else "no",
        eval_steps=10,
        save_strategy="epoch",
        report_to=report_to,
        seed=3407,
    )
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset["train"],
        eval_dataset=dataset.get("validation"),
        args=train_args,
    )
    trainer.train()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))
    write_run_summary(args.output, args, rows)
    print(f"Saved Temporal IR adapter and tokenizer to {args.output}")


def load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    if not rows:
        raise ValueError(f"Dataset is empty: {path}")
    return rows


def validate_dataset_mix(rows: list[dict[str, Any]]) -> None:
    train_rows = [row for row in rows if row.get("split", "train") == "train"]
    if not train_rows:
        raise ValueError("Dataset mix check requires at least one train row.")

    counts = {bucket: 0 for bucket in TRAIN_MIX_TARGETS}
    missing_tags: list[str] = []
    for row in train_rows:
        tags = row.get("tags")
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            missing_tags.append(str(row.get("id", "<unknown>")))
            continue
        counts[classify_dataset_bucket(set(tags))] += 1

    if missing_tags:
        preview = ", ".join(missing_tags[:10])
        raise ValueError(f"Dataset mix check failed: rows missing string tags: {preview}")

    total = len(train_rows)
    failures: list[str] = []
    summary: list[str] = []
    for bucket, (minimum, maximum) in TRAIN_MIX_TARGETS.items():
        ratio = counts[bucket] / total
        summary.append(f"{bucket}={ratio:.1%} ({counts[bucket]}/{total})")
        if ratio < minimum or ratio > maximum:
            failures.append(f"{bucket} {ratio:.1%} outside {minimum:.0%}-{maximum:.0%}")

    print("Dataset train mix: " + ", ".join(summary))
    if failures:
        raise ValueError("Dataset mix check failed: " + "; ".join(failures))


def classify_dataset_bucket(tags: set[str]) -> str:
    if tags.intersection(HARD_BOUNDARY_TAGS):
        return "hard_boundary"
    if "ambiguity" in tags:
        return "ambiguity"
    if tags.intersection(COMMON_MESSY_TAGS):
        return "common_messy"
    return "standard"


def is_truthy(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def build_dataset(rows: list[dict[str, Any]], tokenizer: Any, instruction_preset: str, prompt_format: str) -> "DatasetDict":
    from datasets import Dataset, DatasetDict

    grouped: dict[str, list[dict[str, str]]] = {"train": [], "validation": [], "holdout": []}
    for row in rows:
        split = row.get("split", "train")
        if split not in grouped:
            split = "train"
        if prompt_format == "chat":
            text = format_training_chat_text(row, tokenizer, instruction_preset)
        else:
            text = format_training_text(row, tokenizer.eos_token or "", instruction_preset)
        grouped[split].append({"text": text})
    datasets = {split: Dataset.from_list(values) for split, values in grouped.items() if values}
    if "train" not in datasets:
        raise ValueError("Dataset must contain at least one train row.")
    return DatasetDict(datasets)


def write_run_summary(output_dir: Path, args: argparse.Namespace, rows: list[dict[str, Any]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for row in rows:
        split = str(row.get("split", "train"))
        counts[split] = counts.get(split, 0) + 1
    summary = {
        "model": args.model,
        "dataset": str(args.dataset),
        "rows": len(rows),
        "splits": counts,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "gradientAccumulation": args.grad_accum,
        "learningRate": args.learning_rate,
        "instructionPreset": args.instruction_preset,
        "instruction": instruction_for_preset(args.instruction_preset),
        "promptFormat": args.prompt_format,
        "loadIn4Bit": not args.no_load_in_4bit,
    }
    (output_dir / "temporal_ir_run_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
