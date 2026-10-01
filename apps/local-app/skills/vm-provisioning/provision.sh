#!/usr/bin/env bash
# Provisioning marker for a project on a DevChain remote VM.
#
# Usage: bash provision.sh <check|set>
#   check  prints home, provisioned or "not provisioned"
#   set    marks the project as provisioned on this VM
#
# The marker is ~/.devchain/provisioning/<project id>, outside the project
# folder, because the project folder syncs with home. It holds the claim's
# claimedAt value. A new claim (a reset or a reinstall) writes a new value, so
# an old marker no longer matches. An update keeps the value.
set -u

claim="${DEVCHAIN_HOST_ETC_DIR:-/etc/devchain-host}/claim.json"
[ -e "$claim" ] || { echo home; exit 0; }
[ -n "${DEVCHAIN_PROJECT_ID:-}" ] || { echo "DEVCHAIN_PROJECT_ID is not set"; exit 2; }
marker="$HOME/.devchain/provisioning/$DEVCHAIN_PROJECT_ID"
stamp="$(sed -n 's/^ *"claimedAt": *"\([^"]*\)".*/\1/p' "$claim" | head -n 1)"

case "${1:-}" in
  check)
    if [ -f "$marker" ] && [ "$(cat "$marker")" = "$stamp" ]; then
      echo provisioned
    else
      echo "not provisioned"
      exit 1
    fi
    ;;
  set)
    mkdir -p "${marker%/*}" && printf '%s\n' "$stamp" >"$marker" && echo provisioned
    ;;
  *)
    echo "usage: bash provision.sh <check|set>"
    exit 2
    ;;
esac
