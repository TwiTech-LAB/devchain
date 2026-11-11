#!/usr/bin/env bash
# run() and the cleanup trap are called indirectly.
# shellcheck disable=SC2317,SC2016,SC2001
# Live proof for CLI secret delivery: the shell tool of each provider CLI (a child of the
# provider process) must (1) see values from the launch env and (2) reach a 127.0.0.1 HTTP
# server, as the local app listens on loopback. Each row checks both, and reports each one
# separately. It uses the flags of DevChain's shipped profiles. One model turn per row.
#
# Usage: vault-canary.sh [ROW ...]   (default: all rows)
#   ROW: claude codex codex-sandbox opencode copilot agy devin
#   codex-sandbox is Codex without --dangerously-bypass-approvals-and-sandbox.
# Needs each CLI logged in, plus python3 and curl. OPENCODE_MODEL and DEVIN_MODEL pick a model.
set -u

ALL_ROWS=(claude codex codex-sandbox opencode copilot agy devin)
rows=("$@")
[ "${#rows[@]}" -eq 0 ] && rows=("${ALL_ROWS[@]}")

export VAULT_CANARY_API_KEY="canary-key-$RANDOM$RANDOM"
export VAULT_CANARY_PLAIN="canary-plain-$RANDOM$RANDOM"
# Only the server knows this token. The model cannot produce it without a real request.
LOOPBACK_TOKEN="canary-http-$RANDOM$RANDOM"

SERVER_DIR="$(mktemp -d)"
WORK="$(mktemp -d)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  rm -rf "$WORK" "$SERVER_DIR"
}
trap cleanup EXIT

# The server is outside the agent's working directory, so the agent cannot read the token.
cat >"$SERVER_DIR/server.py" <<'PY'
import http.server, sys
token, port_file = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (token + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
with open(port_file, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PY
env -u VAULT_CANARY_API_KEY -u VAULT_CANARY_PLAIN \
  python3 -I "$SERVER_DIR/server.py" "$LOOPBACK_TOKEN" "$SERVER_DIR/port" &
server_pid=$!
for _ in $(seq 50); do [ -s "$SERVER_DIR/port" ] && break; sleep 0.1; done
PORT="$(cat "$SERVER_DIR/port" 2>/dev/null)"
if [ -z "$PORT" ] || ! curl -sf -m 5 "http://127.0.0.1:$PORT/canary" | grep -q "$LOOPBACK_TOKEN"; then
  echo "loopback server did not start" >&2
  exit 2
fi

# A name with KEY checks filters on secret-looking names (Codex shell_environment_policy).
# The probe writes its findings to a file, so a model that refuses to print the values
# or invents output does not change the result.
cat >"$WORK/probe.sh" <<SH
#!/bin/sh
{
  printenv VAULT_CANARY_API_KEY || echo MISSING_KEY
  printenv VAULT_CANARY_PLAIN || echo MISSING_PLAIN
  curl -sS -m 10 http://127.0.0.1:$PORT/canary || echo LOOPBACK_FAILED
} >probe.out 2>&1
echo probe finished
SH
export PROMPT='Use your shell tool to run exactly: sh ./probe.sh. Then reply with its output only.'

run() {
  case "$1" in
    claude) claude -p --dangerously-skip-permissions "$PROMPT" ;;
    codex) codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$PROMPT" ;;
    # Default sandbox of an interactive launch; workspace-write lets the probe write its file.
    codex-sandbox) codex exec --skip-git-repo-check --sandbox workspace-write "$PROMPT" ;;
    # DevChain launches OpenCode 2 with --standalone, so the tool server inherits the launch env.
    opencode) opencode run --standalone --auto ${OPENCODE_MODEL:+-m "$OPENCODE_MODEL"} "$PROMPT" ;;
    copilot) copilot -p "$PROMPT" --yolo ;;
    agy) agy --dangerously-skip-permissions -p="$PROMPT" ;;
    devin) devin -p --permission-mode dangerous --respect-workspace-trust false \
      ${DEVIN_MODEL:+--model "$DEVIN_MODEL"} -- "$PROMPT" ;;
    *) echo "unknown row $1" >&2; return 2 ;;
  esac
}
export -f run

cd "$WORK" || exit 1
status=0
for row in "${rows[@]}"; do
  cli="${row%%-*}"
  if ! command -v "$cli" >/dev/null; then
    echo "SKIP $row: $cli not installed"
    status=1
    continue
  fi
  version="$("$cli" --version 2>&1 | head -1)"
  rm -f probe.out
  output="$(timeout 300 bash -c 'run "$0"' "$row" </dev/null 2>&1)"
  code=$?
  probe="$(cat probe.out 2>/dev/null || echo "probe.out missing: the shell tool did not run the probe")"
  env_result=FAIL
  grep -qx "$VAULT_CANARY_API_KEY" <<<"$probe" && grep -qx "$VAULT_CANARY_PLAIN" <<<"$probe" && env_result=PASS
  net_result=FAIL
  grep -qx "$LOOPBACK_TOKEN" <<<"$probe" && net_result=PASS
  echo "$row ($version): env=$env_result loopback=$net_result exit=$code"
  if [ "$env_result" != PASS ] || [ "$net_result" != PASS ]; then
    status=1
    sed 's/^/    probe: /' <<<"$probe"
    tail -10 <<<"$output" | sed 's/^/    cli: /'
  fi
done
exit "$status"
