#!/usr/bin/env bash
set -euo pipefail
test "$(uname -s)" = Linux
case "$(uname -m)" in
  x86_64) arch=x64; checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  aarch64|arm64) arch=arm64; checksum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
archive="gitleaks_8.30.1_linux_${arch}.tar.gz"
curl --fail --silent --show-error --location --retry 3 "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/$archive" -o "$temporary/$archive"
printf '%s  %s\n' "$checksum" "$temporary/$archive" | sha256sum --check --status
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks
install -d "$HOME/.local/bin"
install -m 0755 "$temporary/gitleaks" "$HOME/.local/bin/gitleaks"
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"; fi
"$HOME/.local/bin/gitleaks" version
