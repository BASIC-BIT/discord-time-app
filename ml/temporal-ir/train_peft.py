#!/usr/bin/env python3
"""Fine-tune Temporal Plan-IR with plain Transformers + TRL + PEFT.

This is the fallback path when Unsloth/Triton cannot run in WSL because a C
compiler is unavailable. It avoids torch.compile and uses eager attention.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from temporal_ir_prompts import PROMPT_PRESETS, format_training_text, instruction_for_preset


DEFAULT_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
DEFAULT_DATASET = Path(__file__).resolve().parents[2] / "api" / "reports" / "temporal-ml" / "temporal-ir-expanded.jsonl"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "outputs" / "qwen-temporal-ir-peft"


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a Temporal text-to-IR LoRA adapter with TRL+PEFT.")
    parser.add_argument("--dataset", type=Path, default=Path(os.environ.get("TEMPORAL_IR_DATASET", DEFAULT_DATASET)))
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("TEMPORAL_IR_OUTPUT_DIR", DEFAULT_OUTPUT)))
    parser.add_argument("--model", default=os.environ.get("TEMPORAL_IR_BASE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--max-seq-length", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_SEQ_LENGTH", "4096")))
    parser.add_argument("--epochs", type=float, default=float(os.environ.get("TEMPORAL_IR_EPOCHS", "10")))
    parser.add_argument("--batch-size", type=int, default=int(os.environ.get("TEMPORAL_IR_BATCH_SIZE", "1")))
    parser.add_argument("--grad-accum", type=int, default=int(os.environ.get("TEMPORAL_IR_GRAD_ACCUM", "8")))
    parser.add_argument("--learning-rate", type=float, default=float(os.environ.get("TEMPORAL_IR_LR", "2e-4")))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("TEMPORAL_IR_TRAIN_LIMIT", "0")))
    parser.add_argument(
        "--instruction-preset",
        choices=sorted(PROMPT_PRESETS),
        default=os.environ.get("TEMPORAL_IR_INSTRUCTION_PRESET", "detailed"),
        help="Instruction preset used in training examples.",
    )
    parser.add_argument("--wandb-project", default=os.environ.get("WANDB_PROJECT", ""))
    args = parser.parse_args()

    import torch
    from datasets import Dataset, DatasetDict
    from peft import LoraConfig, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    rows = load_rows(args.dataset)
    if args.limit > 0:
        rows = rows[: args.limit]
    dataset = build_dataset(rows, tokenizer.eos_token or "", args.instruction_preset)

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        quantization_config=quantization,
        device_map="auto",
        attn_implementation="eager",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)

    peft_config = LoraConfig(
        r=16,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
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
        bf16=True,
        seed=3407,
    )
    trainer = SFTTrainer(
        model=model,
        args=train_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset.get("validation"),
        peft_config=peft_config,
    )
    trainer.train()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))
    write_run_summary(args.output, args, rows)
    print(f"Saved Temporal IR PEFT adapter and tokenizer to {args.output}")


def load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError(f"Dataset is empty: {path}")
    return rows


def build_dataset(rows: list[dict[str, Any]], eos_token: str, instruction_preset: str) -> "DatasetDict":
    from datasets import Dataset, DatasetDict

    grouped: dict[str, list[dict[str, str]]] = {"train": [], "validation": [], "holdout": []}
    for row in rows:
        split = row.get("split", "train")
        if split not in grouped:
            split = "train"
        grouped[split].append({"text": format_training_text(row, eos_token, instruction_preset)})
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
        "trainer": "trl-peft",
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
    }
    (output_dir / "temporal_ir_run_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
