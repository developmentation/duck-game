#!/usr/bin/env bash
# Push to real GitHub.
#
# The sandbox's global git config rewrites every https://github.com/ URL to a
# local proxy that authenticates as itself and rejects writes with a 403 — so a
# normal `git push` never uses our credentials at all. Ignoring the global config
# for the push is what makes the token count.
#
# The credential file lives outside the repo on purpose: it must never be
# committed or end up in a source archive.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
CREDS="${DUCK_GIT_CREDS:-/tmp/claude-0/-home-user-duck-game/c6e7464c-6b53-5be6-8413-b904798119c1/scratchpad/.git-credentials}"
if [ ! -f "$CREDS" ]; then
  echo "no credential file at $CREDS — push will fail" >&2
  exit 1
fi
GIT_CONFIG_GLOBAL=/dev/null git \
  -c credential.helper="store --file=$CREDS" \
  push -u gh "$BRANCH" "${@:2}" 2>&1 | sed 's#//[^@]*@#//***@#g'
