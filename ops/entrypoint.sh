#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DATA_DIR}/${DB_FILE:-tempra.db}"

mkdir -p "$DATA_DIR"

# Without a replica target there is nothing to restore from and nothing to
# stream to, so run the server directly rather than pretending to replicate.
if [ -z "${REPLICA_URL:-}" ]; then
  echo "litestream: disabled (REPLICA_URL unset)"
  exec node packages/server/dist/index.js
fi

# Restore is a no-op when the volume already holds the database, which is the
# normal case; it only does work after a volume loss or a fresh machine.
if [ ! -f "$DB_PATH" ]; then
  echo "litestream: no local database, attempting restore"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$DB_PATH"
fi

exec litestream replicate -config /etc/litestream.yml -exec "node packages/server/dist/index.js"
