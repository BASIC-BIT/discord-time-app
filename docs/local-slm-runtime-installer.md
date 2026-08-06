# Local SLM Runtime Installer

HammerOverlay installed builds should not depend on a source checkout for Local SLM startup. The installed-app runtime path is:

1. MSI bundles lightweight runtime files: PowerShell launchers and Python PEFT server files.
2. Settings -> Local SLM Runtime -> `Install Runtime Files` copies those files into app data under `local-slm-runtime`.
3. The model adapter is installed under that app-data runtime root as `ml/temporal-ir/outputs/<adapter-name>`.
4. The serving backend runs through Docker and mounts the app-data runtime root as `/workspace`.
5. The parser sidecar still receives only the local OpenAI-compatible endpoint/model config; Plan-IR execution remains deterministic.

## Current Runtime Identity

- Endpoint: `http://127.0.0.1:8770/v1`
- Model: `qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11`
- Adapter directory: `ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11-lora`
- Docker image: `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8`

The qwen35 CUDA image used locally, `hammer-overlay-temporal-ir-qwen35:cuda12.8`, passed installed-app smoke from the app-data runtime. It is published to GHCR as `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8` with manifest digest `sha256:9b11d41f78cc18ff18d934bb22b3f59902f6b210d0b35fbc62131e653df98e3f`.

Do not use `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601` for this adapter. Installed smoke showed it starts and exposes `/v1/models`, but PEFT logs many missing adapter keys and the model echoes input JSON instead of producing Plan-IR.

## Adapter Package

The adapter output directory is intentionally ignored by git. Build a release package from a machine that has the promoted adapter:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-local-slm-runtime.ps1 \
  -DownloadBaseUrl "https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-presentation-v11"
```

This writes:

- `dist/local-slm-runtime/<adapter-name>.zip`
- `dist/local-slm-runtime/local-slm-runtime-manifest.json`

Upload both files to a dedicated runtime release/tag. Then wire the generated `downloadUrl` and `sha256` into `LOCAL_SLM_ADAPTER_PACKAGE_URL` and `LOCAL_SLM_ADAPTER_PACKAGE_SHA256` in `src-tauri/src/lib.rs`.

Current local package output:

- Release tag: `local-slm-runtime-qwen35-presentation-v11`
- Package URL: `https://github.com/BASIC-BIT/discord-time-app/releases/download/local-slm-runtime-qwen35-presentation-v11/qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11-lora.zip`
- Package size: `145905152` bytes
- SHA-256: `557122cd75dc6708369eec575916790379275812b26fbe1ab63056947b3d7665`
- Local ZIP: `dist/local-slm-runtime/qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11-lora.zip`
- Local manifest: `dist/local-slm-runtime/local-slm-runtime-manifest.json`

The V11 package and manifest were uploaded to the dedicated prerelease and downloaded again on 2026-08-06. The remote package size and SHA-256 matched the manifest exactly. The app constants point at that verified release-asset URL. If the adapter is repackaged, update both the release asset and `LOCAL_SLM_ADAPTER_PACKAGE_SHA256` before installed-app smoke.

## Installed-App Smoke Gate

Do not merge or release runtime-installer changes until an installed MSI build verifies:

- Settings shows the app-data install root after `Install Runtime Files`.
- Runtime files are installed from MSI resources, not from a source checkout.
- `Download Model` installs the adapter under the app-data runtime root and passes SHA-256 verification.
- `Pull Docker Image` succeeds or clearly reports the Docker prerequisite.
- `Start Local SLM` reaches `ready` and `/v1/models` exposes `qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11`.
- A parser smoke through the installed app returns a deterministic result or safe clarification; no wrong singular timestamp.

If any of those fail, keep the PR as draft and do not tag a release.

## Smoke Evidence

2026-08-06 V11 packaging and installed routing-smoke gate:

