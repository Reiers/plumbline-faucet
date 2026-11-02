#!/usr/bin/env bash
# Online backup of the faucet SQLite store (rate limits, API keys, stats).
#
# Safe to run while the faucet is up: uses the SQLite online backup API,
# checks the copy with PRAGMA integrity_check, gzips it, and prunes old
# copies. Requires the sqlite3 CLI (apt-get install sqlite3).
#
# Env (all optional):
#   RATE_LIMIT_DB  path to the live DB   (default /opt/plumbline-faucet/rate-limits.sqlite)
#   BACKUP_DIR     where copies go       (default /var/backups/plumbline-faucet)
#   KEEP_DAYS      days of copies kept   (default 7)
set -euo pipefail

DB="${RATE_LIMIT_DB:-/opt/plumbline-faucet/rate-limits.sqlite}"
DEST="${BACKUP_DIR:-/var/backups/plumbline-faucet}"
KEEP_DAYS="${KEEP_DAYS:-7}"

[ -f "$DB" ] || { echo "backup: no database at $DB" >&2; exit 1; }
install -d -m 0700 "$DEST"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$DEST/.rate-limits-$ts.sqlite"
out="$DEST/rate-limits-$ts.sqlite.gz"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

sqlite3 "$DB" ".backup '$tmp'"
check="$(sqlite3 "$tmp" 'PRAGMA integrity_check;')"
[ "$check" = "ok" ] || { echo "backup: integrity_check failed: $check" >&2; exit 1; }

gzip -9 "$tmp"
mv "$tmp.gz" "$out"
chmod 0600 "$out"

find "$DEST" -maxdepth 1 -name 'rate-limits-*.sqlite.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup: wrote $out ($(stat -c %s "$out") bytes)"
