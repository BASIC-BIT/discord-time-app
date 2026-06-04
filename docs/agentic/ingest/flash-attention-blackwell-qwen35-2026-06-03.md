# FlashAttention On RTX 5090 For Qwen3.5 Temporal IR

Date: 2026-06-03

## Summary

- Current Temporal IR Qwen3.5 Docker image is healthy without `flash-attn`: it uses `xformers==0.0.33.post2`, `torch==2.9.1+cu128`, CUDA 12.8, and RTX 5090 compute capability `sm_120`.
- `flash-attn` 2.x is not installed in the current container. Unsloth therefore reports `FA2 = False` and falls back to Xformers.
- Official `flash-attn` 2.x docs still describe CUDA FA2 support around Ampere, Ada, and Hopper, with Linux and CUDA 12+. They do not list Blackwell/RTX 5090 as a normal FA2 target.
- `flash-attn-4` is a new beta package aimed at Hopper and Blackwell GPUs. It is a better isolated experiment target than forcing FA2 into the current image.
- Do not mutate the known-good Qwen3.5 Docker image for FA2. If kernel work is worth doing, test it in a new Docker tag after adapter correctness and latency are evaluated.

## Current Environment Probe

- Image: `hammer-overlay-temporal-ir-qwen35:cuda12.8`
- Base: `nvidia/cuda:12.8.1-devel-ubuntu24.04`
- Python: `3.12`
- Torch: `2.9.1+cu128`
- CUDA runtime reported by torch: `12.8`
- Torch C++ ABI: `True`
- GPU: `NVIDIA GeForce RTX 5090`
- Compute capability: `(12, 0)`
- Installed attention-related packages:
- `flash-attn`: not installed
- `xformers==0.0.33.post2`
- `causal-conv1d==1.6.2.post1`
- `flash-linear-attention==0.5.0`
- `unsloth==2026.5.8`

## Sources

- Dao-AILab FlashAttention README: https://github.com/Dao-AILab/flash-attention
- `flash-attn` PyPI: https://pypi.org/project/flash-attn/
- `flash-attn-4` PyPI: https://pypi.org/project/flash-attn-4/
- FlashAttention issue 1799, RTX 5090 / CUDA 12.8 / torch 2.8 build failure report: https://github.com/Dao-AILab/flash-attention/issues/1799
- FlashAttention issue 1885, Windows / Python 3.12 / CUDA 12.8 wheel failure report: https://github.com/Dao-AILab/flash-attention/issues/1885
- Unsloth issue 4417 includes the same warning text: `Your Flash Attention 2 installation seems to be broken. Using Xformers instead.` https://github.com/unslothai/unsloth/issues/4417
- Unsloth issue 4906 discusses Qwen3.5 on Blackwell with torch CUDA 12.8/13.0 and notes Axolotl + flash attention as a comparison path for very long contexts: https://github.com/unslothai/unsloth/issues/4906

## Fit Notes

- `flash-attn` 2.8.3 is source-only on PyPI. That means adopting it in this repo requires a compile step and should be tested in a throwaway Docker tag, not added directly to the current known-good image.
- The official README recommends CUDA 12.8 for FA3 performance and recommends NVIDIA PyTorch containers for installing FlashAttention. Our current image is a CUDA devel image, not an NVIDIA PyTorch image.
- FA2 may not be the right target for Blackwell. `flash-attn-4` explicitly targets Hopper and Blackwell, has Python 3.12 classifiers, and publishes `4.0.0b16` as of 2026-06-03, but it is beta/alpha-status and has a different import path: `from flash_attn.cute import flash_attn_func`.
- Unsloth may not automatically use `flash-attn-4`; its warning specifically checks FA2. A successful FA4 import would not by itself prove Unsloth training uses FA4.
- The current Temporal IR training sequences are short compared with the long-context workloads where FlashAttention matters most, so expected benefit may be modest unless attention is the measured bottleneck.

## Recommendation

- Keep the current `xformers` training path for Qwen3.5 0.8B experiments unless measured kernel work becomes the bottleneck.
- If future iteration speed becomes the bottleneck, create a separate Docker experiment tag for `flash-attn-4`, not an in-place FA2 fix.
- Only promote a kernel change if it proves all three of: imports cleanly, Unsloth/HF actually uses it during training, and a bounded training run improves wall-clock time without correctness regressions.