- Published prerelease `local-slm-runtime-qwen35-presentation-v11`; its re-downloaded ZIP matched the local package at `145905152` bytes and SHA-256 `557122cd75dc6708369eec575916790379275812b26fbe1ab63056947b3d7665`.
- Built the current routing-smoke MSI and verified its installed executable matched the MSI payload exactly. Every installed probe passed, including context-selected presentation, typo recovery, ambiguity clarification, copied prose, ranges, rejection, and active-request cancellation; warmed model-path p95 was `2386ms`.
- Installed the verified V11 runtime files and adapter into the production app-data runtime while retaining V9 as rollback. The canonical installed launcher now serves the exact V11 model identity on `http://127.0.0.1:8770/v1`.
- The existing production desktop executable remains the prior V9 candidate until the signed `0.1.4` MSI replaces it. Do not treat the runtime-only update as proof that the stale desktop sidecar has adopted V11.

2026-08-05 production MSI V9 promotion smoke, version `0.1.4`:

- Published prerelease `local-slm-runtime-qwen35-discord-reference-v9`; remote ZIP size `145866371` bytes and SHA-256 `2d16a7cae1c30c6187a1d608ea30f3d63971b4f5aa3f9649a2ae164f40ed522a` matched the manifest after re-download.
- Built unsigned local-smoke MSI `HammerOverlay_0.1.4_x64_en-US.msi`, size `81158632` bytes, SHA-256 `551c65f1d1f681c4adb3b20248695c1a8d6fd3ec294e139d747e2ca5c89fcd92`.
- A clean install matched the administratively extracted MSI executable payload: `8c733255717e803496f191a20c9fbb268d3058e4068dcccf6cca73b41a487304`.
- Installed runtime resources were copied from `C:\Program Files\HammerOverlay\local-slm-runtime` into app data with exact file-hash parity; the installed launcher exposed V9 on canonical port `8770`.
- The production desktop and bundled sidecar paths were verified from `C:\Program Files\HammerOverlay`; health reported port `8857`, V9 on `http://127.0.0.1:8770/v1`, minimal/chat configuration, and enabled Discord-reference routing.
- Automated installed probes passed standalone extraction, reference arithmetic, clock composition, typo recovery, copied prose, ambiguity clarification, exact range handling, negative-epoch rejection, and active-request cancellation. Warmed model-path p95 was `2794ms`.
- Local SLM settings were persisted in the Tauri store without changing unrelated preferences. After a normal installed-app restart with no process-scoped model overrides, health still selected V9 on `8770`; `1 day later`, `1 day earlier`, and `1 day ebefore` resolved through `agent+plan` in `2286`-`2759ms`, while ambiguous `day at 12` returned the required HTTP 400 clarification.
- Sanitized local evidence: `api/reports/temporal-ml/discord-reference-v9-installed-production-smoke.json`. Manual hotkey overlay confirmation remains the final human gate.

2026-06-15 installed MSI smoke, local-only version `0.1.4`:

- Installed runtime files copied from MSI resources into `C:\Users\steve\AppData\Roaming\com.hammer-overlay.app\local-slm-runtime`.
- Adapter package downloaded from the prerelease asset and extracted under the app-data runtime root.
- `ghcr.io/basic-bit/discord-time-app-temporal-peft:temporal-peft-bnb-runpod-base-20260601` failed model-quality smoke: the container ran, but logged missing adapter keys and returned input JSON for `tom 3pm`.
- Local image `hammer-overlay-temporal-ir-qwen35:cuda12.8` passed installed-runtime smoke and returned valid Plan-IR for `tom 3pm`.
- Published GHCR image `ghcr.io/basic-bit/discord-time-app-temporal-ir-qwen35:cuda12.8` was pushed, pulled by tag, started from the installed app-data runtime, and returned `method: agent+plan` for `tom 3pm`.
- Overlay smoke passed for `tomorrow at 3pm` and `tom 3pm` after correcting the frontend API-client priority; `tom 3pm` was then verified through the published GHCR qwen35 image via the installed parser endpoint.
