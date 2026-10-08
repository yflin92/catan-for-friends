#!/usr/bin/env bash
# Nightly SQLite backup (ADR-0011): a consistent `VACUUM INTO` copy taken inside the running server container, copied
# to deploy/backups/ on the host (the newest 7 are kept) and, when HEXLANDS_BACKUP_REMOTE is set in deploy/.env,
# uploaded with rclone to that remote (Backblaze B2 / Cloudflare R2 free tier). Run by catan-backup.timer.
# Restore: see deploy/README.md, "Restore a backup".
set -euo pipefail
cd "$(dirname "$0")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="hexlands-$STAMP.db"
compose() { HEXLANDS_BUILD_VERSION="${HEXLANDS_BUILD_VERSION:-unused}" docker compose --env-file .env -f docker-compose.yml "$@"; }

compose exec -T catan-server node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database(process.env.HEXLANDS_DB_PATH, { readonly: true, fileMustExist: true });
  db.exec(\"VACUUM INTO '/data/$NAME'\");
  db.close();"
mkdir -p backups
compose cp "catan-server:/data/$NAME" "backups/$NAME"
compose exec -T catan-server rm -f "/data/$NAME"
ls -1t backups/hexlands-*.db | tail -n +8 | xargs -r rm -f

REMOTE="$(sed -n 's/^HEXLANDS_BACKUP_REMOTE=//p' .env | tail -n 1)"
if [ -n "$REMOTE" ]; then
  rclone copy "backups/$NAME" "$REMOTE"
  echo "[backup] $NAME uploaded"
else
  echo "[backup] $NAME kept locally (no HEXLANDS_BACKUP_REMOTE)"
fi
