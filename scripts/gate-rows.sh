#!/usr/bin/env bash
# scripts/gate-rows.sh — row identity for the /feature verify gate (#696).
#
# Sourced by scripts/verify-gate.sh. A gate row's NAME is simultaneously three
# things: its slot in the printed PASS/FAIL table, its log file
# (.feature/logs/<name>.log), and — for integration rows — its coverage
# directory. Two rows resolving to one name therefore share all three.
#
# The observed symptom was a spurious RED: two vitest processes raced one
# coverage directory and died on ENOENT while both suites passed 30/30 when run
# alone. The dangerous half is the other direction — a shared status slot can
# report PASS for a suite that actually FAILED, a silent green in the check
# that is meant to be the mechanical backstop for a whole /feature run.
#
# This lives in its own file because bash has no in-file unit-test seam:
# sourcing verify-gate.sh runs the gate. scripts/ci/__tests__/gate-rows.test.ts
# sources THIS file and calls both functions directly.

# Resolved once, at source time. An empty hash suffix would silently reinstate
# the collision this file exists to prevent, so a missing hash tool is fatal —
# but deliberately NOT via `exit` here. This file is SOURCED: exiting would take
# the gate down before it could record a RED gate-status.json, leaving the
# previous run's green file on disk for .claude/hooks/stop-gate.sh to read as
# this run's result. Instead GATE_ROW_HASH_CMD stays unset and the caller aborts
# through its own gate_abort.
if command -v shasum >/dev/null 2>&1; then
  GATE_ROW_HASH_CMD=shasum
elif command -v sha1sum >/dev/null 2>&1; then
  GATE_ROW_HASH_CMD=sha1sum
else
  echo "gate-rows: neither shasum nor sha1sum on PATH — cannot derive collision-free row names" >&2
fi

# row_slug <string> — a filesystem-safe row name, unique per input.
#
# The truncated prefix keeps the row readable in the printed table; the hash
# suffix is what makes it collision-free. `cut -c1-40` alone collapsed
# src/lib/reviews/__tests__/import-consent.integration.test.ts together with
# every import-consent-*.integration.test.ts sibling: that path is EXACTLY 40
# slug characters long, so the truncation discarded the only distinguishing
# part. Truncating for readability is fine; identifying by the truncation is
# not.
row_slug() {
  printf '%s-%s' \
    "$(printf '%s' "$1" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)" \
    "$(printf '%s' "$1" | "$GATE_ROW_HASH_CMD" | cut -c1-6)"
}

# assert_unique_row_name <candidate> [already-registered...] — non-zero if the
# candidate is taken.
#
# A duplicate is not a degraded mode to tolerate and recover from: the two rows
# would share one status slot, so one of them can only ever be reported as the
# other's result. row_slug makes a collision unreachable for the dynamic rows;
# this makes it unable to resolve SILENTLY if a future row name is derived some
# other way.
assert_unique_row_name() {
  local candidate="$1"
  shift
  local existing
  for existing in "$@"; do
    if [ "$existing" = "$candidate" ]; then
      echo "gate-rows: duplicate row name '$candidate' — two checks would share one status slot and one .feature/logs/${candidate}.log" >&2
      return 1
    fi
  done
  return 0
}
