#!/bin/sh
# Schedules the daily backup with crond. Cron jobs do not inherit the container environment,
# so the needed variables are written (safely quoted) to a root-only file.
set -eu
: > /etc/backup.env; chmod 600 /etc/backup.env
for k in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE BACKUP_KEEP_DAYS BACKUP_PASSPHRASE RCLONE_REMOTE TZ; do
  eval "v=\${$k:-}"
  [ -n "$v" ] && printf "export %s='%s'\n" "$k" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")" >> /etc/backup.env
done
echo "${BACKUP_CRON:-30 2 * * *} . /etc/backup.env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "[backup] scheduled: ${BACKUP_CRON:-30 2 * * *} (keep ${BACKUP_KEEP_DAYS:-14} days)"
exec crond -f -l 8
