"""Prompt formatting helpers for Temporal Router-IR training and prediction."""

from __future__ import annotations

import json
from typing import Any


PROMPT_PRESETS = {
    "detailed": (
        "Route the temporal user input to the safest execution path. Return compact Router-IR JSON only. "
        "Use deterministic_only when deterministic parsing is reliable. Use local_plan when the local Temporal Plan-IR model should handle it. "
        "Use clarify when the correct product behavior is to ask a question or show alternatives. "
        "Use escalate_llm when local handling risks a wrong singular answer or lacks evidence. "
        "Allowed routes are deterministic_only, local_plan, clarify, and escalate_llm."
    ),
    "minimal": "Route the temporal user input to compact Router-IR JSON. Return JSON only.",
}


def instruction_for_preset(preset: str) -> str:
    try:
        return PROMPT_PRESETS[preset]
    except KeyError as error:
        valid = ", ".join(sorted(PROMPT_PRESETS))
        raise ValueError(f"Unknown instruction preset {preset!r}. Expected one of: {valid}") from error


def format_prompt(row: dict[str, Any], instruction_preset: str) -> str:
    payload = input_payload(row)
    return (
        "### Instruction:\n"
        f"{instruction_for_preset(instruction_preset)}\n\n"
        "### Input:\n"
        f"{json.dumps(payload, sort_keys=True)}\n\n"
        "### Response:\n"
    )


def format_training_text(row: dict[str, Any], eos_token: str, instruction_preset: str) -> str:
    output = json.dumps(compact_output(row["output"]), sort_keys=True, separators=(",", ":"))
    return f"{format_prompt(row, instruction_preset)}{output}{eos_token}"


def input_payload(row: dict[str, Any]) -> dict[str, Any]:
    input_row = row["input"]
    return {
        "text": input_row["text"],
        "referenceInstant": input_row["referenceInstant"],
        "timeZone": input_row["timeZone"],
    }


def compact_output(output: dict[str, Any]) -> dict[str, Any]:
    return {
        "route": output["route"],
        "confidence": output.get("confidence", 0.8),
        "reasonCodes": output.get("reasonCodes", []),
        "reason": output.get("reason", ""),
    }
