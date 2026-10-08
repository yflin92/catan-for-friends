#!/usr/bin/env bash
# Game-night pre-flight (deploy/README.md, "Game night" → "Pre-flight (day of)"): the six day-of checks as one read-only
# command, printing PASS / WARN / FAIL / UNKNOWN per check and exiting 1 on any FAIL (2 on a usage error).
#
#   deploy/gamenight-preflight.sh --sha <deployed sha> [--repo owner/name] [--base https://<host>]
#                                 [--env deploy/.env] [--backups deploy/backups]
#
# Host prerequisites: Docker, and optionally gh. The checks run in a container (tooling/gamenight-preflight.ts):
# - image: catan-server:<sha> (the deployed build, Node 22) when present, else the pinned NODE_IMAGE below;
# - mounts, all read-only: the repo at /repo, the env file, the backups directory (when it exists), and the gh answer;
#   no Docker socket, no --privileged, no secret on the command line (the env file is read inside the container);
# - TZ: the host's zone, passed by name with `-e TZ`, so "today" in the backup check is the host's day.
# Check 5 (branch protection) needs gh, which neither image has: gh runs here on the host, read-only
# (`gh api repos/<repo>/branches/main/protection`), and its answer goes into a temporary directory mounted read-only
# into the container and removed afterwards. Without gh, check 5 reports UNKNOWN.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Same base as deploy/Dockerfile.
NODE_IMAGE="node:22-bookworm-slim"

usage() {
  echo "usage: deploy/gamenight-preflight.sh --sha <deployed sha> [--repo owner/name] [--base https://<host>] [--env deploy/.env] [--backups deploy/backups]" >&2
  exit 2
}

SHA="" REPO="" ENV_FILE="deploy/.env" BACKUPS="deploy/backups" BASE="" NOW=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --sha) SHA="$2" ;;
    --repo) REPO="$2" ;;
    --env) ENV_FILE="$2" ;;
    --backups) BACKUPS="$2" ;;
    --base) BASE="$2" ;;
    --now) NOW="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$SHA" ] || usage
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$ROOT" "$1" ;; esac; }
ENV_FILE="$(abs "$ENV_FILE")"
BACKUPS="$(abs "$BACKUPS")"
[ -f "$ENV_FILE" ] || { echo "gamenight-preflight: env file $ENV_FILE not found" >&2; exit 2; }

# Check 5 on the host.
GH_DIR="$(mktemp -d)"
trap 'rm -rf "$GH_DIR"' EXIT
if ! command -v gh >/dev/null 2>&1; then
  echo missing > "$GH_DIR/code"
else
  [ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  if [ -z "$REPO" ]; then
    echo norepo > "$GH_DIR/code"
  else
    set +e
    gh api "repos/$REPO/branches/main/protection" > "$GH_DIR/stdout" 2> "$GH_DIR/stderr"
    echo $? > "$GH_DIR/code"
    set -e
  fi
fi

# The host's time zone by name (TZ, else /etc/timezone, else the /etc/localtime link).
if [ -z "${TZ:-}" ]; then
  if [ -r /etc/timezone ]; then TZ="$(head -n 1 /etc/timezone)"
  else TZ="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p')"
  fi
fi
export TZ="${TZ:-UTC}"

IMAGE="catan-server:$SHA"
docker image inspect "$IMAGE" >/dev/null 2>&1 || IMAGE="$NODE_IMAGE"
MOUNTS=(-v "$ROOT:/repo:ro" -v "$ENV_FILE:/preflight/env:ro" -v "$GH_DIR:/preflight/gh:ro")
ARGS=(--sha "$SHA" --env /preflight/env --gh-result /preflight/gh)
if [ -d "$BACKUPS" ]; then
  MOUNTS+=(-v "$BACKUPS:/preflight/backups:ro")
  ARGS+=(--backups /preflight/backups)
else
  ARGS+=(--backups /preflight/no-backups)
fi
[ -z "$BASE" ] || ARGS+=(--base "$BASE")
[ -z "$NOW" ] || ARGS+=(--now "$NOW")
RUN=(docker run --rm --user "$(id -u):$(id -g)" -e TZ "${MOUNTS[@]}" -w /repo "$IMAGE"
  node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/gamenight-preflight.ts "${ARGS[@]}")
echo "gamenight-preflight: ${RUN[*]}" >&2
set +e
"${RUN[@]}"
code=$?
set -e
exit "$code"
