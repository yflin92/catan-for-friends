#!/usr/bin/env bash
# Deploys one git SHA to this host (design §5.8, §11; D12; X-deploy). Run from the repository checkout on the host:
#
#   deploy/deploy.sh [--force] [--dry-run] [<git sha>]        (default: the checkout's HEAD)
#
# --dry-run runs the preflight (1) and the guard's /healthz read (2) for real, prints the steps it would take, and
# changes nothing: no deploy-forced marker, no build, no compose up, no prune, no sync. It exits as the real deploy
# would at the guard: 2 when it would refuse, else 0.
#
# 1. Preflight: deploy/.env exists; HEXLANDS_SITE_ADDRESS is set; in prod, the room-creation passphrase decision
#    (D13/Q9) has been made: either HEXLANDS_ROOMS_CREATE_PASSPHRASE is set, or HEXLANDS_ALLOW_OPEN_CREATION=yes; and
#    Grafana Cloud is configured (endpoints, instance ids, token), or HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes.
# 2. Guard: while /healthz reports games.active > 0 the deploy refuses (exit 2), unless --force
#    (ops.deployGuardWhileGamesActive, A37). --force writes /data/deploy-forced, so the server logs deploy.forced when
#    it receives SIGTERM.
# 3. Build the image with that SHA as HEXLANDS_BUILD_VERSION (the ONE version, D12) and recreate the stack. Compose
#    stops the old container with SIGTERM and a 30 s grace, so the server drains (ADR-0005).
# 4. Smoke (D12): through the public address, /healthz version must equal /version.txt and the SHA. A mismatch or a
#    missing value fails the deploy (exit 3).
# 5. docker image prune -f (G6).
# 6. Observability as code (X-alerts): pushes alert rules, dashboard, game-night interval and the Synthetic Monitoring
#    check to Grafana when GRAFANA_URL and GRAFANA_SA_TOKEN are set.
# Secrets (passphrase, Grafana token) stay in deploy/.env and are never printed.
# HEXLANDS_DEPLOY_COMPOSE_OVERLAYS (local validation only, never on a host): extra compose files, relative to deploy/,
# applied on top of docker-compose.yml, e.g. the local Loki of deploy/validate/rehearse.sh.
set -euo pipefail

cd "$(dirname "$0")"
FORCE=0
DRY_RUN=0
SHA=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) SHA="$arg" ;;
  esac
done
SHA="${SHA:-$(git rev-parse --short=12 HEAD)}"

log() { printf '[deploy] %s\n' "$*"; }
# In a dry run, a step that would change something is printed instead of run.
would() { log "dry-run: would $*"; }
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
# Telemetry (Grafana Cloud) is required in prod: without it there are no alerts and no dashboards. A value still holding
# the .env.example placeholder (<...>) counts as unset.
set_value() { local v; v="$(env_value "$1")"; [ -n "$v" ] && [ "${v#<}" = "$v" ]; }
if [ "$ENVIRONMENT" = prod ]; then
  MISSING=""
  for k in GRAFANA_MIMIR_URL GRAFANA_MIMIR_USER GRAFANA_LOKI_URL GRAFANA_LOKI_USER GRAFANA_TEMPO_ENDPOINT GRAFANA_TEMPO_USER GRAFANA_CLOUD_TOKEN; do
    set_value "$k" || MISSING="$MISSING $k"
  done
  if [ -n "$MISSING" ]; then
    [ "$(env_value HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY)" = yes ] \
      || fail "Grafana Cloud is not configured:$MISSING (see deploy/README.md, Grafana Cloud; or HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes)"
    log "WARN: Grafana Cloud is not configured; no alerts or dashboards (accepted via HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY)"
  fi
fi
case "$SITE" in http://*|https://*) BASE="$SITE" ;; *) BASE="https://$SITE" ;; esac
CURL=(curl -fsS --max-time 10)
[ "${HEXLANDS_DEPLOY_INSECURE_TLS:-0}" = 1 ] && CURL+=(-k)

COMPOSE_FILES=(-f docker-compose.yml)
for overlay in ${HEXLANDS_DEPLOY_COMPOSE_OVERLAYS:-}; do COMPOSE_FILES+=(-f "$overlay"); done
compose() { HEXLANDS_BUILD_VERSION="$SHA" docker compose --env-file .env "${COMPOSE_FILES[@]}" "$@"; }

# Reads a field of the running server's /healthz from inside its container (no dependency on DNS or TLS).
healthz_field() {
  compose exec -T catan-server node -e "
    fetch('http://127.0.0.1:' + (process.env.HEXLANDS_PORT ?? '8080') + '/healthz')
      .then((r) => r.json()).then((h) => console.log($1)).catch(() => process.exit(1));" 2>/dev/null
}

# ── 2. guard ─────────────────────────────────────────────────────────────────
if [ -n "$(compose ps -q catan-server 2>/dev/null)" ]; then
  ACTIVE="$(healthz_field 'h.games.active' || echo unknown)"
  log "guard: games active = $ACTIVE"
  if [ "$ACTIVE" != 0 ]; then
    if [ "$FORCE" = 1 ]; then
      if [ "$DRY_RUN" = 1 ]; then
        would "write /data/deploy-forced (--force with games active)"
      else
        log "games active: $ACTIVE; --force given: writing /data/deploy-forced"
        compose exec -T catan-server node -e "require('node:fs').writeFileSync('/data/deploy-forced', '')"
      fi
    else
      fail "refusing to deploy: games active = $ACTIVE (rerun with --force to deploy anyway)" 2
    fi
  fi
else
  log "guard: no running catan-server; nothing to protect"
fi

if [ "$DRY_RUN" = 1 ]; then
  would "build catan-server:$SHA (HEXLANDS_BUILD_VERSION=$SHA)"
  would "recreate the stack at $SHA (docker compose up -d --remove-orphans; SIGTERM drain, 30 s grace)"
  would "smoke-test $BASE/healthz and $BASE/version.txt against $SHA"
  would "prune dangling images"
  if set_value GRAFANA_URL && set_value GRAFANA_SA_TOKEN; then would "sync alert rules, dashboard and probe to Grafana"; else log "dry-run: observability sync would be skipped (GRAFANA_URL / GRAFANA_SA_TOKEN unset)"; fi
  log "dry-run complete: nothing changed"
  exit 0
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

# ── 6. observability ─────────────────────────────────────────────────────────
# Alert rules, contact point, notification policy, game-night interval, dashboard and the Synthetic Monitoring check
# (deploy/observability/sync.ts), run with the image's Node. A failed sync does not undo the deploy; it is reported.
if set_value GRAFANA_URL && set_value GRAFANA_SA_TOKEN; then
  docker run --rm --env-file .env -v "$PWD/observability:/obs:ro" "catan-server:$SHA" \
    node --experimental-strip-types --no-warnings /obs/sync.ts \
    || log "WARN: observability sync failed; alerts and dashboards may be stale (rerun deploy.sh or see deploy/README.md)"
else
  log "observability sync skipped (GRAFANA_URL / GRAFANA_SA_TOKEN unset)"
fi
log "deployed $SHA"
