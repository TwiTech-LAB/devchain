#!/usr/bin/env bash
# Isolated provider logins for the provider-auth proof. Each login writes only
# under $ISO/<provider>; the PC's own logins (~/.codex, ~/.gemini, keyring,
# ~/.local/share/opencode, gh config) are never read or written.
#
# Usage: provider-auth-login.sh <claude|codex|agy|opencode|gh|files|clean>
#
# Nothing here prints a token. `files` lists names, modes and sizes only.
# Not part of the build or the test suite.
set -euo pipefail

# Non-hidden and under $HOME so the snap-confined gh can write it.
ISO="${DEVCHAIN_AUTH_PROOF_DIR:-$HOME/devchain-auth-proof}"

umask 077
mkdir -p "$ISO"

case "${1:-}" in
  claude)
    # Stores the existing `claude setup-token` value; input is not echoed.
    mkdir -p "$ISO/claude"
    read -rsp 'Paste CLAUDE_CODE_OAUTH_TOKEN (input hidden): ' token; echo
    printf '%s' "$token" > "$ISO/claude/token"
    echo "saved $(wc -c < "$ISO/claude/token") bytes"
    ;;
  codex)
    mkdir -p "$ISO/codex"
    CODEX_HOME="$ISO/codex" codex login
    CODEX_HOME="$ISO/codex" codex login status
    ;;
  agy)
    # agy ignores GEMINI_CLI_HOME and follows HOME. With a D-Bus session it
    # stores the login in the Secret Service keyring; without one it writes
    # ~/.gemini/antigravity-cli/antigravity-oauth-token instead, which is the
    # file the second host uses. D-Bus falls back to $XDG_RUNTIME_DIR/bus, so
    # the runtime dir must be an empty one too, or agy reads the PC's keyring.
    rm -rf "$ISO/agy"
    mkdir -p "$ISO/agy/home" "$ISO/agy/run"
    env -u DBUS_SESSION_BUS_ADDRESS HOME="$ISO/agy/home" XDG_RUNTIME_DIR="$ISO/agy/run" agy "${@:2}"
    ;;
  opencode)
    # Choose OpenAI -> "ChatGPT Plus/Pro" (an oauth entry).
    mkdir -p "$ISO/opencode"
    XDG_DATA_HOME="$ISO/opencode" opencode auth login
    XDG_DATA_HOME="$ISO/opencode" opencode auth list
    ;;
  gh)
    # --insecure-storage keeps the token in $ISO/gh/hosts.yml, not the keyring.
    mkdir -p "$ISO/gh"
    GH_CONFIG_DIR="$ISO/gh" gh auth login -h github.com -p https -w --insecure-storage
    GH_CONFIG_DIR="$ISO/gh" gh auth status 2>&1 | grep -v -i 'token:'
    ;;
  files)
    find "$ISO" -path "$ISO/*/node_modules" -prune -o -type f -printf '%P %m %s\n' | sort
    ;;
  clean)
    rm -rf "$ISO"
    echo "removed $ISO"
    ;;
  *)
    sed -n '2,9p' "$0"
    exit 2
    ;;
esac
