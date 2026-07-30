#!/usr/bin/env bash
# scripts/verify-gate.sh — the /feature step 5 gate.
#
# The audit set is derived from package.json's ci:* scripts (single
# authoritative owner — the same list CI's lint job and the lefthook
# pre-push gate run), so a gate-green branch can't fail push-time audits.
# ci:fallow* is excluded: the fallow gate runs in its own CI workflow with
# its own baseline and env expectations.
#
# Checks run in PARALLEL (like the lefthook pre-push gate): wall-clock ≈ the
# slowest check, and all failures surface together in one table.
#
# Changed *.integration.test.ts files are surfaced explicitly: live-DB
# suites self-skip without TEST_DATABASE_POOL_URL, which is how a red CI
# once shipped from a "green" local run (the #520 failure class). With the
# env var set they RUN as part of the gate; without it they appear as a
# loud SKIP row instead of passing silently.
#
# Post-check rows (after the parallel checks):
#   promised-tests — every tests_to_add entry (a VERBATIM test title) must
#     exist in a test file; missing titles are listed.
#   reclassify — WARN when the actual diff exceeds ~2x the intake's
#     estimated_diff_size (the step 0 lane was probably wrong; feature.md's
#     re-classification trigger applies).
#
# `--review` mode (run once before step 7): the test row runs with
# coverage, then diff-coverage enforces changed-line coverage (default min
# 80%, override with DIFF_COVERAGE_MIN) via scripts/diff-coverage.ts.
set -uo pipefail

REVIEW_MODE=false
[ "${1:-}" = "--review" ] && REVIEW_MODE=true

INTAKE=".feature/intake.json"
mkdir -p .feature/logs

SURFACE=$(jq -r '.surface // "backend"' "$INTAKE" 2>/dev/null || echo "backend")

NAMES=()
PIDS=()

# Bound the fan-out. Unbounded, this script launches ~20 concurrent rows —
# the full vitest suite, a Next build, one vitest process per changed live-DB
# suite, and every ci:* audit — and the resulting CPU starvation trips vitest's
# 5s default testTimeout in rows that pass in under a second on their own. A
# gate that goes RED under its own load is worse than no gate.
MAX_PARALLEL=${MAX_PARALLEL:-4}
# The full-suite row sizes its own worker pool from the core count, so the row
# cap alone still oversubscribes. Bound it too; gate-only, so `pnpm test` on its
# own is untouched. (vitest 4 flag — the old VITEST_MAX_THREADS env var is gone.)
VITEST_WORKERS=${VITEST_WORKERS:-4}

launch() {
  local name="$1"; shift
  # Throttle by POLLING `jobs -rp`, never `wait -n`: the result loop below
  # recovers each row's exit code with `wait "${PIDS[$i]}"`, and `wait -n` does
  # not exist in bash 3.2 (what /usr/bin/env bash resolves to on macOS) — it
  # returns "invalid option" without blocking, spinning this loop forever.
  # `jobs -rp` counts running jobs without consuming any exit status.
  while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do
    sleep 0.5
  done
  ( "$@" ) > ".feature/logs/${name}.log" 2>&1 &
  NAMES+=("$name")
  PIDS+=("$!")
}

launch lint      pnpm lint
launch typecheck pnpm typecheck

# The full-suite row runs with live-DB suites forced ASLEEP (#563 item 1).
# With the test DB reachable, `pnpm test` wakes every *.integration.test.ts in
# the repo; the ones that set the `src/lib/db/server` singleton at import time
# then break inside a full run, because another file already initialized that
# singleton against a different URL (ECONNREFUSED :5432 — the #520 class).
# They pass when invoked directly, which is what the dedicated `integration-*`
# rows below are for.
#
# BOTH switches are required. `env -u TEST_DATABASE_POOL_URL` alone is NOT
# enough: `resolveTestDatabaseUrl()` falls back to reading .env.local off disk,
# so the suites gating on it wake up regardless of the environment.
run_full_suite() {
  env -u TEST_DATABASE_POOL_URL REPWORTH_DISABLE_LIVE_DB_SUITES=1 "$@"
}
if [ "$REVIEW_MODE" = true ]; then
  launch test run_full_suite pnpm test:coverage --maxWorkers="$VITEST_WORKERS"
