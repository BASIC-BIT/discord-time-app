FROM nvidia/cuda:12.8.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/temporal-ir-venv \
    HF_HOME=/cache/huggingface \
    XDG_CACHE_HOME=/cache \
    UV_CACHE_DIR=/cache/uv

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        ninja-build \
        python3.12 \
        python3.12-dev \
        python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh

ENV PATH=/root/.local/bin:/opt/temporal-ir-venv/bin:${PATH} \
    CUDA_HOME=/usr/local/cuda

WORKDIR /workspace

RUN mkdir -p /cache/huggingface /cache/uv

COPY pyproject.toml uv.lock /tmp/temporal-ir-project/

RUN cd /tmp/temporal-ir-project \
    && uv sync --frozen --no-default-groups --group temporal-ir-unsloth --no-install-project --python /usr/bin/python3.12 \
    && uv pip install --python /opt/temporal-ir-venv/bin/python --no-build-isolation \
        causal-conv1d==1.6.2.post1 \
        flash-linear-attention==0.5.0 \
    && rm -rf /tmp/temporal-ir-project

CMD ["bash"]
