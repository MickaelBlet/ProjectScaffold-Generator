#!/usr/bin/env bash
# Build the code generator into dist-cli/scaffold-gen (standalone executable, no Node needed)
# and dist-cli/scaffold-gen.cjs (single file, runs with node).
# Usage: scripts/build_cli.sh [node binary to embed, same version as the current node (e.g. its Windows
# node.exe); default: the current node]
set -euo pipefail
cd "$(dirname "$0")/.."

# Install when missing or older than the lockfile (dependencies added since the last install).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

npm run cli -- "$@" 2>&1 | grep -v "Can't find string offset for section name" # postject noise on Linux

ls -lh dist-cli
