#!/usr/bin/env bash
# Links the pi peer dependencies into this project's node_modules so tests can
# resolve them without a full pi runtime install. Requires the `pi` binary on
# PATH (realpath pi -> .../pi-coding-agent/dist/cli.js).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIBIN="$(command -v pi)" || { echo "pi binary not found on PATH" >&2; exit 1; }
PIROOT="$(dirname "$(dirname "$(realpath "$PIBIN")")")"

mkdir -p "$ROOT/node_modules/@earendil-works"
ln -sfn "$PIROOT/node_modules/typebox" "$ROOT/node_modules/typebox"
ln -sfn "$PIROOT/node_modules/@earendil-works/pi-ai" "$ROOT/node_modules/@earendil-works/pi-ai"
ln -sfn "$PIROOT/node_modules/@earendil-works/pi-tui" "$ROOT/node_modules/@earendil-works/pi-tui"
ln -sfn "$PIROOT" "$ROOT/node_modules/@earendil-works/pi-coding-agent"

echo "Linked test deps from: $PIROOT"
