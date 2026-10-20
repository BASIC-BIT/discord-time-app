#!/usr/bin/env bash
# Native dependencies belong at their distribution paths, never a relocated sysroot.
set -Eeuo pipefail

checkout="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
mode="${1:---check}"
if [[ $# -gt 1 || ( "$mode" != --check && "$mode" != --install ) ]]; then
  echo "Usage: bash scripts/setup-linux-desktop.sh [--check|--install]" >&2
  exit 2
fi

trap 'echo "BLOCKED: setup command failed at line $LINENO; fix provisioning and rerun --check." >&2; exit 2' ERR
export CARGO_HOME="${CARGO_HOME:-$checkout/.cache/linux-desktop/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$checkout/.cache/linux-desktop/rustup}"
export npm_config_cache="${npm_config_cache:-$checkout/.cache/linux-desktop/npm}"
export RUSTUP_TOOLCHAIN=1.99.1
export PATH="$CARGO_HOME/bin:$PATH"
readonly rust_version=1.99.1 driver_version=2.1.0
problems=0

blocked() {
  echo "BLOCKED: $*" >&2
  problems=$((problems + 1))
}

ordinary_path() {
  local resolved
  resolved="$(readlink -f -- "$1")" || return 1
  case "$resolved" in
    /usr/bin/*|/usr/sbin/*|/usr/lib/*|/usr/libexec/*|/usr/local/bin/*|/bin/*|/sbin/*) return 0 ;;
    *) return 1 ;;
  esac
}

system_command() {
  local path
  path="$(command -v -- "$1")" && ordinary_path "$path" && [[ -x "$path" ]]
}

# Ignore pkg-config relocation variables for readiness. Inherited proxy and CA
# variables are deliberately untouched, including during installation.
system_pkg_config() {
  env -u PKG_CONFIG_PATH -u PKG_CONFIG_LIBDIR -u PKG_CONFIG_SYSROOT_DIR \
    pkg-config "$@"
}

writable_directory() {
  local path="$1"
  while [[ ! -e "$path" ]]; do path="$(dirname -- "$path")"; done
  [[ -d "$path" && -w "$path" ]]
}

tauri_driver_ready() {
  local installed
  [[ -x "$CARGO_HOME/bin/tauri-driver" ]] || return 1
  # tauri-driver 2.1.0 has no --version flag. Verify its Cargo installation
  # metadata and run the executable, rather than accepting any binary on PATH.
  installed="$(rustup run "$rust_version" cargo install --list --root "$CARGO_HOME" 2>/dev/null)" || return 1
  [[ $'\n'"$installed"$'\n' == *$'\n'"tauri-driver v$driver_version:"$'\n'* ]] || return 1
  "$CARGO_HOME/bin/tauri-driver" --help >/dev/null 2>&1
}

check_environment() {
  problems=0
  local command package version libdir helper cache
  if [[ "$(uname -s)" != Linux ]]; then
    blocked 'Linux is required; Windows installed-app verification is separate.'
    return 1
  fi
  if [[ -r /etc/os-release ]]; then
    # Distribution-owned metadata, not checkout configuration.
    . /etc/os-release
    echo "Distribution: ${PRETTY_NAME:-unknown}"
  fi
  version="$(node --version 2>/dev/null || true)"
  if [[ "$version" == v24.* ]]; then echo "Node: $version"; else blocked 'Node major 24 is required.'; fi
  if ! command -v npm >/dev/null; then blocked 'npm is required.'; fi
  if python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' 2>/dev/null; then
    python3 --version
  else
    blocked 'Python 3.11+ is required.'
  fi
  for cache in "$CARGO_HOME" "$RUSTUP_HOME" "$npm_config_cache"; do
    writable_directory "$cache" || blocked "Cache directory is not writable: $cache"
  done
  for command in cc make pkg-config WebKitWebDriver Xvfb openbox dbus-run-session \
    xdotool xclip xdpyinfo xwininfo ffmpeg ffprobe; do
    system_command "$command" || blocked "$command must be executable at an ordinary system path."
  done
  if system_command pkg-config; then
    for package in gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0; do
      if version="$(system_pkg_config --modversion "$package" 2>/dev/null)"; then
        libdir="$(system_pkg_config --variable=libdir "$package")"
        if ordinary_path "$libdir" && [[ -d "$libdir" ]]; then
          echo "$package: $version ($libdir)"
        else
          blocked "$package uses an unavailable or relocated library directory."
        fi
      else
        blocked "System pkg-config package missing: $package"
      fi
    done
    libdir="$(system_pkg_config --variable=libdir webkit2gtk-4.1 2>/dev/null || true)"
    for helper in WebKitWebProcess WebKitNetworkProcess; do
      if [[ -n "$libdir" && -x "$libdir/webkit2gtk-4.1/$helper" ]] && ordinary_path "$libdir/webkit2gtk-4.1/$helper"; then
        echo "WebKit helper: $libdir/webkit2gtk-4.1/$helper"
      else
        blocked "$helper is missing at WebKitGTK's compiled system path."
      fi
    done
  fi
  # libxdo has no pkg-config file on Debian/Ubuntu.
  if ! dpkg-query -W -f='${Status}' libxdo-dev 2>/dev/null | rg_status_installed; then
    blocked 'Distribution package libxdo-dev is required.'
  fi
  if command -v rustup >/dev/null && version="$(rustup run "$rust_version" rustc --version 2>/dev/null)" && [[ "$version" == "rustc $rust_version "* ]]; then
    echo "Rust: $version"
    rustup run "$rust_version" cargo --version || blocked "Cargo $rust_version cannot run."
  else
    blocked "Rust toolchain $rust_version is required in RUSTUP_HOME."
  fi
  if tauri_driver_ready; then
    echo "Tauri driver: $driver_version (Cargo metadata; executable verified)"
  else
    blocked "tauri-driver $driver_version is required."
  fi
  if system_command WebKitWebDriver; then
    # WebKitWebDriver also has no --version flag on supported distributions.
    if WebKitWebDriver --help >/dev/null 2>&1 && version="$(dpkg-query -W -f='${Version}' webkit2gtk-driver 2>/dev/null)"; then
      echo "WebKitWebDriver package: $version (executable verified)"
    else
      blocked 'WebKitWebDriver cannot run or its distribution package is missing.'
    fi
  fi
  if system_command ffmpeg; then version="$(ffmpeg -version)"; echo "${version%%$'\n'*}"; fi
  if system_command ffprobe; then version="$(ffprobe -version)"; echo "${version%%$'\n'*}"; fi
  [[ "$problems" -eq 0 ]]
}

rg_status_installed() {
  # Shell matching keeps the dependency check independent of ripgrep/grep.
  local status
  status="$(cat)"
  [[ "$status" == 'install ok installed' ]]
}

install_dependencies() {
  local distro version installer
  local -a elevate=()
  if [[ "$(uname -s)" != Linux || ! -r /etc/os-release ]]; then
    blocked 'Installation supports Debian/Ubuntu Linux only.'
    return 1
  fi
  . /etc/os-release
  distro="${ID:-unknown}"
  if [[ "$distro" != debian && "$distro" != ubuntu ]]; then
    blocked 'Installation supports Debian/Ubuntu apt packages only.'
    return 1
  fi
  version="$(node --version 2>/dev/null || true)"
  if [[ "$version" != v24.* ]]; then
    blocked 'Provision Node major 24 through the supported environment setup first.'
    return 1
  fi
  if [[ "$EUID" -ne 0 ]]; then
    if command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
      elevate=(sudo -n --preserve-env=HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,NO_PROXY,http_proxy,https_proxy,all_proxy,no_proxy,SSL_CERT_FILE,SSL_CERT_DIR,CURL_CA_BUNDLE,REQUESTS_CA_BUNDLE,APT_CONFIG)
    else
      blocked 'System installation requires root or noninteractive sudo in the supported environment. Provision a managed image/container with ordinary system paths; a workspace extraction cannot qualify.'
      return 1
    fi
  fi
  command -v apt-get >/dev/null || { blocked 'apt-get is required.'; return 1; }
  "${elevate[@]}" apt-get update
  "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove --no-upgrade \
    build-essential pkg-config curl ca-certificates python3 \
    libwebkit2gtk-4.1-dev webkit2gtk-driver libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev xvfb openbox dbus-x11 xdotool xclip x11-utils \
    xauth ffmpeg
  mkdir -p -- "$CARGO_HOME" "$RUSTUP_HOME" "$npm_config_cache"
  if ! command -v rustup >/dev/null; then
    installer="$(mktemp "$CARGO_HOME/rustup-init.XXXXXX")"
    # Do not change shell profiles, global toolchains or TLS verification.
    if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      https://sh.rustup.rs --output "$installer"; then
      rm -f -- "$installer"
      return 1
    fi
    if ! bash "$installer" -y --no-modify-path --profile minimal --default-toolchain none; then
      rm -f -- "$installer"
      return 1
    fi
    rm -f -- "$installer"
  fi
  rustup toolchain install "$rust_version" --profile minimal --no-self-update
  if ! tauri_driver_ready; then
    rustup run "$rust_version" cargo install tauri-driver --version "$driver_version" --locked --root "$CARGO_HOME" --force
  fi
}

if [[ "$mode" == --install ]]; then
  if check_environment; then
    echo 'READY: Linux desktop prerequisites already installed.'
    exit 0
  fi
  # Keep this call outside an `if`/`||` condition so errexit also applies
  # inside the function. A failed apt command must stop before later mutations.
  install_dependencies
fi
if check_environment; then
  echo 'READY: Linux desktop prerequisites available. Native application tests are a separate gate.'
  exit 0
fi
echo 'BLOCKED: Linux desktop prerequisites unavailable; run --install in a supported provisioned environment.' >&2
exit 2
