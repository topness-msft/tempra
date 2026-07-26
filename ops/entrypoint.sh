#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DATA_DIR}/${DB_FILE:-tempra.db}"

mkdir -p "$DATA_DIR"

# Without a bucket there is nothing to restore from and nothing to stream to, so
# run the server directly rather than pretending to replicate. BUCKET_NAME is
# the switch because `fly storage create` sets it alongside the credentials, so
# replication cannot be half-configured.
if [ -z "${BUCKET_NAME:-}" ]; then
  echo "litestream: disabled (BUCKET_NAME unset)"
  exec node packages/server/dist/index.js
fi

# Restore is a no-op when the volume already holds the database, which is the
# normal case; it only does work after a volume loss or a fresh machine.
if [ ! -f "$DB_PATH" ]; then
  echo "litestream: no local database, attempting restore"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$DB_PATH"
fi

exec litestream replicate -config /etc/litestream.yml -exec "node packages/server/dist/index.js"
