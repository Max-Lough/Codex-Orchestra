#!/usr/bin/env sh
set -eu
command -v node >/dev/null 2>&1 || {
  echo "ERROR: Node.js is required. Install it and ensure 'node' is on PATH." >&2
  exit 1
}
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/install.js" "$@"
