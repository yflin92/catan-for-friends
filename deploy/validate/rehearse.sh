#!/usr/bin/env bash
# Local rehearsal of X-deploy's real-host checks (X-deploy-rehearsal; checks numbered as on X-deploy). It runs the
# production compose stack on THIS machine's Docker with the local Loki overlay, plays real games through Caddy, and
# checks:
#   #1  only Caddy publishes host ports;
#   #3  backup.sh, then restore.sh into a fresh volume, gives identical games (lifecycle, seq, head hash);
#   #6  a stop drains within the 30 s grace (exit 0, server.stopped drain_ms), the restart loses nothing;
#   #9  the server's json-file logs rotate, and no secret is in the rotated or current files;
#   #10 X-Forwarded-For through the real Caddy: a spoofed header never changes the limiter key; other clients have their own;
#   #12 a bundle/server version mismatch logs ERROR server.bundle_version_mismatch and keeps serving; a match logs nothing;
#   #11 deploy.sh --force with games active writes deploy-forced, and deploy.forced reaches the local Loki.
# Local only: no real host, no cloud, no spend. Writes evidence to $OUT (default /tmp/hexlands-rehearsal-<stamp>) and
# prints PASS/FAIL per check; never prints a room code, seat token or passphrase.
#
#   deploy/validate/rehearse.sh [--keep]      (--keep leaves the stack running afterwards)
#
# Needs: docker with compose, node + pnpm install (for the game bots), curl. Uses deploy/.env only if it is absent (it
# then writes a placeholder rehearsal .env and removes it at the end); an existing deploy/.env is never touched.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
KEEP=0
[ "${1:-}" = --keep ] && KEEP=1
OUT="${OUT:-/tmp/hexlands-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
chmod 700 "$OUT"
SHA="$(git rev-parse --short=12 HEAD)"
export HEXLANDS_BUILD_VERSION="$SHA"
OVERLAYS="validate/compose.loki.yml validate/compose.rehearsal.yml"
FILES=(-f docker-compose.yml)
for o in $OVERLAYS; do FILES+=(-f "$o"); done
C() { docker compose --env-file .env "${FILES[@]}" "$@"; }
TS() { node --experimental-strip-types --no-warnings --import "$REPO/tooling/ts-resolve-hook.mjs" "$@"; }
log() { printf '[rehearse] %s\n' "$*"; }
declare -A RESULT

pass() { RESULT[$1]=PASS; log "#$1 PASS: $2"; }
fail() { RESULT[$1]=FAIL; log "#$1 FAIL: $2"; }

# ── setup ────────────────────────────────────────────────────────────────────
CREATED_ENV=0
if [ -f .env ]; then
  grep -q '^# Local rehearsal only' .env || { log "deploy/.env exists and is not a rehearsal .env; refusing to touch it"; exit 1; }
else
  cat > .env <<'EOF'
# Local rehearsal only (deploy/validate/rehearse.sh): placeholder values, never a real host.
HEXLANDS_ENV=prod
HEXLANDS_SITE_ADDRESS=http://localhost
HEXLANDS_ALLOW_OPEN_CREATION=yes
HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes
EOF
  CREATED_ENV=1
fi
cleanup() {
  if [ "$KEEP" = 0 ]; then C down -v --remove-orphans >/dev/null 2>&1; fi
  [ "$CREATED_ENV" = 1 ] && [ "$KEEP" = 0 ] && rm -f .env
  log "evidence in $OUT"
}
trap cleanup EXIT

