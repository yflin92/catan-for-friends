#!/usr/bin/env bash
# Restores a backup taken by deploy/backup.sh (ADR-0011):
#
#   deploy/restore.sh deploy/backups/hexlands-<stamp>.db     (from the repository root)
#   deploy/restore.sh /abs/path/hexlands-<stamp>.db
#
# The file may be given relative to the current directory, as an absolute path, or relative to deploy/
# (e.g. backups/hexlands-<stamp>.db).
#
# Stops catan-server (a normal SIGTERM drain), replaces /data/hexlands.db with the backup (dropping the WAL and SHM
# files of the old database), and starts it again; the server then runs its usual restart recovery (design §5.9).
# To restore from the remote, first `rclone copy <remote>/<file> deploy/backups/`.
set -euo pipefail
FILE="${1:?usage: deploy/restore.sh <backup file>}"
# Resolved before the cd below: a path that exists from the caller's directory becomes absolute; anything else is
# then looked up relative to deploy/.
[ -f "$FILE" ] && FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
cd "$(dirname "$0")"
[ -f "$FILE" ] || { echo "[restore] no such file: $FILE" >&2; exit 1; }
DIR="$(cd "$(dirname "$FILE")" && pwd)"
NAME="$(basename "$FILE")"
# The image of the running deploy: its SHA tags catan-server:<sha>.
SHA="${HEXLANDS_BUILD_VERSION:-$(docker exec catan-catan-server-1 printenv HEXLANDS_BUILD_VERSION)}"
compose() { HEXLANDS_BUILD_VERSION="$SHA" docker compose --env-file .env -f docker-compose.yml "$@"; }

compose stop catan-server
compose run --rm --no-deps -T -v "$DIR:/restore:ro" --entrypoint sh catan-server \
  -c "cp '/restore/$NAME' /data/hexlands.db && rm -f /data/hexlands.db-wal /data/hexlands.db-shm"
compose start catan-server
echo "[restore] restored $NAME"
