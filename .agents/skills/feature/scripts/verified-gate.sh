#!/usr/bin/env bash

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

case "${1:-}" in
  "") bash scripts/verify-gate.sh ;;
  --review) bash scripts/verify-gate.sh --review ;;
  # --baseline proves the tree green without advancing the phase; --fast
  # proves a fix inside the loop; --status only reports. None of the three is
  # gate evidence, so none of them touches the fingerprint.
  --baseline) exec bash scripts/verify-gate.sh --baseline ;;
  --fast) exec bash scripts/verify-gate.sh --fast ;;
  --status) exec bash scripts/verify-gate.sh --status ;;
  *) echo "usage: verified-gate.sh [--review|--baseline|--fast|--status]" >&2; exit 2 ;;
esac

node .agents/skills/feature/scripts/gate-fingerprint.mjs write
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
