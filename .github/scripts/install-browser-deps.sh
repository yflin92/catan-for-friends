#!/usr/bin/env bash
# Installs apt packages for CI (Playwright's browser system dependencies) with bounded retries that survive apt locks.
# Run as root, e.g. `sudo -E env "PATH=$PATH" bash .github/scripts/install-browser-deps.sh 2 540 300 -- <command...>`.
#   install-browser-deps.sh <attempts> <attempt-timeout-s> <lock-wait-s> -- <command...>
# - Each attempt runs <command> in its own process group. When it exceeds <attempt-timeout-s>, the whole group is
#   killed (TERM, then KILL after 10 s): the package manager it started (apt-get, dpkg) goes with it, so no orphan keeps
#   a lock.
# - Before every attempt it waits up to <lock-wait-s> for the dpkg frontend, dpkg, apt lists and apt archives locks to
#   be free. Before every retry it also runs `dpkg --configure -a` to finish an install an earlier attempt interrupted.
# - apt itself waits up to <lock-wait-s> for the dpkg lock too (DPkg::Lock::Timeout), as a backstop.
# Exits 0 on the first successful attempt, else 1 after the last one.
set -uo pipefail
attempts="$1"; per_attempt="$2"; lock_wait="$3"; shift 3
[ "${1:-}" = "--" ] && shift
LOCKS=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock)

if [ "$(id -u)" -ne 0 ]; then
  echo "::error::install-browser-deps.sh must run as root (sudo -E env \"PATH=\$PATH\" bash …)"
  exit 2
fi
echo "DPkg::Lock::Timeout \"$lock_wait\";" > /etc/apt/apt.conf.d/90-dpkg-lock-timeout

# Waits until no process holds any apt/dpkg lock file open; returns 1 if one still does after lock_wait seconds.
wait_for_locks() {
  local waited=0
  while fuser "${LOCKS[@]}" >/dev/null 2>&1; do
    if [ "$waited" -ge "$lock_wait" ]; then
      echo "::warning::apt/dpkg locks still held after ${lock_wait}s:"
      fuser -v "${LOCKS[@]}" 2>&1 || true
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  [ "$waited" -gt 0 ] && echo "apt/dpkg locks free after ${waited}s"
  return 0
}

# Runs the command in a new process group; on timeout kills the group. Returns the command's status, or 124.
run_attempt() {
  setsid "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$per_attempt" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      sleep 10
      kill -KILL -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

for ((i = 1; i <= attempts; i++)); do
  start=$(date +%s)
  if [ "$i" -gt 1 ]; then
    wait_for_locks && dpkg --configure -a
  fi
  if wait_for_locks; then
    run_attempt "$@"
    status=$?
  else
    status=1
  fi
  elapsed=$(($(date +%s) - start))
  if [ "$status" -eq 0 ]; then
    echo "succeeded on attempt $i/$attempts in ${elapsed}s"
    exit 0
  fi
  [ "$status" -eq 124 ] && reason="timed out after ${per_attempt}s; process group killed" || reason="exit $status"
  echo "::warning::attempt $i/$attempts failed ($reason, ${elapsed}s)"
done
echo "::error::all $attempts attempts failed: $*"
exit 1
