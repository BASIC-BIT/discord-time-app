# Self-contained serving image for the V22 Temporal Plan-IR adapter (RunPod Serverless load balancing).
# No auth token is set: the RunPod gateway authenticates requests.
#
#   docker build -f docker/temporal-ir-qwen35-hosted.Dockerfile -t ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35-hosted:v22 .
#   docker run --rm --gpus all -p 127.0.0.1:8772:8770 ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35-hosted:v22
#   curl http://127.0.0.1:8772/ping
ARG BASE_IMAGE=ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8
FROM ${BASE_IMAGE}
ARG ADAPTER_PACKAGE_URL=https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-range-format-infix-v22/qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22-lora.zip
ARG ADAPTER_PACKAGE_SHA256=fcd12698c93736cfa1a62ec49e93e1c50919a45c42548beb8322f51a1d3a84ce
ARG BASE_MODEL=Qwen/Qwen3.5-0.8B

WORKDIR /workspace

COPY ml/temporal-ir/*.py /workspace/ml/temporal-ir/

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/adapter.zip "${ADAPTER_PACKAGE_URL}" \
    && echo "${ADAPTER_PACKAGE_SHA256}  /tmp/adapter.zip" | sha256sum -c - \
    && unzip -q -o /tmp/adapter.zip -d /workspace \
    && rm /tmp/adapter.zip \
    && test -f /workspace/ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22-lora/adapter_config.json

RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('${BASE_MODEL}')"

RUN mkdir -p /workspace/triton-cache

# Compiled flash-linear-attention Triton kernels land here; TEMPORAL_IR_PREWARM compiles them before /ping goes healthy.
# On RunPod, set TRITON_CACHE_DIR=/runpod-volume/triton-cache in the endpoint env (network volume) so the
# compiled kernels persist across workers of the same GPU type.
ENV TRITON_CACHE_DIR=/workspace/triton-cache

ENV PORT=8770 \
    PORT_HEALTH=8770 \
    TEMPORAL_IR_SERVER_HOST=0.0.0.0 \
    TEMPORAL_IR_SERVER_PORT=8770 \
    TEMPORAL_IR_SERVED_MODEL_NAME=qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22 \
    TEMPORAL_IR_BASE_MODEL=Qwen/Qwen3.5-0.8B \
    TEMPORAL_IR_ADAPTER_DIR=/workspace/ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-range-format-infix-v22-lora \
    TEMPORAL_IR_PROMPT_FORMAT=chat \
    TEMPORAL_IR_MAX_NEW_TOKENS=512 \
    TEMPORAL_IR_PREWARM=1 \
    HF_HUB_OFFLINE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8770

CMD ["python", "/workspace/ml/temporal-ir/serve_peft_openai.py", "--no-load-in-4bit"]
