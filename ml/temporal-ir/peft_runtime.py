"""Shared PEFT runtime for Temporal Plan-IR inference."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Union


ModelPath = Union[str, Path]


@dataclass(frozen=True)
class GenerationResult:
    text: str
    duration_ms: int
    prompt_tokens: int
    completion_tokens: int


class TemporalPeftGenerator:
    def __init__(self, *, base_model: str, adapter: ModelPath, load_in_4bit: bool = True) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        self.tokenizer = AutoTokenizer.from_pretrained(adapter, trust_remote_code=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        quantization = None
        if load_in_4bit:
            quantization = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )

        base = AutoModelForCausalLM.from_pretrained(
            base_model,
            quantization_config=quantization,
            device_map="auto",
            attn_implementation="eager",
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        )
        self.model = PeftModel.from_pretrained(base, adapter)
        self.model.eval()

    def format_chat_prompt(self, messages: list[dict[str, str]], *, enable_thinking: bool = False) -> str:
        if not hasattr(self.tokenizer, "apply_chat_template"):
            raise ValueError("Chat prompt format requires a tokenizer with apply_chat_template.")
        return self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )

    def generate(self, prompt: str, *, max_new_tokens: int, temperature: float = 0) -> GenerationResult:
        import torch

        inputs = self.tokenizer([prompt], return_tensors="pt").to(self.model.device)
        started = time.perf_counter()
        do_sample = temperature > 0
        with torch.inference_mode():
            generated = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=do_sample,
                temperature=temperature if do_sample else None,
                top_p=None,
                eos_token_id=self.tokenizer.eos_token_id,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        duration_ms = round((time.perf_counter() - started) * 1000)
        prompt_tokens = inputs["input_ids"].shape[-1]
        completion_ids = generated[0][prompt_tokens:]
        text = self.tokenizer.decode(completion_ids, skip_special_tokens=True).strip()
        return GenerationResult(
            text=text,
            duration_ms=duration_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=len(completion_ids),
        )
