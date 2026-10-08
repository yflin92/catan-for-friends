#!/usr/bin/env bash
# Deploys one git SHA to this host (design §5.8, §11; D12; X-deploy). Run from the repository checkout on the host:
#
#   deploy/deploy.sh [--force] [<git sha>]        (default: the checkout's HEAD)
#
# 1. Preflight: deploy/.env exists; HEXLANDS_SITE_ADDRESS is set; in prod, the room-creation passphrase decision
#    (D13/Q9) has been made: either HEXLANDS_ROOMS_CREATE_PASSPHRASE is set, or HEXLANDS_ALLOW_OPEN_CREATION=yes.
# 2. Guard: while /healthz reports games.active > 0 the deploy refuses (exit 2), unless --force
#    (ops.deployGuardWhileGamesActive, A37). --force writes /data/deploy-forced, so the server logs deploy.forced when
#    it receives SIGTERM.
# 3. Build the image with that SHA as HEXLANDS_BUILD_VERSION (the ONE version, D12) and recreate the stack. Compose
#    stops the old container with SIGTERM and a 30 s grace, so the server drains (ADR-0005).
# 4. Smoke (D12): through the public address, /healthz version must equal /version.txt and the SHA. A mismatch or a
#    missing value fails the deploy (exit 3).
# 5. docker image prune -f (G6).
# Secrets (passphrase, Grafana token) stay in deploy/.env and are never printed.
set -euo pipefail

cd "$(dirname "$0")"
FORCE=0
SHA=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) SHA="$arg" ;;
  esac
done
SHA="${SHA:-$(git rev-parse --short=12 HEAD)}"

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }

# ── 1. preflight ─────────────────────────────────────────────────────────────
[ -f .env ] || fail "deploy/.env is missing (copy deploy/.env.example and fill it in)"
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
SITE="$(env_value HEXLANDS_SITE_ADDRESS)"
ENVIRONMENT="$(env_value HEXLANDS_ENV)"; ENVIRONMENT="${ENVIRONMENT:-prod}"
[ -n "$SITE" ] || fail "HEXLANDS_SITE_ADDRESS is not set in deploy/.env (the TLS hostname, Q14)"
if [ "$ENVIRONMENT" = prod ] && [ -z "$(env_value HEXLANDS_ROOMS_CREATE_PASSPHRASE)" ]; then
  [ "$(env_value HEXLANDS_ALLOW_OPEN_CREATION)" = yes ] \
    || fail "room creation is open: set HEXLANDS_ROOMS_CREATE_PASSPHRASE, or HEXLANDS_ALLOW_OPEN_CREATION=yes to accept it (D13)"
  log "WARN: rooms.createPassphrase is unset; anyone who reaches $SITE can create rooms (accepted via HEXLANDS_ALLOW_OPEN_CREATION)"
fi
case "$SITE" in http://*|https://*) BASE="$SITE" ;; *) BASE="https://$SITE" ;; esac
CURL=(curl -fsS --max-time 10)
[ "${HEXLANDS_DEPLOY_INSECURE_TLS:-0}" = 1 ] && CURL+=(-k)

compose() { HEXLANDS_BUILD_VERSION="$SHA" docker compose --env-file .env -f docker-compose.yml "$@"; }

# Reads a field of the running server's /healthz from inside its container (no dependency on DNS or TLS).
healthz_field() {
  compose exec -T catan-server node -e "
    fetch('http://127.0.0.1:' + (process.env.HEXLANDS_PORT ?? '8080') + '/healthz')
      .then((r) => r.json()).then((h) => console.log($1)).catch(() => process.exit(1));" 2>/dev/null
}

# ── 2. guard ─────────────────────────────────────────────────────────────────
if [ -n "$(compose ps -q catan-server 2>/dev/null)" ]; then
  ACTIVE="$(healthz_field 'h.games.active' || echo unknown)"
  if [ "$ACTIVE" != 0 ]; then
    if [ "$FORCE" = 1 ]; then
      log "games active: $ACTIVE; --force given: writing /data/deploy-forced"
      compose exec -T catan-server node -e "require('node:fs').writeFileSync('/data/deploy-forced', '')"
    else
      fail "refusing to deploy: games active = $ACTIVE (rerun with --force to deploy anyway)" 2
    fi
  fi
fi

# ── 3. build and roll ────────────────────────────────────────────────────────
log "building catan-server:$SHA"
compose build catan-server
log "starting the stack at $SHA"
compose up -d --remove-orphans

for _ in $(seq 1 60); do
  [ "$(healthz_field 'h.version' || true)" = "$SHA" ] && break
  sleep 2
done

# ── 4. smoke ─────────────────────────────────────────────────────────────────
HEALTH_VERSION="$("${CURL[@]}" "$BASE/healthz" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
BUNDLE_VERSION="$("${CURL[@]}" "$BASE/version.txt" | tr -d '[:space:]' || true)"
[ -n "$HEALTH_VERSION" ] || fail "smoke: /healthz version missing" 3
[ -n "$BUNDLE_VERSION" ] || fail "smoke: /version.txt missing" 3
[ "$HEALTH_VERSION" = "$BUNDLE_VERSION" ] || fail "smoke: /healthz version $HEALTH_VERSION != /version.txt $BUNDLE_VERSION" 3
[ "$HEALTH_VERSION" = "$SHA" ] || fail "smoke: deployed version $HEALTH_VERSION != requested $SHA" 3
log "smoke ok: /healthz version == /version.txt == $SHA"

# ── 5. prune ─────────────────────────────────────────────────────────────────
docker image prune -f >/dev/null
log "deployed $SHA"
