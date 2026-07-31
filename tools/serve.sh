#!/usr/bin/env bash
# Keep the dev server alive for a build wave. The bare vite process gets reaped
# whenever the shell that spawned it goes away, so supervise it.
cd "$(dirname "$0")/.." || exit 1
LOG="${1:-/tmp/duck-vite.log}"
while true; do
  if ! curl -s -o /dev/null --max-time 4 http://127.0.0.1:5173/; then
    echo "[serve] $(date -u +%T) starting vite" >> "$LOG"
    npx vite --host 127.0.0.1 --port 5173 --strictPort >> "$LOG" 2>&1
  fi
  sleep 5
done
