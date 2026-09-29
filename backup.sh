#!/bin/sh
# Encrypted backup: PostgreSQL dump + uploaded files + secret key, one .tar.enc file per run.
set -eu
[ -f /etc/backup.env ] && . /etc/backup.env
DIR=${BACKUP_DIR:-/backups}; APPDATA=${APPDATA_DIR:-/appdata}; KEEP=${BACKUP_KEEP_DAYS:-14}
STAMP=$(date +%Y-%m-%d_%H%M); NAME="safa_${STAMP}"; WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DIR"
pg_dump -Fc -f "$WORK/database.dump"
if [ -d "$APPDATA" ]; then tar -czf "$WORK/files.tar.gz" -C "$APPDATA" $(cd "$APPDATA" && ls -A | grep -vE '^(backups|mail.log)$' || true); fi
echo "created=$(date -Iseconds) db=$(pg_restore -l "$WORK/database.dump" | grep -c 'TABLE DATA')" > "$WORK/manifest.txt"
tar -cf "$WORK/$NAME.tar" -C "$WORK" database.dump manifest.txt $( [ -f "$WORK/files.tar.gz" ] && echo files.tar.gz )
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$WORK/$NAME.tar" -out "$DIR/$NAME.tar.enc" -pass env:BACKUP_PASSPHRASE
  OUT="$DIR/$NAME.tar.enc"
else
  cp "$WORK/$NAME.tar" "$DIR/$NAME.tar"; OUT="$DIR/$NAME.tar"
fi
echo "[backup] $(date -Iseconds) created $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
find "$DIR" -maxdepth 1 -name 'safa_*.tar*' -mtime +"$KEEP" -print -delete | sed 's/^/[backup] removed old /'
if [ -n "${RCLONE_REMOTE:-}" ] && [ -s /config/rclone.conf ]; then
  if rclone copy "$OUT" "$RCLONE_REMOTE" --config /config/rclone.conf; then echo "[backup] copied off-site to $RCLONE_REMOTE"; else echo "[backup] WARNING: off-site copy failed"; fi
fi