else
  launch test run_full_suite pnpm test --maxWorkers="$VITEST_WORKERS"
fi

# Every ci:* audit from package.json (excluding ci:fallow*).
while IFS= read -r SCRIPT; do
  launch "${SCRIPT#ci:}" pnpm "$SCRIPT"
done < <(jq -r '.scripts | keys[] | select(startswith("ci:")) | select(startswith("ci:fallow") | not)' package.json)

if [ "$SURFACE" = "ui" ] || [ "$SURFACE" = "mixed" ]; then
  launch build pnpm build
fi

# Extra commands declared in the intake (each entry is one shell command).
while IFS= read -r CMD; do
  [ -n "$CMD" ] || continue
  SAFE=$(echo "$CMD" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)
  launch "extra-${SAFE}" bash -c "$CMD"
done < <(jq -r '.verification_commands[]?' "$INTAKE" 2>/dev/null)

# Changed live-DB integration suites (branch diff vs fork point + working
# tree). They self-skip without TEST_DATABASE_POOL_URL — never let that
# read as green.
BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
CHANGED_INTEGRATION=$(
  {
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD
    git status --porcelain --untracked-files=all | cut -c4-
  } 2>/dev/null | sort -u | grep -E '\.integration\.test\.ts$' || true
)
INTEGRATION_SKIPPED=0
# Per-row coverage output. Each integration row is its own vitest process
# writing a COMPLETE coverage-final.json, so a shared directory would let the
# last row overwrite every other one (#563 item 2). One directory per row, then
# merged into the base report before diff-coverage reads it.
INTEGRATION_COV_DIR=".feature/coverage"
rm -rf "$INTEGRATION_COV_DIR"
if [ -n "$CHANGED_INTEGRATION" ]; then
  if [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
    while IFS= read -r FILE; do
      [ -f "$FILE" ] || continue
      SAFE=$(echo "$FILE" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)
      if [ "$REVIEW_MODE" = true ]; then
        launch "integration-${SAFE}" pnpm vitest run "$FILE" \
          --coverage --coverage.reportOnFailure \
          --coverage.reportsDirectory="${INTEGRATION_COV_DIR}/${SAFE}"
      else
        launch "integration-${SAFE}" pnpm vitest run "$FILE"
      fi
    done <<< "$CHANGED_INTEGRATION"
  else
    INTEGRATION_SKIPPED=$(printf '%s\n' "$CHANGED_INTEGRATION" | grep -c .)
  fi
fi

RESULTS=()
for i in "${!NAMES[@]}"; do
  if wait "${PIDS[$i]}"; then
    RESULTS+=("PASS")
  else
    RESULTS+=("FAIL")
  fi
done

# Synchronous post-check, appended after the parallel rows.
run_sync() {
  local name="$1"; shift
  if "$@" > ".feature/logs/${name}.log" 2>&1; then
    NAMES+=("$name"); RESULTS+=("PASS")
  else
    NAMES+=("$name"); RESULTS+=("FAIL")
  fi
}

# --- promised-tests: tests_to_add entries are verbatim test titles ---
# grep, not rg: rg lives only in the interactive shell here — child bash
# processes don't have it, and a swallowed `command not found` reads as
# "every title missing".
#
# Search `scripts` too, not just src/worker: the CI audits under scripts/ci/
# carry their own suites (scripts/ci/__tests__/*.test.ts), and an intake may
# legitimately promise titles there. Omitting it reported every such title as
# missing while the tests existed and passed — a false RED that is
# indistinguishable from a genuinely unwritten test (#611 feature, 2026-07-28).
#
# Matching is fixed-string against the file, so a promised title must appear
# UNESCAPED in source: write a title containing an apostrophe with double
# quotes, or the `\'` will not match the locked text.
MISSING_TITLES=""
while IFS= read -r TITLE; do
  [ -n "$TITLE" ] || continue
  grep -rqF "$TITLE" --include='*.test.ts' --include='*.test.tsx' src worker scripts 2>/dev/null && continue
  MISSING_TITLES="${MISSING_TITLES}  - ${TITLE}
"
done < <(jq -r '.tests_to_add[]?' "$INTAKE" 2>/dev/null)
if jq -e '.tests_to_add | length > 0' "$INTAKE" >/dev/null 2>&1; then
  NAMES+=("promised-tests")
  if [ -n "$MISSING_TITLES" ]; then RESULTS+=("FAIL"); else RESULTS+=("PASS"); fi
fi

# --- reclassify: actual diff vs the intake's estimated_diff_size ---
RECLASSIFY_MSG=""
EST=$(jq -r '.estimated_diff_size // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
if [ -n "$EST" ] && [ "$EST" -gt 0 ] && [ -n "$BASE" ]; then
  ACTUAL=$(git diff --shortstat "$BASE" 2>/dev/null \
    | grep -oE '[0-9]+ (insertion|deletion)' | grep -oE '[0-9]+' | paste -sd+ - | bc 2>/dev/null || echo 0)
  if [ "${ACTUAL:-0}" -gt $((EST * 2)) ]; then
    NAMES+=("reclassify"); RESULTS+=("WARN")
    RECLASSIFY_MSG="actual diff ${ACTUAL} changed lines > 2x estimated_diff_size (${EST}) — re-run step 0 (re-classification trigger)."
  fi
fi

# --- diff-coverage (review mode only; consumes the test row's coverage) ---
# The test row above ran with live-DB suites asleep, so changed lines that only
# a live-DB suite executes are absent from its report. Fold each integration
# row's coverage in first, or DB-orchestration modules read ~0% on changed lines
# despite their suites passing (#563 item 2).
if [ "$REVIEW_MODE" = true ]; then
  if [ -d "$INTEGRATION_COV_DIR" ]; then
    run_sync merge-coverage \
      pnpm tsx scripts/merge-coverage.ts coverage/coverage-final.json "$INTEGRATION_COV_DIR"
  fi
  run_sync diff-coverage pnpm feature:diff-coverage
fi

if [ "$INTEGRATION_SKIPPED" -gt 0 ]; then
  NAMES+=("integration-suites")
  RESULTS+=("SKIP")
fi

PASSED=true
CHECKS_JSON="["
for i in "${!NAMES[@]}"; do
  [ "${RESULTS[$i]}" = "FAIL" ] && PASSED=false
  CHECKS_JSON+="{\"name\":\"${NAMES[$i]}\",\"result\":\"${RESULTS[$i]}\"},"
done
CHECKS_JSON="${CHECKS_JSON%,}]"

printf '{"passed":%s,"timestamp":%s,"checks":%s}\n' \
  "$PASSED" "$(date +%s)" "$CHECKS_JSON" > .feature/gate-status.json

echo "VERIFY GATE:"
for i in "${!NAMES[@]}"; do
  printf '  %-24s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
done

if [ "$INTEGRATION_SKIPPED" -gt 0 ]; then
  echo "WARNING: $INTEGRATION_SKIPPED changed integration suite(s) NOT run (TEST_DATABASE_POOL_URL unset)."
  echo "They self-skip locally and can go red in CI — set the var and re-run before review:"
  printf '%s\n' "$CHANGED_INTEGRATION" | sed 's/^/  - /'
fi
if [ -n "$MISSING_TITLES" ]; then
  echo "PROMISED TESTS MISSING (tests_to_add titles not found verbatim in any test file):"
  printf '%s' "$MISSING_TITLES"
fi
if [ -n "$RECLASSIFY_MSG" ]; then
  echo "RECLASSIFY: $RECLASSIFY_MSG"
fi

if [ "$PASSED" = "true" ]; then
  # Record the green gate in the machine-readable state (lastGreenGateSha
  # snapshot) when this is an armed feature run.
  if [ -f .feature/intake.json ] && [ -f scripts/feature-state.sh ]; then
    bash scripts/feature-state.sh set-phase gate_green || true
  fi
  echo "GATE: GREEN"
  exit 0
else
  echo "GATE: RED — tails in .feature/logs/<name>.log"
  exit 1
fi
