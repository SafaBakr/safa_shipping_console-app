#!/bin/sh
# Restore a backup:  docker compose exec backup restore.sh /backups/safa_YYYY-MM-DD_HHMM.tar.enc
# Stop the app first (docker compose stop app) and start it again afterwards.
set -eu
[ -f /etc/backup.env ] && . /etc/backup.env
FILE=${1:?Usage: restore.sh <backup file>}; APPDATA=${APPDATA_DIR:-/appdata}; WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
case "$FILE" in
  *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$FILE" -out "$WORK/b.tar" -pass env:BACKUP_PASSPHRASE ;;
  *) cp "$FILE" "$WORK/b.tar" ;;
esac
tar -xf "$WORK/b.tar" -C "$WORK"
cat "$WORK/manifest.txt" 2>/dev/null || true
pg_restore --clean --if-exists --no-owner -d "${PGDATABASE}" "$WORK/database.dump"
echo "[restore] database restored"
if [ -f "$WORK/files.tar.gz" ]; then
  if [ -w "$APPDATA" ]; then tar -xzf "$WORK/files.tar.gz" -C "$APPDATA"; echo "[restore] files restored";
  else cp "$WORK/files.tar.gz" /backups/restored-files.tar.gz; echo "[restore] files extracted to /backups/restored-files.tar.gz (app data volume is read-only here)"; fi
fi
