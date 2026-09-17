#!/usr/bin/env bash
#
# start.sh — one command to boot the TDM Shooter and print the URL you share.
#
#   ./start.sh              # LAN mode  — share the http://<your-ip>:PORT link
#                           #             with colleagues on the SAME Wi-Fi/LAN
#   ./start.sh --public     # +tunnel   — also open an internet URL anyone can
#                           #             open (use when you're NOT on one LAN,
#                           #             or corporate Wi-Fi blocks device-to-device)
#   PORT=4000 ./start.sh    # override the port (default 3000)
#
# server.js is ONE process: it serves the web client AND the Colyseus game
# server on the same port, so there's only one thing to start and one URL to
# share. This wrapper just installs deps on first run and makes the shareable
# URL the first thing you see.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Args / config
# ---------------------------------------------------------------------------
PORT="${PORT:-3000}"
MODE="lan"   # lan | public

for arg in "$@"; do
  case "$arg" in
    --public|--tunnel|--share) MODE="public" ;;
    --lan)                     MODE="lan" ;;
    --port=*)                  PORT="${arg#*=}" ;;
    -h|--help)
      # Print only the top usage block (skip shebang, stop at first non-# line).
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg  (try --help)" >&2; exit 2 ;;
  esac
done
export PORT

# Run from the repo root regardless of where the script was invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Preflight: Node, then dependencies (only on first run).
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node >= 18 first: https://nodejs.org" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (npm install)…"
  npm install
fi

# ---------------------------------------------------------------------------
# Detect this machine's LAN IPv4 (the address colleagues on your Wi-Fi use).
# ---------------------------------------------------------------------------
lan_ip() {
  local ip=""
  # macOS: ask the common Wi-Fi/Ethernet interfaces directly.
  for i in en0 en1 en2 en3; do
    ip="$(ipconfig getifaddr "$i" 2>/dev/null || true)"
    [ -n "$ip" ] && { echo "$ip"; return; }
  done
  # Fallback: first non-loopback IPv4 from ifconfig.
  ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2; exit }'
}
IP="$(lan_ip || true)"

# ---------------------------------------------------------------------------
# Port preflight. If a TDM server is already answering here, don't fight it —
# just surface the URL (that's what you came for). If some OTHER process holds
# the port, say so cleanly instead of letting node dump an EADDRINUSE trace.
# ---------------------------------------------------------------------------
ALREADY_RUNNING=0
if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  ALREADY_RUNNING=1
elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}')"
  echo "Port $PORT is already in use by ${holder:-another process}, and it isn't the TDM server." >&2
  echo "Stop that process, or start on another port:  PORT=4000 ./start.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Optional public tunnel (only in --public mode). Runs alongside the server
# and is torn down on exit. Prefers cloudflared (WebSocket-friendly, no
# interstitial, no login for quick tunnels), then ngrok, then localtunnel
# via npx (zero install, but shows a one-time visitor gate).
# ---------------------------------------------------------------------------
TUNNEL_PID=""
TUNNEL_LOG=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

await_url() {  # $1 = logfile, $2 = URL regex
  local log="$1" re="$2" url="" i=0
  printf "  waiting for public URL"
  while [ "$i" -lt 40 ]; do          # ~20s
    url="$(grep -Eo "$re" "$log" 2>/dev/null | head -n1 || true)"
    [ -n "$url" ] && break
    printf "."; sleep 0.5; i=$((i + 1))
  done
  echo
  PUBLIC_URL="$url"
}

PUBLIC_URL=""
start_tunnel() {
  TUNNEL_LOG="$(mktemp -t tdm-tunnel 2>/dev/null || echo /tmp/tdm-tunnel.log)"
  if command -v cloudflared >/dev/null 2>&1; then
    echo "  opening public tunnel via cloudflared…"
    cloudflared tunnel --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    await_url "$TUNNEL_LOG" 'https://[A-Za-z0-9.-]*trycloudflare\.com'
  elif command -v ngrok >/dev/null 2>&1; then
    echo "  opening public tunnel via ngrok…"
    ngrok http "$PORT" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    local i=0
    while [ "$i" -lt 40 ]; do
      PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | grep -Eo 'https://[A-Za-z0-9.-]*ngrok[^"]*' | head -n1 || true)"
      [ -n "$PUBLIC_URL" ] && break
      sleep 0.5; i=$((i + 1))
    done
  else
    echo "  cloudflared/ngrok not installed — using localtunnel via npx (no install)."
    echo "  tip: 'brew install cloudflared' gives a smoother link with no visitor gate."
    npx --yes localtunnel --port "$PORT" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    await_url "$TUNNEL_LOG" 'https://[A-Za-z0-9.-]*\.loca\.lt'
  fi
}

[ "$MODE" = "public" ] && start_tunnel

# ---------------------------------------------------------------------------
# Banner: show the shareable URL(s) BEFORE the server's own boot log scrolls.
# ---------------------------------------------------------------------------
LINE="=================================================================="
echo
echo "$LINE"
echo "  TDM Shooter — starting on port $PORT"
echo "$LINE"
if [ "$MODE" = "public" ] && [ -n "$PUBLIC_URL" ]; then
  echo "  SHARE THIS (works anywhere):"
  echo
  echo "      >>>  $PUBLIC_URL  <<<"
  echo
elif [ "$MODE" = "public" ]; then
  echo "  (tunnel didn't report a URL yet — check its output below / $TUNNEL_LOG)"
fi
if [ -n "$IP" ]; then
  echo "  Same Wi-Fi / LAN:  http://$IP:$PORT"
else
  echo "  Same Wi-Fi / LAN:  (no LAN IP found — are you on Wi-Fi/Ethernet?)"
fi
echo "  This machine:      http://localhost:$PORT"
echo "$LINE"
echo "  Stop with Ctrl-C."
echo
if [ "$MODE" = "lan" ]; then
  echo "  Colleagues can't reach the LAN link? Re-run:  ./start.sh --public"
  echo
fi

# ---------------------------------------------------------------------------
# Start (or reuse) the server in the foreground. Ctrl-C stops it; the trap
# kills the tunnel. (No 'exec' — we want the trap to run on the way out.)
# ---------------------------------------------------------------------------
if [ "$ALREADY_RUNNING" = "1" ]; then
  echo "  A TDM server is ALREADY running on port $PORT — reusing it (not starting a second)."
  if [ "$MODE" = "public" ] && [ -n "$TUNNEL_PID" ]; then
    echo "  Public tunnel is live; press Ctrl-C to close it."
    wait "$TUNNEL_PID"
  fi
  exit 0
fi

# node runs in the FOREGROUND on purpose: a terminal Ctrl-C signals the whole
# process group, so node gets SIGINT directly and Colyseus shuts down
# gracefully — the same contract as running `node server.js` by hand. The
# EXIT trap above then tears down the background tunnel (if any) on the way out.
node server.js
