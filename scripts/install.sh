#!/usr/bin/env bash
# Paseo install script (Linux / macOS)
#
# Usage:
#   curl -fsSL https://github.com/kevenhu001-cyber/paseo/releases/latest/download/install.sh | bash
#
# Environment overrides:
#   PASEO_REPO            GitHub repository to install from (default: kevenhu001-cyber/paseo)
#   PASEO_INSTALL_METHOD  Linux method: "appimage" (default) or "package" (deb/rpm)
#
# The Linux default installs the AppImage into ~/.local/bin without root and
# symlinks ~/.local/bin/paseo so the CLI also works. Set
# PASEO_INSTALL_METHOD=package to install the distro package instead.
set -euo pipefail

REPO="${PASEO_REPO:-kevenhu001-cyber/paseo}"
API="https://api.github.com/repos/${REPO}/releases/latest"
BASE="https://github.com/${REPO}/releases/latest/download"

fetch() {
  curl -fsSL --retry 3 --connect-timeout 10 "$@"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "error: root privileges are required but sudo was not found" >&2
    return 1
  fi
}

echo "Resolving the latest Paseo release..."
tag="$(fetch "$API" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$tag" ]; then
  echo "error: could not resolve the latest Paseo release from ${API}" >&2
  exit 1
fi
version="${tag#v}"

os="$(uname -s)"
machine="$(uname -m)"

case "$os" in
  Linux)
    case "$machine" in
      x86_64 | amd64)
        linux_arch="x86_64"
        deb_arch="amd64"
        ;;
      *)
        echo "error: Paseo does not publish a Linux build for ${machine} yet" >&2
        exit 1
        ;;
    esac
    ;;
  Darwin)
    case "$machine" in
      x86_64) mac_arch="x64" ;;
      arm64) mac_arch="arm64" ;;
      *)
        echo "error: unsupported macOS architecture: ${machine}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "error: unsupported operating system: ${os}" >&2
    exit 1
    ;;
esac

install_linux_package() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  if command -v apt-get >/dev/null 2>&1; then
    local deb="${tmp}/paseo.deb"
    echo "Downloading Paseo ${version} (deb)..."
    fetch "${BASE}/Paseo-${version}-${deb_arch}.deb" -o "$deb"
    echo "Installing the deb package..."
    run_as_root apt-get install -y "$deb"
  elif command -v dnf >/dev/null 2>&1; then
    local rpm="${tmp}/paseo.rpm"
    echo "Downloading Paseo ${version} (rpm)..."
    fetch "${BASE}/Paseo-${version}-x86_64.rpm" -o "$rpm"
    echo "Installing the rpm package..."
    run_as_root dnf install -y "$rpm"
  elif command -v yum >/dev/null 2>&1; then
    local rpm="${tmp}/paseo.rpm"
    echo "Downloading Paseo ${version} (rpm)..."
    fetch "${BASE}/Paseo-${version}-x86_64.rpm" -o "$rpm"
    echo "Installing the rpm package..."
    run_as_root yum install -y "$rpm"
  else
    echo "error: no supported package manager found; use the AppImage method" >&2
    return 1
  fi
  echo "Paseo ${version} installed."
}

install_linux_appimage() {
  local bin_dir="${HOME}/.local/bin"
  local app_dir="${HOME}/.local/share/applications"
  local appimage="${bin_dir}/Paseo-${linux_arch}.AppImage"

  mkdir -p "$bin_dir" "$app_dir"
  echo "Downloading Paseo ${version} (AppImage)..."
  fetch "${BASE}/Paseo-${linux_arch}.AppImage" -o "$appimage"
  chmod +x "$appimage"
  ln -sf "$appimage" "${bin_dir}/paseo"

  cat > "${app_dir}/paseo.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Paseo
Comment=Monitor and control your local AI coding agents
Exec=${appimage}
Categories=Development;
Terminal=false
EOF

  echo "Paseo ${version} installed to ${appimage}"
  echo "Run it with: ${appimage}"
  echo "The 'paseo' command is also available when ${bin_dir} is on your PATH."
}

install_macos() {
  local tmp dmg mount_point app install_dir
  tmp="$(mktemp -d)"
  dmg="${tmp}/paseo.dmg"
  mount_point="/Volumes/paseo-install"

  echo "Downloading Paseo ${version} (macOS ${mac_arch})..."
  fetch "${BASE}/Paseo-${version}-${mac_arch}.dmg" -o "$dmg"
  trap 'hdiutil detach "${mount_point}" >/dev/null 2>&1 || true; rm -rf "${tmp}"' EXIT
  echo "Mounting the disk image..."
  hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$dmg" >/dev/null

  app="$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit)"
  if [ -z "$app" ]; then
    echo "error: Paseo.app was not found in the disk image" >&2
    exit 1
  fi

  if [ -w /Applications ]; then
    install_dir="/Applications"
  else
    install_dir="${HOME}/Applications"
    mkdir -p "$install_dir"
  fi

  echo "Installing Paseo.app into ${install_dir}..."
  if [ "$install_dir" = "/Applications" ] && [ "$(id -u)" -ne 0 ]; then
    run_as_root ditto "$app" "${install_dir}/Paseo.app"
  else
    ditto "$app" "${install_dir}/Paseo.app"
  fi
  echo "Paseo ${version} installed to ${install_dir}/Paseo.app"
}

case "$os" in
  Linux)
    method="${PASEO_INSTALL_METHOD:-appimage}"
    case "$method" in
      appimage) install_linux_appimage ;;
      package) install_linux_package ;;
      *)
        echo "error: PASEO_INSTALL_METHOD must be 'appimage' or 'package'" >&2
        exit 1
        ;;
    esac
    ;;
  Darwin)
    install_macos
    ;;
esac
