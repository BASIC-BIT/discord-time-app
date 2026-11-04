#!/usr/bin/env python3
"""Serve a PEFT Temporal Plan-IR adapter through a small OpenAI-compatible API."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from peft_runtime import TemporalPeftGenerator
from predict_peft import DEFAULT_ADAPTER_DIR, DEFAULT_BASE_MODEL
from temporal_ir_prompts import PROMPT_FORMATS, instruction_for_preset


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve a Temporal Plan-IR PEFT adapter with OpenAI-compatible routes.")
    parser.add_argument("--base-model", default=os.environ.get("TEMPORAL_IR_BASE_MODEL", DEFAULT_BASE_MODEL))
    parser.add_argument("--adapter", default=os.environ.get("TEMPORAL_IR_ADAPTER_DIR", str(DEFAULT_ADAPTER_DIR)))
    parser.add_argument("--model-name", default=os.environ.get("TEMPORAL_IR_SERVED_MODEL_NAME", "qwen-temporal-ir"))
    parser.add_argument("--host", default=os.environ.get("TEMPORAL_IR_SERVER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TEMPORAL_IR_SERVER_PORT", "8000")))
    parser.add_argument("--max-new-tokens", type=int, default=int(os.environ.get("TEMPORAL_IR_MAX_NEW_TOKENS", "512")))
    parser.add_argument("--auth-token", default=os.environ.get("TEMPORAL_IR_SERVER_AUTH_TOKEN"))
    parser.add_argument(
        "--prompt-format",
        choices=sorted(PROMPT_FORMATS),
        default=os.environ.get("TEMPORAL_IR_PROMPT_FORMAT", "custom"),
        help="Prompt format expected by the served adapter. Chat format applies the tokenizer chat template on chat routes.",
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
        help="Load the base model in bf16/fp16 instead of the known-good BitsAndBytes 4-bit path.",
    )
    parser.add_argument(
        "--prewarm",
        action="store_true",
        default=os.environ.get("TEMPORAL_IR_PREWARM", "").lower() in {"1", "true", "yes", "on"},
        help="Run representative generations before listening so Triton JIT/autotune happens at startup, not on the first request.",
    )
    args = parser.parse_args()

    generator = TemporalPeftGenerator(base_model=args.base_model, adapter=args.adapter, load_in_4bit=not args.no_load_in_4bit)
    state = ServerState(
        generator=generator,
        model_name=args.model_name,
        default_max_new_tokens=args.max_new_tokens,
        auth_token=args.auth_token,
        prompt_format=args.prompt_format,
        enable_thinking=args.enable_thinking,
    )

    if args.prewarm:
        prewarm(state)

    handler = create_handler(state)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {args.model_name} on http://{args.host}:{args.port}/v1")
    server.serve_forever()


class ServerState:
    def __init__(
        self,
        *,
        generator: TemporalPeftGenerator,
        model_name: str,
        default_max_new_tokens: int,
        auth_token: str | None,
        prompt_format: str,
        enable_thinking: bool,
    ) -> None:
        self.generator = generator
        self.model_name = model_name
        self.default_max_new_tokens = default_max_new_tokens
        self.auth_token = auth_token
        self.prompt_format = prompt_format
        self.enable_thinking = enable_thinking
        self.lock = threading.Lock()
        self.cancel_events: dict[str, threading.Event] = {}
        self.cancel_events_lock = threading.Lock()

    def register_request(self, request_id: str) -> threading.Event:
        event = threading.Event()
        with self.cancel_events_lock:
            self.cancel_events[request_id] = event
        return event

    def cancel_request(self, request_id: str) -> bool:
        with self.cancel_events_lock:
            event = self.cancel_events.get(request_id)
        if event is not None:
            event.set()
            return True
        return False

    def unregister_request(self, request_id: str, event: threading.Event) -> None:
        with self.cancel_events_lock:
            if self.cancel_events.get(request_id) is event:
                self.cancel_events.pop(request_id, None)


class GenerationCancelled(Exception):
    pass


PREWARM_REFERENCE_INSTANT = "2026-05-24T12:00:00Z"
PREWARM_TIME_ZONE = "America/New_York"
PREWARM_EVENT_POST = (
    "BITRATE returns this weekend!\n"
    "Doors open saturday at 9pm EST, DJs from 9:30 until 1am.\n"
    "Afterparty in the lounge right after, bring friends and dress in neon.\n"
    "See you there and check the pinned post for the world link."
)
# (text, max_new_tokens, discordTimestampRouting override or None for a plain no-reference input).
PREWARM_CASES: list[tuple[str, int, dict[str, Any] | None]] = [
    ("tomorrow at 5pm", 64, None),
    ("next friday 7:30pm", 64, None),
    ("in 45 minutes", 64, None),
    ("saturday 2pm-4pm", 256, None),
    ("3-5pm UK time on monday", 256, None),
    (
        "<t:1785643200:t> two hours later",
        64,
        {
            "meaningfulResidue": True,
            "reason": "semantic_residue_requires_model",
            "references": [{
                "contextClass": "plain", "end": 16, "epochSeconds": 1785643200, "formatCode": ":t",
                "formatIndex": 2, "raw": "<t:1785643200:t>", "start": 0,
            }],
            "route": "model",
            "signals": ["duration", "subday_duration"],
        },
    ),
    (PREWARM_EVENT_POST, 256, None),
]


def prewarm_user_content(text: str, routing_override: dict[str, Any] | None) -> str:
    """Mirror formatEndpointPlanPrompt (api/src/temporal/graph.ts) for the chat format with the minimal preset."""
    length = len(text)
    routing: dict[str, Any] = {
        "contextClass": "plain",
        "inputLength": length,
        "inputLengthBucket": "0-64" if length <= 64 else "65-256",
        "malformedCount": 0,
        "meaningfulResidue": False,
        "modelEligible": True,
        "reason": "no_timestamp_reference",
        "references": [],
        "route": "no_reference",
        "signals": [],
        "version": "discord-reference-v2",
    }
    routing.update(routing_override or {})
    payload = {
        "discordTimestampRouting": routing,
        "referenceInstant": PREWARM_REFERENCE_INSTANT,
        "text": text,
        "timeZone": PREWARM_TIME_ZONE,
    }
    return f"{instruction_for_preset('minimal')}\n\nInput:\n{json.dumps(payload, sort_keys=True)}"


def prewarm(state: ServerState) -> None:
    """Exercise the chat-request generate path so Triton kernels compile before the server accepts traffic."""
    started = time.perf_counter()
    for text, max_new_tokens, routing_override in PREWARM_CASES:
        case_started = time.perf_counter()
        label = text.splitlines()[0][:40]
        try:
            messages = [{"role": "user", "content": prewarm_user_content(text, routing_override)}]
            prompt = prompt_from_messages(messages)
            if state.prompt_format == "chat":
                prompt = state.generator.format_chat_prompt(messages, enable_thinking=state.enable_thinking)
            result = generate_locked(state, prompt, max_new_tokens=max_new_tokens, temperature=0, cancel_event=threading.Event())
            elapsed_ms = round((time.perf_counter() - case_started) * 1000)
            print(f"prewarm {label!r}: {elapsed_ms} ms ({result.prompt_tokens} prompt + {result.completion_tokens} completion tokens)")
        except Exception as error:  # noqa: BLE001 - prewarm is best-effort; serving must still start.
            print(f"prewarm {label!r} failed: {error!r}")
    print(f"prewarm done in {round((time.perf_counter() - started) * 1000)} ms")


def create_handler(state: ServerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "TemporalPeftOpenAI/0.1"

        def do_GET(self) -> None:
            # RunPod load-balancer health probe, unauthenticated; main() listens only after the model loads, so 200 means loaded.
            if self.path == "/ping":
                self.write_json({"status": "healthy", "model": state.model_name})
                return
            if not self.authorized():
                return
            if self.path in {"/health", "/v1/health"}:
                self.write_json({"status": "ok", "model": state.model_name})
                return
            if self.path in {"/v1/models", "/models"}:
                now = int(time.time())
                self.write_json({
                    "object": "list",
                    "data": [{"id": state.model_name, "object": "model", "created": now, "owned_by": "local"}],
                })
                return
            self.write_error(HTTPStatus.NOT_FOUND, "unknown route")

        def do_POST(self) -> None:
            if not self.authorized():
                return
            try:
                payload = self.read_json()
                if self.path in {"/v1/cancel", "/cancel"}:
                    request_id = payload.get("request_id")
                    if not isinstance(request_id, str) or not request_id:
                        raise ValueError("request_id must be a non-empty string")
                    self.write_json({"request_id": request_id, "cancelled": state.cancel_request(request_id)})
                    return
                request_id = self.headers.get("x-request-id") or uuid.uuid4().hex
                cancel_event = state.register_request(request_id)
                try:
                    if self.path in {"/v1/completions", "/completions"}:
                        self.handle_completions(payload, cancel_event)
                        return
                    if self.path in {"/v1/chat/completions", "/chat/completions"}:
                        self.handle_chat_completions(payload, cancel_event)
                        return
                finally:
                    state.unregister_request(request_id, cancel_event)
                self.write_error(HTTPStatus.NOT_FOUND, "unknown route")
            except GenerationCancelled:
                self.write_error(499, "generation cancelled")
            except Exception as error:  # noqa: BLE001 - HTTP boundary should serialize unexpected failures.
                self.write_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

        def handle_completions(self, payload: dict[str, Any], cancel_event: threading.Event) -> None:
            prompts = normalize_prompts(payload.get("prompt"))
            max_tokens = normalize_max_tokens(payload.get("max_tokens"), state.default_max_new_tokens)
            temperature = normalize_temperature(payload.get("temperature"))
            stop = normalize_stop(payload.get("stop"))
            choices = []
            usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            for index, prompt in enumerate(prompts):
                result = generate_locked(state, prompt, max_new_tokens=max_tokens, temperature=temperature, cancel_event=cancel_event)
                text = apply_stop(result.text, stop)
                choices.append({"text": text, "index": index, "logprobs": None, "finish_reason": "stop"})
                usage["prompt_tokens"] += result.prompt_tokens
                usage["completion_tokens"] += result.completion_tokens
            usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
            self.write_json(openai_response("text_completion", state.model_name, choices, usage))

        def handle_chat_completions(self, payload: dict[str, Any], cancel_event: threading.Event) -> None:
            messages = normalize_messages(payload.get("messages"))
            prompt = prompt_from_messages(messages)
            if state.prompt_format == "chat":
                prompt = state.generator.format_chat_prompt(messages, enable_thinking=state.enable_thinking)
            max_tokens = normalize_max_tokens(payload.get("max_tokens"), state.default_max_new_tokens)
            temperature = normalize_temperature(payload.get("temperature"))
            stop = normalize_stop(payload.get("stop"))
            result = generate_locked(state, prompt, max_new_tokens=max_tokens, temperature=temperature, cancel_event=cancel_event)
            text = apply_stop(result.text, stop)
            choice = {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
            usage = {
                "prompt_tokens": result.prompt_tokens,
                "completion_tokens": result.completion_tokens,
                "total_tokens": result.prompt_tokens + result.completion_tokens,
            }
            self.write_json(openai_response("chat.completion", state.model_name, [choice], usage))

        def read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                raise ValueError("request body is empty")
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("request body must be a JSON object")
            return data

        def authorized(self) -> bool:
            if state.auth_token is None:
                return True
            expected = f"Bearer {state.auth_token}"
            if self.headers.get("Authorization") == expected:
                return True
            self.write_error(HTTPStatus.UNAUTHORIZED, "unauthorized")
            return False

        def write_json(self, body: dict[str, Any], status: int | HTTPStatus = HTTPStatus.OK) -> None:
            encoded = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                # The caller commonly closes its socket before the cooperative
                # cancellation response can be written.
                return

        def write_error(self, status: int | HTTPStatus, message: str) -> None:
            self.write_json({"error": {"message": message, "type": "server_error"}}, status=status)

        def log_message(self, format: str, *args: object) -> None:
            print(f"{self.address_string()} - {format % args}")

    return Handler


def generate_locked(
    state: ServerState,
    prompt: str,
    *,
    max_new_tokens: int,
    temperature: float,
    cancel_event: threading.Event,
):
    while not cancel_event.is_set():
        if state.lock.acquire(timeout=0.05):
            break
    else:
        raise GenerationCancelled()
    try:
        if cancel_event.is_set():
            raise GenerationCancelled()
        result = state.generator.generate(
            prompt,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            cancel_event=cancel_event,
        )
        if cancel_event.is_set():
            raise GenerationCancelled()
        return result
    finally:
        state.lock.release()


def normalize_prompts(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return value
    raise ValueError("prompt must be a string or a non-empty list of strings")


def normalize_messages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("messages must be a non-empty array")
    messages = []
    for message in value:
        if not isinstance(message, dict):
            raise ValueError("messages entries must be objects")
        role = message.get("role")
        if not isinstance(role, str) or role.strip() == "":
            raise ValueError("messages entries must include a string role")
        content = message_content_to_text(message.get("content"))
        if content is not None:
            messages.append({"role": role, "content": content})
    if not messages:
        raise ValueError("messages did not contain string content")
    return messages


def message_content_to_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        if parts:
            return "\n".join(parts)
    return None


def prompt_from_messages(value: Any) -> str:
    messages = normalize_messages(value)
    return "\n".join(message["content"] for message in messages if isinstance(message.get("content"), str))


def normalize_max_tokens(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, int) and value > 0:
        return value
    raise ValueError("max_tokens must be a positive integer")


def normalize_temperature(value: Any) -> float:
    if value is None:
        return 0
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    raise ValueError("temperature must be a non-negative number")


def normalize_stop(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise ValueError("stop must be a string or list of strings")


def apply_stop(text: str, stop: list[str]) -> str:
    best_index = None
    for marker in stop:
        index = text.find(marker)
        if index >= 0 and (best_index is None or index < best_index):
            best_index = index
    return text if best_index is None else text[:best_index]


def openai_response(object_type: str, model: str, choices: list[dict[str, Any]], usage: dict[str, int]) -> dict[str, Any]:
    return {
        "id": f"cmpl-{uuid.uuid4().hex}",
        "object": object_type,
        "created": int(time.time()),
        "model": model,
        "choices": choices,
        "usage": usage,
    }


if __name__ == "__main__":
    main()
