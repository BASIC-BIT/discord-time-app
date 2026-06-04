#!/usr/bin/env python3
"""RunPod Serverless worker for the Temporal Plan-IR PEFT adapter."""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Any

import runpod

from peft_runtime import TemporalPeftGenerator
from predict_peft import DEFAULT_ADAPTER_DIR, DEFAULT_BASE_MODEL
from serve_peft_openai import (
    apply_stop,
    normalize_max_tokens,
    normalize_prompts,
    normalize_stop,
    normalize_temperature,
    openai_response,
    prompt_from_messages,
)


class WorkerState:
    def __init__(self) -> None:
        self.model_name = os.environ.get("TEMPORAL_IR_SERVED_MODEL_NAME", "qwen-temporal-ir")
        self.default_max_new_tokens = int(os.environ.get("TEMPORAL_IR_MAX_NEW_TOKENS", "512"))
        self.base_model = os.environ.get("TEMPORAL_IR_BASE_MODEL", DEFAULT_BASE_MODEL)
        self.adapter = os.environ.get("TEMPORAL_IR_ADAPTER_DIR", str(DEFAULT_ADAPTER_DIR))
        self.load_in_4bit = not truthy(os.environ.get("TEMPORAL_IR_NO_LOAD_IN_4BIT"))
        self.generator: TemporalPeftGenerator | None = None
        self.lock = threading.Lock()

    def generate(self, prompt: str, *, max_new_tokens: int, temperature: float) -> Any:
        with self.lock:
            if self.generator is None:
                print(
                    f"Temporal PEFT model loading: base={self.base_model} adapter={self.adapter} "
                    f"load_in_4bit={self.load_in_4bit}",
                    flush=True,
                )
                started = time.perf_counter()
                self.generator = TemporalPeftGenerator(
                    base_model=self.base_model,
                    adapter=self.adapter,
                    load_in_4bit=self.load_in_4bit,
                )
                duration_ms = round((time.perf_counter() - started) * 1000)
                print(f"Temporal PEFT model loaded in {duration_ms}ms", flush=True)
            return self.generator.generate(prompt, max_new_tokens=max_new_tokens, temperature=temperature)


def main() -> None:
    print("Temporal PEFT RunPod worker starting", flush=True)
    try:
        state = WorkerState()
    except Exception as error:  # noqa: BLE001 - fail startup loudly so RunPod replaces unhealthy workers.
        print(f"Temporal PEFT worker startup failed: {error}", file=sys.stderr)
        raise

    print(f"Temporal PEFT worker ready for {state.model_name}; model will load lazily", flush=True)

    def handler(job: dict[str, Any]) -> dict[str, Any]:
        payload = job.get("input")
        if not isinstance(payload, dict):
            raise ValueError("job input must be a JSON object")

        openai_route = payload.get("openai_route")
        if isinstance(openai_route, str):
            openai_input = payload.get("openai_input") or {}
            if not isinstance(openai_input, dict):
                raise ValueError("openai_input must be a JSON object")
            return handle_openai_route(state, openai_route, openai_input)

        return handle_standard_job(state, payload)

    runpod.serverless.start({"handler": handler})


def handle_openai_route(state: WorkerState, route: str, payload: dict[str, Any]) -> dict[str, Any]:
    if route == "/v1/models":
        return {
            "object": "list",
            "data": [{"id": state.model_name, "object": "model", "created": 0, "owned_by": "runpod"}],
        }
    if route == "/v1/completions":
        return completion_response(state, payload)
    if route == "/v1/chat/completions":
        return chat_completion_response(state, payload)
    return {"error": {"message": f"unsupported OpenAI route: {route}", "type": "invalid_request_error"}}


def handle_standard_job(state: WorkerState, payload: dict[str, Any]) -> dict[str, Any]:
    if "messages" in payload:
        return chat_completion_response(state, {
            "messages": payload["messages"],
            "max_tokens": sampling_params(payload).get("max_tokens"),
            "temperature": sampling_params(payload).get("temperature"),
            "stop": sampling_params(payload).get("stop"),
        })
    return completion_response(state, {
        "prompt": payload.get("prompt"),
        "max_tokens": sampling_params(payload).get("max_tokens"),
        "temperature": sampling_params(payload).get("temperature"),
        "stop": sampling_params(payload).get("stop"),
    })


def completion_response(state: WorkerState, payload: dict[str, Any]) -> dict[str, Any]:
    prompts = normalize_prompts(payload.get("prompt"))
    max_tokens = normalize_max_tokens(payload.get("max_tokens"), state.default_max_new_tokens)
    temperature = normalize_temperature(payload.get("temperature"))
    stop = normalize_stop(payload.get("stop"))
    choices = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    for index, prompt in enumerate(prompts):
        result = state.generate(prompt, max_new_tokens=max_tokens, temperature=temperature)
        choices.append({
            "text": apply_stop(result.text, stop),
            "index": index,
            "logprobs": None,
            "finish_reason": "stop",
        })
        usage["prompt_tokens"] += result.prompt_tokens
        usage["completion_tokens"] += result.completion_tokens
    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    return openai_response("text_completion", state.model_name, choices, usage)


def chat_completion_response(state: WorkerState, payload: dict[str, Any]) -> dict[str, Any]:
    prompt = prompt_from_messages(payload.get("messages"))
    max_tokens = normalize_max_tokens(payload.get("max_tokens"), state.default_max_new_tokens)
    temperature = normalize_temperature(payload.get("temperature"))
    stop = normalize_stop(payload.get("stop"))
    result = state.generate(prompt, max_new_tokens=max_tokens, temperature=temperature)
    text = apply_stop(result.text, stop)
    return openai_response(
        "chat.completion",
        state.model_name,
        [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.prompt_tokens + result.completion_tokens,
        },
    )


def sampling_params(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("sampling_params")
    return value if isinstance(value, dict) else {}


def truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    main()
