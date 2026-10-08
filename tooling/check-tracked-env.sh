#!/usr/bin/env bash
# Fails when an env file is tracked in git (bug 02babd04): .env, *.env and .env.* hold secrets and stay untracked; only
# *.env.example templates with dummy values may be committed. Runs in the lint job. Usage: check-tracked-env.sh [repo dir]
set -euo pipefail
cd "${1:-.}"
tracked="$(git ls-files | grep -E '(^|/)\.env$|\.env$|(^|/)\.env\.' | grep -vE '\.env\.example$' || true)"
if [ -n "$tracked" ]; then
  echo "tracked env files (move secrets to an untracked .env; commit only *.env.example):" >&2
  echo "$tracked" >&2
  exit 1
fi
echo "no tracked env files"
