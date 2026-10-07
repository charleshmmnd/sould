#!/usr/bin/env bash
# Sould hook proxy — forwards Claude Code hook events to the MCP server's
# internal HTTP API via Unix socket or TCP port.
#
# Usage: hook-proxy.sh <event-name>
# Reads hook payload JSON from stdin, returns hook response JSON on stdout.
# Fails open (returns {}) if the MCP server is unreachable.
#
# Socket discovery (sould 0.3.0+):
#   Each MCP binds $HOME/.sould-${pid}.sock. This script picks the newest
#   such socket whose owning PID is still alive. Falls back to the legacy
#   shared $HOME/.sould.sock path for pre-0.3.0 MCPs still running, and
#   finally to a TCP port file.

set -euo pipefail

HOOK_EVENT="${1:?Missing hook event name}"
INPUT=$(cat)

PORT_FILE="${HOME}/.sould-port"
SOCK_FILE=""

# Prefer per-pid sockets. Iterate newest-first by mtime, pick first whose
# PID is still alive — stale socket files from crashed MCPs are skipped.
for sock in $(ls -1t "${HOME}"/.sould-*.sock 2>/dev/null); do
  [ -S "$sock" ] || continue
  name="${sock##*/}"
  pid="${name#.sould-}"
  pid="${pid%.sock}"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    SOCK_FILE="$sock"
    break
  fi
done

# Legacy fallback: pre-0.3.0 MCPs bind $HOME/.sould.sock directly.
# Kept so upgrades are seamless while some old-binary MCPs are still alive.
if [ -z "$SOCK_FILE" ] && [ -S "${HOME}/.sould.sock" ]; then
  SOCK_FILE="${HOME}/.sould.sock"
fi

if [ -n "$SOCK_FILE" ]; then
  RESPONSE=$(echo "$INPUT" | curl -sf --unix-socket "$SOCK_FILE" \
    -X POST -H "Content-Type: application/json" \
    --max-time 10 \
    -d @- "http://localhost/hook/${HOOK_EVENT}" 2>/dev/null) || RESPONSE='{}'
elif [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
  RESPONSE=$(echo "$INPUT" | curl -sf \
    -X POST -H "Content-Type: application/json" \
    --max-time 10 \
    -d @- "http://127.0.0.1:${PORT}/hook/${HOOK_EVENT}" 2>/dev/null) || RESPONSE='{}'
else
  # MCP server not ready yet — pass through
  RESPONSE='{}'
fi

echo "$RESPONSE"
exit 0
