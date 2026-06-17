# Local SLM Runtime Installer

HammerOverlay installed builds should not depend on a source checkout for Local SLM startup. The installed-app runtime path is:

1. MSI bundles lightweight runtime files: PowerShell launchers and Python PEFT server files.
2. Settings -> Local SLM Runtime -> `Install Runtime Files` copies those files into app data under `local-slm-runtime`.
3. The model adapter is installed under that app-data runtime root as `ml/temporal-ir/outputs/<adapter-name>`.
4. The serving backend runs through Docker and mounts the app-data runtime root as `/workspace`.
5. The parser sidecar still receives only the local OpenAI-compatible endpoint/model config; Plan-IR execution remains deterministic.

## Current Runtime Identity

- Endpoint: `http://127.0.0.1:8765/v1`
- Model: `qwen-temporal-ir-qwen35-bf16-chat-time-range-2687`
- Adapter directory: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora`
- Docker image: `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8`

The qwen35 CUDA image used locally, `hammer-overlay-temporal-ir-qwen35:cuda12.8`, passed installed-app smoke from the app-data runtime. It is published to GHCR as `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8` with manifest digest `sha256:9b11d41f78cc18ff18d934bb22b3f59902f6b210d0b35fbc62131e653df98e3f`.

Do not use `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601` for this adapter. Installed smoke showed it starts and exposes `/v1/models`, but PEFT logs many missing adapter keys and the model echoes input JSON instead of producing Plan-IR.

## Adapter Package

The adapter output directory is intentionally ignored by git. Build a release package from a machine that has the promoted adapter:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-local-slm-runtime.ps1 \
  -DownloadBaseUrl "https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-time-range-2687"
```

This writes:

- `dist/local-slm-runtime/<adapter-name>.zip`
- `dist/local-slm-runtime/local-slm-runtime-manifest.json`

Upload both files to a dedicated runtime release/tag. Then wire the generated `downloadUrl` and `sha256` into `LOCAL_SLM_ADAPTER_PACKAGE_URL` and `LOCAL_SLM_ADAPTER_PACKAGE_SHA256` in `src-tauri/src/lib.rs`.

Current local package output:

- Release tag: `local-slm-runtime-qwen35-time-range-2687`
- Package URL: `https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-time-range-2687/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora.zip`
- Package size: `145910104` bytes
- SHA-256: `d933bd524bbf95a4521f243a61cdf3e196fea08133d00fd4a72e0db30160e598`
- Local ZIP: `dist/local-slm-runtime/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora.zip`
- Local manifest: `dist/local-slm-runtime/local-slm-runtime-manifest.json`

The app constants currently point at that release-asset URL. The asset was uploaded as a prerelease asset and verified on 2026-06-15; if the adapter is repackaged, update both the release asset and `LOCAL_SLM_ADAPTER_PACKAGE_SHA256` before installed-app smoke.

## Installed-App Smoke Gate

Do not merge or release runtime-installer changes until an installed MSI build verifies:

- Settings shows the app-data install root after `Install Runtime Files`.
- Runtime files are installed from MSI resources, not from a source checkout.
- `Download Model` installs the adapter under the app-data runtime root and passes SHA-256 verification.
- `Pull Docker Image` succeeds or clearly reports the Docker prerequisite.
- `Start Local SLM` reaches `ready` and `/v1/models` exposes `qwen-temporal-ir-qwen35-bf16-chat-time-range-2687`.
- A parser smoke through the installed app returns a deterministic result or safe clarification; no wrong singular timestamp.

If any of those fail, keep the PR as draft and do not tag a release.

## Smoke Evidence

2026-06-15 installed MSI smoke, local-only version `0.1.4`:

- Installed runtime files copied from MSI resources into `C:\Users\steve\AppData\Roaming\com.hammer-overlay.app\local-slm-runtime`.
- Adapter package downloaded from the prerelease asset and extracted under the app-data runtime root.
- `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601` failed model-quality smoke: the container ran, but logged missing adapter keys and returned input JSON for `tom 3pm`.
- Local image `hammer-overlay-temporal-ir-qwen35:cuda12.8` passed installed-runtime smoke and returned valid Plan-IR for `tom 3pm`.
- Published GHCR image `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8` was pushed, pulled by tag, started from the installed app-data runtime, and returned `method: agent+plan` for `tom 3pm`.
- Overlay smoke passed for `tomorrow at 3pm` and `tom 3pm` after correcting the frontend API-client priority; `tom 3pm` was then verified through the published GHCR qwen35 image via the installed parser endpoint.
