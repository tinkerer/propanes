#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "[amirobot] starting..."
exec node --env-file=.env -r tsx/cjs src/index.ts
