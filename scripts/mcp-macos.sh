#!/usr/bin/env bash
# macos-mcp (https://macos-mcp.com) for kay-os sessions, on a Mac only.
#
# On macOS with the binary installed, run the real server with the `standard`
# profile (destructive actions need a one-shot confirmation; kay-os sessions
# read email, which anyone can write, so not `full`). Anywhere else, serve an
# MCP server with no tools, so a shared .mcp.json doesn't show a failed server
# on Linux or on a Mac without it.
#
# Install on the Mac: curl -fsSL https://macos-mcp.sh | sh   (read it first)
# Override the profile: KAYOS_MACOS_MCP_PROFILE=readonly
set -euo pipefail
bin="${KAYOS_MACOS_MCP_BIN:-/usr/local/bin/macos-mcp}"
if [ "$(uname -s)" = "Darwin" ] && [ -x "$bin" ]; then
  exec "$bin" serve --profile "${KAYOS_MACOS_MCP_PROFILE:-standard}"
fi
exec python3 -c '
import json, sys
for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    if "id" not in req:
        continue  # notifications need no answer
    method = req.get("method")
    if method == "initialize":
        result = {"protocolVersion": req.get("params", {}).get("protocolVersion", "2025-06-18"),
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "macos-mcp (not on this machine)", "version": "0"},
                  "instructions": "macos-mcp only runs on a Mac with it installed; this machine has no macOS tools."}
    elif method == "tools/list":
        result = {"tools": []}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": req["id"],
                          "error": {"code": -32601, "message": "macos-mcp is not available on this machine"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
'
