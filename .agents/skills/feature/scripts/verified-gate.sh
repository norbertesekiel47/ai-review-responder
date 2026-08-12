#!/usr/bin/env bash

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

case "${1:-}" in
  "") bash scripts/verify-gate.sh ;;
  --review) bash scripts/verify-gate.sh --review ;;
  *) echo "usage: verified-gate.sh [--review]" >&2; exit 2 ;;
esac

node .agents/skills/feature/scripts/gate-fingerprint.mjs write
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
