#!/usr/bin/env python3
"""Fine-tune a small model to emit Temporal Router-IR JSON."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from router_ir_prompts import PROMPT_PRESETS, format_training_text, instruction_for_preset


DEFAULT_MODEL = "unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit"
DEFAULT_DATASET = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-router-ir-current-rows.jsonl"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-router-ir-lora"


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a Temporal Router-IR LoRA adapter with Unsloth.")
    parser.add_argument("--dataset", type=Path, default=Path(os.environ.get("TEMPORAL_ROUTER_IR_DATASET", DEFAULT_DATASET)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("TEMPORAL_ROUTER_IR_OUTPUT_DIR", DEFAULT_OUTPUT)))
    parser.add_argument("--model", default=os.environ.get("TEMPORAL_ROUTER_IR_BASE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--max-seq-length", type=int, default=int(os.environ.get("TEMPORAL_ROUTER_IR_MAX_SEQ_LENGTH", "2048")))
    parser.add_argument("--epochs", type=float, default=float(os.environ.get("TEMPORAL_ROUTER_IR_EPOCHS", "3")))
    parser.add_argument("--batch-size", type=int, default=int(os.environ.get("TEMPORAL_ROUTER_IR_BATCH_SIZE", "2")))
    parser.add_argument("--grad-accum", type=int, default=int(os.environ.get("TEMPORAL_ROUTER_IR_GRAD_ACCUM", "4")))
    parser.add_argument("--learning-rate", type=float, default=float(os.environ.get("TEMPORAL_ROUTER_IR_LR", "2e-4")))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("TEMPORAL_ROUTER_IR_TRAIN_LIMIT", "0")))
    parser.add_argument(
        "--instruction-preset",
        choices=sorted(PROMPT_PRESETS),
        default=os.environ.get("TEMPORAL_ROUTER_IR_INSTRUCTION_PRESET", "minimal"),
        help="Instruction preset used in router training examples.",
    )
    parser.add_argument("--wandb-project", default=os.environ.get("WANDB_PROJECT", ""))
    args = parser.parse_args()

    from unsloth import FastLanguageModel
    from trl import SFTTrainer, SFTConfig

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=True,
    )
    rows = load_rows(args.dataset)
    if args.limit > 0:
        rows = rows[: args.limit]
    dataset = build_dataset(rows, tokenizer.eos_token or "", args.instruction_preset)

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
    print(f"Saved Temporal Router-IR adapter and tokenizer to {args.output}")


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


def build_dataset(rows: list[dict[str, Any]], eos_token: str, instruction_preset: str) -> "DatasetDict":
    from datasets import Dataset, DatasetDict

    grouped: dict[str, list[dict[str, str]]] = {"train": [], "validation": [], "holdout": []}
    for index, row in enumerate(rows):
        split = str(row.get("split", split_for_index(index)))
        if split not in grouped:
            split = "train"
        grouped[split].append({"text": format_training_text(row, eos_token, instruction_preset)})
    datasets = {split: Dataset.from_list(values) for split, values in grouped.items() if values}
    if "train" not in datasets:
        raise ValueError("Dataset must contain at least one train row.")
    return DatasetDict(datasets)


def split_for_index(index: int) -> str:
    if index % 10 == 8:
        return "validation"
    if index % 10 == 9:
        return "holdout"
    return "train"


def write_run_summary(output_dir: Path, args: argparse.Namespace, rows: list[dict[str, Any]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    routes: dict[str, int] = {}
    for index, row in enumerate(rows):
        split = str(row.get("split", split_for_index(index)))
        route = str(row.get("output", {}).get("route", "unknown"))
        counts[split] = counts.get(split, 0) + 1
        routes[route] = routes.get(route, 0) + 1
    summary = {
        "model": args.model,
        "dataset": str(args.dataset),
        "rows": len(rows),
        "splits": counts,
        "routes": routes,
        "epochs": args.epochs,
        "batchSize": args.batch_size,
        "gradientAccumulation": args.grad_accum,
        "learningRate": args.learning_rate,
        "instructionPreset": args.instruction_preset,
        "instruction": instruction_for_preset(args.instruction_preset),
    }
    (output_dir / "temporal_router_ir_run_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
