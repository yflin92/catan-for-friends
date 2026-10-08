#!/usr/bin/env bash
# Runs a command with a per-attempt timeout and bounded retries with linear backoff (CI install steps that can hang,
# e.g. Playwright's apt-based system deps).
#   retry.sh <attempts> <timeout-seconds> -- <command...>
# RETRY_FORCE_FAILURES=n makes the first n attempts fail without running the command (to exercise the retry path).
# RETRY_BACKOFF_SECONDS (default 15) is the backoff unit: attempt i waits i × unit before the next one.
set -uo pipefail
attempts="$1"; per_attempt="$2"; shift 2
[ "${1:-}" = "--" ] && shift
forced="${RETRY_FORCE_FAILURES:-0}"
unit="${RETRY_BACKOFF_SECONDS:-15}"
for ((i = 1; i <= attempts; i++)); do
  start=$(date +%s)
  if [ "$i" -le "$forced" ]; then
    echo "::warning::attempt $i/$attempts forced to fail (RETRY_FORCE_FAILURES=$forced)"
    status=1
  else
    timeout --kill-after=10 "$per_attempt" "$@"
    status=$?
  fi
  elapsed=$(( $(date +%s) - start ))
  if [ "$status" -eq 0 ]; then
    echo "succeeded on attempt $i/$attempts in ${elapsed}s"
    exit 0
  fi
  [ "$status" -eq 124 ] && reason="timed out after ${per_attempt}s" || reason="exit $status"
  echo "::warning::attempt $i/$attempts failed ($reason, ${elapsed}s)"
  [ "$i" -lt "$attempts" ] && sleep $(( i * unit ))
done
echo "::error::all $attempts attempts failed: $*"
exit 1
