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

launch() {
  local name="$1"; shift
  ( "$@" ) > ".feature/logs/${name}.log" 2>&1 &
  NAMES+=("$name")
  PIDS+=("$!")
}

launch lint      pnpm lint
launch typecheck pnpm typecheck
if [ "$REVIEW_MODE" = true ]; then
  launch test pnpm test:coverage
else
  launch test pnpm test
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
if [ -n "$CHANGED_INTEGRATION" ]; then
  if [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
    while IFS= read -r FILE; do
      [ -f "$FILE" ] || continue
      SAFE=$(echo "$FILE" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)
      launch "integration-${SAFE}" pnpm vitest run "$FILE"
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
MISSING_TITLES=""
while IFS= read -r TITLE; do
  [ -n "$TITLE" ] || continue
  grep -rqF "$TITLE" --include='*.test.ts' --include='*.test.tsx' src worker 2>/dev/null && continue
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
if [ "$REVIEW_MODE" = true ]; then
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
