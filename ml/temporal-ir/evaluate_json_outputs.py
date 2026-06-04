#!/usr/bin/env python3
"""Compute simple JSON-output metrics for Temporal IR model predictions.

Expected input JSONL rows:
{"id":"...","expected":{...},"predicted":"{...json...}"}

This is intentionally lightweight. The production-grade evaluator should execute
predicted IR through the TypeScript deterministic executor and compare candidate
sets, not only exact JSON.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Temporal IR JSON predictions.")
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    rows = [json.loads(line) for line in args.predictions.read_text(encoding="utf-8").splitlines() if line.strip()]
    metrics = compute_metrics(rows)
    output = json.dumps(metrics, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")


def compute_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    valid_json = 0
    exact = 0
    outcome_match = 0
    for row in rows:
        expected = row.get("expected")
        predicted_raw = row.get("predicted", "")
        try:
            predicted = json.loads(predicted_raw) if isinstance(predicted_raw, str) else predicted_raw
            valid_json += 1
        except json.JSONDecodeError:
            continue
        if canonical(predicted) == canonical(expected):
            exact += 1
        if isinstance(predicted, dict) and isinstance(expected, dict) and predicted.get("outcome") == expected.get("outcome"):
            outcome_match += 1
    total = len(rows)
    return {
        "total": total,
        "validJson": valid_json,
        "validJsonRate": ratio(valid_json, total),
        "exactJsonMatch": exact,
        "exactJsonMatchRate": ratio(exact, total),
        "outcomeMatch": outcome_match,
        "outcomeMatchRate": ratio(outcome_match, total),
    }


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


if __name__ == "__main__":
    main()
