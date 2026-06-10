#!/usr/bin/env python3
"""Plot Trainer loss/eval-loss and optional JSON accuracy metrics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot Temporal IR training metrics.")
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--metrics", type=Path, default=None, help="Optional JSON metrics file from evaluate_json_outputs.py")
    args = parser.parse_args()

    import matplotlib.pyplot as plt

    trainer_state = find_trainer_state(args.run_dir)
    if not trainer_state.exists():
        raise FileNotFoundError(f"Missing trainer state: {trainer_state}")
    state = json.loads(trainer_state.read_text(encoding="utf-8"))
    history = state.get("log_history", [])
    output_dir = args.run_dir / "plots"
    output_dir.mkdir(parents=True, exist_ok=True)

    plot_series(
        plt,
        history,
        key="loss",
        title="Temporal IR Training Loss",
        ylabel="loss",
        output=output_dir / "loss.png",
    )
    plot_series(
        plt,
        history,
        key="eval_loss",
        title="Temporal IR Eval Loss",
        ylabel="eval loss",
        output=output_dir / "eval_loss.png",
    )
    if args.metrics is not None and args.metrics.exists():
        plot_accuracy_bars(plt, json.loads(args.metrics.read_text(encoding="utf-8")), output_dir / "json_accuracy.png")
    print(f"Wrote plots to {output_dir}")


def find_trainer_state(run_dir: Path) -> Path:
    trainer_state = run_dir / "trainer_state.json"
    if trainer_state.exists():
        return trainer_state
    checkpoints = sorted(
        (path for path in run_dir.glob("checkpoint-*/trainer_state.json")),
        key=lambda path: checkpoint_step(path.parent),
    )
    return checkpoints[-1] if checkpoints else trainer_state


def checkpoint_step(path: Path) -> int:
    try:
        return int(path.name.removeprefix("checkpoint-"))
    except ValueError:
        return -1


def plot_series(plt: Any, history: list[dict[str, Any]], key: str, title: str, ylabel: str, output: Path) -> None:
    points = [(entry.get("step"), entry.get(key)) for entry in history if key in entry and entry.get("step") is not None]
    if not points:
        return
    xs, ys = zip(*points)
    plt.figure(figsize=(9, 5))
    plt.plot(xs, ys, marker="o", linewidth=1.5)
    plt.title(title)
    plt.xlabel("step")
    plt.ylabel(ylabel)
    plt.grid(True, alpha=0.25)
    plt.tight_layout()
    plt.savefig(output)
    plt.close()


def plot_accuracy_bars(plt: Any, metrics: dict[str, Any], output: Path) -> None:
    names = ["valid JSON", "exact JSON", "outcome"]
    values = [
        metrics.get("validJsonRate", 0),
        metrics.get("exactJsonMatchRate", 0),
        metrics.get("outcomeMatchRate", 0),
    ]
    plt.figure(figsize=(7, 5))
    plt.bar(names, values)
    plt.ylim(0, 1)
    plt.title("Temporal IR JSON Metrics")
    plt.ylabel("rate")
    for index, value in enumerate(values):
        plt.text(index, min(1, value + 0.03), f"{value:.1%}", ha="center")
    plt.tight_layout()
    plt.savefig(output)
    plt.close()


if __name__ == "__main__":
    main()