healthz() { curl -fsS --max-time 5 http://localhost/healthz; }
wait_healthy() {
  for _ in $(seq 1 60); do healthz >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
# {id, lifecycle, seq, hash} per game from the live database (read-only, inside the server container; no room codes).
snapshot() {
  C exec -T catan-server node --input-type=module -e "
    import Database from 'better-sqlite3';
    const db = new Database(process.env.HEXLANDS_DB_PATH, { readonly: true, fileMustExist: true });
    const games = db.prepare('SELECT id, lifecycle, head_seq FROM games ORDER BY id').all().map((g) => {
      const ev = db.prepare('SELECT hash_after FROM events WHERE game_id = ? ORDER BY seq DESC LIMIT 1').get(g.id);
      const sn = db.prepare('SELECT state_hash FROM snapshots WHERE game_id = ? ORDER BY seq DESC LIMIT 1').get(g.id);
      return { id: g.id, lifecycle: g.lifecycle, seq: g.head_seq, hash: ev?.hash_after ?? sn?.state_hash ?? null };
    });
    console.log(JSON.stringify(games));"
}
server_logs() { C logs --no-color --no-log-prefix catan-server 2>/dev/null; }

log "building catan-server:$SHA and starting the stack (local Docker only)"
C build catan-server >"$OUT/build.log" 2>&1 || { log "build failed (see $OUT/build.log)"; exit 1; }
C up -d >"$OUT/up.log" 2>&1 && wait_healthy || { log "stack did not come up (see $OUT/up.log)"; exit 1; }
CADDY_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(C ps -q caddy)")"
export REHEARSAL_TRUSTED_PROXIES="[\"$CADDY_IP/32\"]"
C up -d catan-server >>"$OUT/up.log" 2>&1 && wait_healthy || { log "server did not come back with the rehearsal trustedProxies"; exit 1; }

# ── #1 ports ─────────────────────────────────────────────────────────────────
{
  docker ps --filter label=app=catan --format '{{.Names}} {{.Ports}}'
  echo "-- host listening TCP ports:"
  node -e "const f = require('fs'); const ports = new Set();
    for (const t of ['/proc/net/tcp', '/proc/net/tcp6']) for (const l of f.readFileSync(t, 'utf8').split('\n').slice(1)) {
      const c = l.trim().split(/\s+/); if (c[3] === '0A') ports.add(parseInt(c[1].split(':')[1], 16)); }
    console.log([...ports].sort((a, b) => a - b).join(' '));"
  echo
} >"$OUT/1-ports.txt"
PUBLISHED="$(docker ps --filter label=app=catan --format '{{.Names}} {{.Ports}}' | grep -- '->' | awk '{print $1}' | sort -u | tr '\n' ' ')"
if [ "$PUBLISHED" = "catan-caddy-1 " ] && [ -z "$(docker port "$(C ps -q catan-server)")" ] && [ -z "$(docker port "$(C ps -q alloy)")" ]; then
  pass 1 "only caddy publishes host ports ($(docker port "$(C ps -q caddy)" | tr '\n' ' '))"
else
  fail 1 "published by: $PUBLISHED"
fi

# ── games: at least one finished and one active ──────────────────────────────
TS "$REPO/deploy/validate/rehearse-games.ts" --url http://localhost --games 2 --finished 1 --max-minutes 10 \
  --out "$OUT/games.json" --secrets "$OUT/secrets.json" >"$OUT/games.log" 2>&1 || { log "could not finish a game (see $OUT/games.log)"; exit 1; }
log "games: $(cat "$OUT/games.json")"

# ── #3 backup round trip into a fresh volume ─────────────────────────────────
snapshot >"$OUT/3-before.json"
if ./backup.sh >"$OUT/3-backup.log" 2>&1; then
  BACKUP="$(ls -1t backups/hexlands-*.db | head -n 1)"
  C stop catan-server >/dev/null 2>&1
  C rm -f catan-server >/dev/null 2>&1
  docker volume rm catan_catan-data >/dev/null
  C up -d catan-server >/dev/null 2>&1 && wait_healthy
  snapshot >"$OUT/3-fresh.json"
  ./restore.sh "$BACKUP" >"$OUT/3-restore.log" 2>&1 && wait_healthy
  snapshot >"$OUT/3-after.json"
  FINISHED="$(grep -o '"lifecycle":"finished"' "$OUT/3-before.json" | wc -l)"
  ACTIVE="$(grep -o '"lifecycle":"active"' "$OUT/3-before.json" | wc -l)"
  if [ "$(cat "$OUT/3-fresh.json")" = "[]" ] && cmp -s "$OUT/3-before.json" "$OUT/3-after.json" && [ "$FINISHED" -ge 1 ] && [ "$ACTIVE" -ge 1 ]; then
    pass 3 "$(basename "$BACKUP") restored into a fresh volume: $FINISHED finished + $ACTIVE active game(s) identical (lifecycle, seq, head hash)"
  else
    fail 3 "games differ after restore (see $OUT/3-before.json, 3-after.json) or the fresh volume was not empty"
  fi
  rm -f "$BACKUP"
else
  fail 3 "backup.sh failed (see $OUT/3-backup.log)"
fi

# ── #6 drain on stop, restart loses nothing ──────────────────────────────────
snapshot >"$OUT/6-before.json"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0="$(date +%s%N)"
C stop catan-server >/dev/null 2>&1
STOP_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$(C ps -aq catan-server)")"
C logs --no-color --no-log-prefix --since "$SINCE" catan-server >"$OUT/6-stop.log" 2>&1
DRAIN_MS="$(grep -o '"event":"server.stopped"[^}]*' "$OUT/6-stop.log" | grep -o '"drain_ms":[0-9]*' | cut -d: -f2)"
C start catan-server >/dev/null 2>&1 && wait_healthy
snapshot >"$OUT/6-after.json"
STARTED="$(server_logs | grep '"event":"server.started"' | tail -n 1)"
echo "$STARTED" >"$OUT/6-started.json"
GRACE="$(sed -n 's/^ *stop_grace_period: *\([0-9]*\)s.*/\1/p' docker-compose.yml)"
HOST_TIMEOUT="$(sed -n 's/^TimeoutStopSec=\([0-9]*\)s/\1/p' host/docker-stop-timeout.conf)"
if [ "$EXIT_CODE" = 0 ] && [ -n "$DRAIN_MS" ] && [ "$STOP_MS" -lt $((GRACE * 1000)) ] \
  && echo "$STARTED" | grep -q '"previous_shutdown":"clean"' && echo "$STARTED" | grep -q '"lost_on_restart":0' \
  && cmp -s "$OUT/6-before.json" "$OUT/6-after.json" && [ "$HOST_TIMEOUT" -gt "$GRACE" ]; then
  pass 6 "stop took ${STOP_MS} ms (grace ${GRACE} s; host TimeoutStopSec ${HOST_TIMEOUT} s), exit 0, drain_ms ${DRAIN_MS}; clean restart, lost_on_restart 0, games identical"
else
  fail 6 "stop ${STOP_MS} ms, exit ${EXIT_CODE}, drain_ms '${DRAIN_MS}', grace ${GRACE}, host ${HOST_TIMEOUT}; see $OUT/6-*"
fi

# ── #9 rotation, then the secrets scan over rotated and current logs ─────────
LOGPATH="$(docker inspect -f '{{.LogPath}}' "$(C ps -q catan-server)")"
for _ in 1 2 3; do
  [ -n "$(sudo -n sh -c "ls '$LOGPATH'.1 2>/dev/null")" ] && break
  # One game played to the end: more log volume without adding to the active-games cap that #10 relies on.
  TS "$REPO/deploy/validate/rehearse-games.ts" --url http://localhost --games 1 --finished 1 --max-minutes 5 --seed $RANDOM \
    --secrets "$OUT/secrets-more.json" >>"$OUT/games.log" 2>&1 || true
  node -e "const f=require('fs');const a=JSON.parse(f.readFileSync('$OUT/secrets.json'));const b=JSON.parse(f.readFileSync('$OUT/secrets-more.json'));
    f.writeFileSync('$OUT/secrets.json',JSON.stringify({roomCodes:[...a.roomCodes,...b.roomCodes],seatTokens:[...a.seatTokens,...b.seatTokens]}),{mode:0o600})" 2>/dev/null
done
mkdir -p "$OUT/9-logs"
sudo -n sh -c "cp '$LOGPATH'* '$OUT/9-logs/' && chown -R $(id -u) '$OUT/9-logs'"
ROTATED="$(ls "$OUT"/9-logs/*.log.* 2>/dev/null | wc -l)"
if [ "$ROTATED" -ge 1 ] && TS "$REPO/deploy/validate/scan-logs.ts" --secrets "$OUT/secrets.json" "$OUT"/9-logs/* >"$OUT/9-scan.txt" 2>&1; then
  pass 9 "$ROTATED rotated file(s) + current: $(tail -n 1 "$OUT/9-scan.txt")"
else
  fail 9 "rotated files: $ROTATED; scan: $(tail -n 1 "$OUT/9-scan.txt" 2>/dev/null)"
fi
rm -rf "$OUT/9-logs"

# ── #10 X-Forwarded-For behind the real Caddy (D11) ──────────────────────────
C restart catan-server >/dev/null 2>&1 && wait_healthy
LIMIT=6
CODES=""
for i in $(seq 1 $((LIMIT + 1))); do
  CODES="$CODES $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost/api/rooms -H 'Content-Type: application/json' \
    -H "X-Forwarded-For: 203.0.113.$i" -d '{"displayName":"X"}')"
done
OTHER="$(docker run --rm --network catan_default curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' -X POST http://caddy/api/rooms \
  -H 'Host: localhost' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.250' -d '{"displayName":"Y"}')"
echo "host, spoofed XFF per request:$CODES; another client: $OTHER" >"$OUT/10-xff.txt"
if [ "$CODES" = " 201 201 201 201 201 201 429" ] && [ "$OTHER" = 201 ]; then
  pass 10 "6 creates with 6 different spoofed X-Forwarded-For values, the 7th refused 429 (spoof ignored); another client's create: 201 (own key)"
else
  fail 10 "host:$CODES; other client: $OTHER (expected 6×201 then 429; other 201)"
fi

# ── #12 bundle/server version mismatch (D12/D15) ─────────────────────────────
version_check() {
  local name="catan-version-$1" out
  docker run -d --rm --name "$name" -e HEXLANDS_BUILD_VERSION="$2" -e HEXLANDS_TELEMETRY=off -e HEXLANDS_DB_PATH=/tmp/v.db \
    "catan-server:$SHA" >/dev/null
  sleep 4
  out="$(docker exec "$name" node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => console.log(r.status)).catch(() => console.log('down'))")"
  docker logs "$name" >"$OUT/12-$1.log" 2>&1
  docker rm -f "$name" >/dev/null 2>&1
  echo "$out"
}
MISMATCH_HEALTH="$(version_check mismatch "$SHA-other")"
MATCH_HEALTH="$(version_check match "$SHA")"
if grep -q '"event":"server.bundle_version_mismatch"' "$OUT/12-mismatch.log" && grep -q '"severity_text":"ERROR"' "$OUT/12-mismatch.log" \
  && [ "$MISMATCH_HEALTH" = 200 ] && ! grep -q 'bundle_version_m' "$OUT/12-match.log" && [ "$MATCH_HEALTH" = 200 ]; then
  pass 12 "mismatched build logs ERROR server.bundle_version_mismatch and still serves /healthz 200; matched build logs neither mismatch nor missing"
else
  fail 12 "mismatch health $MISMATCH_HEALTH, match health $MATCH_HEALTH; see $OUT/12-*.log"
fi

# ── #11 deploy.sh --force with games active → deploy.forced in the local Loki ─
TS "$REPO/deploy/validate/rehearse-games.ts" --url http://localhost --games 1 --finished 0 --max-minutes 0 >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1
SINCE_NS="$(date +%s%N)"
HEXLANDS_DEPLOY_COMPOSE_OVERLAYS="$OVERLAYS" ./deploy.sh --force "$SHA-r" >"$OUT/11-deploy.log" 2>&1
DEPLOY_EXIT=$?
LOKI_HITS=0
for _ in $(seq 1 30); do
  LOKI_HITS="$(C exec -T catan-server node -e "
    const q = encodeURIComponent('{namespace=\"catan-server\"} |= \`\"event\":\"deploy.forced\"\`');
    fetch('http://loki:3100/loki/api/v1/query_range?query=' + q + '&start=$SINCE_NS&limit=10')
      .then((r) => r.json()).then((j) => console.log(j.data.result.reduce((n, s) => n + s.values.length, 0))).catch(() => console.log(0));" 2>/dev/null)"
  [ "${LOKI_HITS:-0}" -ge 1 ] && break
  sleep 4
done
if [ "$DEPLOY_EXIT" = 0 ] && grep -q 'writing /data/deploy-forced' "$OUT/11-deploy.log" && grep -q 'smoke ok' "$OUT/11-deploy.log" && [ "${LOKI_HITS:-0}" -ge 1 ]; then
  pass 11 "deploy.sh --force wrote the marker with games active, the stack rolled to $SHA-r (smoke ok), and deploy.forced is in the local Loki ($LOKI_HITS line)"
else
  fail 11 "deploy exit $DEPLOY_EXIT, Loki hits ${LOKI_HITS:-0}; see $OUT/11-deploy.log"
fi
docker image rm "catan-server:$SHA-r" >/dev/null 2>&1 || true

# ── summary ──────────────────────────────────────────────────────────────────
STATUS=0
for n in 1 3 6 9 10 12 11; do
  printf '[rehearse] #%-3s %s\n' "$n" "${RESULT[$n]:-FAIL}"
  [ "${RESULT[$n]:-FAIL}" = PASS ] || STATUS=1
done
exit "$STATUS"
