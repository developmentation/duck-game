#!/usr/bin/env bash
# Commit and push whatever the agents have produced, every few minutes.
#
# This container has twice rebooted and rolled the repository back to an earlier
# snapshot, destroying hours of work. Intermediate commits are noisy, and that is
# a far smaller cost than losing a wave. Squash later if it matters.
set -uo pipefail
cd "$(dirname "$0")/.."
INTERVAL="${1:-300}"
while true; do
  sleep "$INTERVAL"
  if [ -n "$(git status --porcelain)" ]; then
    git add -A >/dev/null 2>&1
    git commit -q -m "autosave: work in progress $(date -u +%H:%M)" >/dev/null 2>&1 \
      && ./tools/push.sh >/dev/null 2>&1 \
      && echo "$(date -u +%H:%M) pushed" >> /tmp/duck-autosave.log \
      || echo "$(date -u +%H:%M) autosave failed" >> /tmp/duck-autosave.log
  fi
done
