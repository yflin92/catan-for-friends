#!/usr/bin/env bash
# Seeded checks for install-browser-deps.sh (bug 90f8f5b2). Needs root, apt and network; run on a CI runner or a
# disposable machine: `sudo bash .github/scripts/install-browser-deps.test.sh`. The package used is `sl` (reinstalled).
# 1. Held locks: another process holds the dpkg frontend, apt lists and apt archives locks for 20 s. A plain apt-get
#    fails at once (control); the helper waits for the locks and succeeds within its bound.
# 2. Orphan: the first attempt starts a lock holder in its own process group and hangs. The helper times the attempt
#    out, kills the group (holder included), and the second attempt succeeds; no lock holder is left behind.
# 3. Lists lock only: another process holds just the apt lists lock for 20 s, which DPkg::Lock::Timeout does not cover.
#    A plain `apt-get update` fails at once (control); the helper's wait before the attempt lets it succeed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/install-browser-deps.sh"
LOCKS=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock)
INSTALL=(apt-get install -y --reinstall --no-install-recommends sl)
TMP="$(mktemp -d)"
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi; }

# Holds lock files (fcntl, as apt does) for $1 seconds: the given paths, else the dpkg frontend, apt lists and apt
# archives locks.
cat > "$TMP/hold.py" <<'EOF'
import fcntl, sys, time
paths = sys.argv[2:] or ['/var/lib/dpkg/lock-frontend', '/var/lib/apt/lists/lock', '/var/cache/apt/archives/lock']
files = [open(p, 'w') for p in paths]
for f in files:
    fcntl.lockf(f, fcntl.LOCK_EX)
print('holding', flush=True)
time.sleep(int(sys.argv[1]))
EOF

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 2; }
rm -f /etc/apt/apt.conf.d/90-dpkg-lock-timeout

echo "# 1. held locks"
python3 "$TMP/hold.py" 20 & holder=$!
sleep 1
"${INSTALL[@]}" >"$TMP/control.log" 2>&1; control=$?
check "control: plain apt-get fails at once while the locks are held (exit $control)" '[ "$control" -ne 0 ] && grep -q "Could not get lock" "$TMP/control.log"'
start=$(date +%s)
bash "$HELPER" 1 120 60 -- "${INSTALL[@]}" >"$TMP/held.log" 2>&1; status=$?
elapsed=$(($(date +%s) - start))
wait "$holder" 2>/dev/null
check "helper succeeds after the holder releases (exit $status, ${elapsed}s)" '[ "$status" -eq 0 ] && [ "$elapsed" -ge 15 ] && [ "$elapsed" -le 120 ]'

echo "# 2. orphaned lock holder from a timed-out attempt"
cat > "$TMP/attempt.sh" <<EOF
if [ ! -f "$TMP/first-done" ]; then
  touch "$TMP/first-done"
  python3 "$TMP/hold.py" 600 &
  sleep 600
else
  ${INSTALL[*]}
fi
EOF
start=$(date +%s)
bash "$HELPER" 2 15 60 -- bash "$TMP/attempt.sh" >"$TMP/orphan.log" 2>&1; status=$?
elapsed=$(($(date +%s) - start))
check "first attempt timed out and its process group was killed" 'grep -q "attempt 1/2 failed (timed out after 15s; process group killed" "$TMP/orphan.log"'
check "second attempt succeeds (exit $status, ${elapsed}s)" '[ "$status" -eq 0 ] && grep -q "succeeded on attempt 2/2" "$TMP/orphan.log"'
check "bounded: within attempt timeout + kill grace + lock wait + install (${elapsed}s ≤ 180s)" '[ "$elapsed" -le 180 ]'
check "no apt/dpkg lock holder left behind" '! fuser "${LOCKS[@]}" >/dev/null 2>&1'

echo "# 3. apt lists lock only"
echo 'DPkg::Lock::Timeout "60";' > /etc/apt/apt.conf.d/90-dpkg-lock-timeout
python3 "$TMP/hold.py" 20 /var/lib/apt/lists/lock & holder=$!
sleep 1
apt-get update >"$TMP/lists-control.log" 2>&1; control=$?
check "control: plain apt-get update fails at once on the lists lock, DPkg::Lock::Timeout set (exit $control)" '[ "$control" -ne 0 ] && grep -q "Could not get lock /var/lib/apt/lists/lock" "$TMP/lists-control.log"'
start=$(date +%s)
bash "$HELPER" 1 120 60 -- apt-get update >"$TMP/lists.log" 2>&1; status=$?
elapsed=$(($(date +%s) - start))
wait "$holder" 2>/dev/null
check "helper waits for the lists lock, then apt-get update succeeds (exit $status, ${elapsed}s)" '[ "$status" -eq 0 ] && [ "$elapsed" -ge 15 ] && [ "$elapsed" -le 120 ]'

rm -rf "$TMP"
exit "$fail"
