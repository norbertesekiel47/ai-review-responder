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
# DB precondition (owned by the gate, not the intake): TEST_DATABASE_POOL_URL
# is resolved here (env first, .env.local fallback), and a db_touching intake
# gets the test DB provisioned SERIALLY before the parallel fan-out.
# `pnpm test:db:setup` drops schema `public` — run as a parallel peer (a #643
# verification_command) it demolished the schema underneath its own siblings
# (27 phantom timeouts). Destructive commands in verification_commands are
# rejected, not run.
#
# Docs-only mode (auto-detected): when every changed path is docs/, .claude/,
# or *.md, the code rows (test, build, promised-tests, reclassify,
# diff-coverage) are meaningless — two #643 sessions hit a wall where a
# docs-only commit could never go green. Lint, typecheck, and the ci:* audits
# still run; gate-status.json records "mode":"docs_only".
#
# Post-check rows (after the parallel checks):
#   promised-tests — every tests_to_add entry (a VERBATIM test title) must
#     exist in a test file; missing titles are listed.
#   reclassify — WARN when either diff bucket (production / test) exceeds
#     ~2x its intake estimate (estimated_prod_lines / estimated_test_lines;
#     legacy fallback: estimated_diff_size vs the combined total). Workflow
#     artifacts (docs/superpowers/plans/**, docs/reviews/**) are EXCLUDED —
#     #643's plan+deviations alone were 1,537 of 4,989 "changed lines",
#     firing the trigger on the workflow's own paperwork.
#
# `--review` mode (run once before step 7): the test row runs with
# coverage, then diff-coverage enforces changed-line coverage (default min
# 80%, override with DIFF_COVERAGE_MIN) via scripts/diff-coverage.ts.
set -uo pipefail

REVIEW_MODE=false
[ "${1:-}" = "--review" ] && REVIEW_MODE=true

INTAKE=".feature/intake.json"
mkdir -p .feature/logs

# Fatal abort taken before the results table exists. Records a RED
# gate-status.json on the way out: leaving the previous run's green file on
# disk would let the Stop hook read a stale success as this run's result.
#
# Defined BEFORE anything that can fail, including the sourced row library, so
# every later failure exits THROUGH here rather than around it.
gate_abort() {
  local row="$1" message="$2"
  # Best effort: TERM the launched subshells so an abort does not leave a pile
  # of visibly running rows. Their own children (pnpm → node) share this
  # shell's process group and are NOT reaped — building per-row process groups
  # would mean enabling job control, which changes the `jobs -rp` throttle the
  # fan-out depends on. A duplicate row name is a gate bug that should never
  # reach a user; this is tidiness, not a guarantee.
  kill $(jobs -p) 2>/dev/null || true
  printf '{"passed":false,"mode":"full","timestamp":%s,"checks":[{"name":"%s","result":"FAIL"}]}\n' \
    "$(date +%s)" "$row" > .feature/gate-status.json
  echo "VERIFY GATE:"
  printf '  %-24s %s\n' "$row" "FAIL"
  echo "GATE: RED — $message"
  exit 1
}

# Row identity. A row's name is also its log file and its coverage directory,
# so name uniqueness is a correctness property rather than cosmetics (#696).
# Sourced rather than inlined: sourcing THIS script would run the gate, which
# left the derivation with no unit-test seam.
# `CDPATH=` because an exported CDPATH makes `cd` resolve somewhere else and
# print the directory it chose, silently pointing this at the wrong tree.
GATE_SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/gate-rows.sh
. "$GATE_SCRIPT_DIR/gate-rows.sh"
# A library that did not load must not surface as a bogus collision: with
# assert_unique_row_name undefined, `launch` reads the resulting exit 127 as a
# duplicate and aborts naming a row that is perfectly fine.
command -v row_slug >/dev/null 2>&1 && [ -n "${GATE_ROW_HASH_CMD:-}" ] \
  || gate_abort "row-identity" \
       "scripts/gate-rows.sh did not load (see above) — row names cannot be made collision-free."

SURFACE=$(jq -r '.surface // "backend"' "$INTAKE" 2>/dev/null || echo "backend")
DB_TOUCHING=$(jq -r '.db_touching // false' "$INTAKE" 2>/dev/null || echo "false")

BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "")

# Docs-only detection: branch diff + working tree, same union the
# integration-suite scan uses below.
CHANGED_PATHS=$(
  {
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD
    git status --porcelain --untracked-files=all | cut -c4-
  } 2>/dev/null | sort -u | grep -v '^$' || true
)
DOCS_ONLY=false
if [ -n "$CHANGED_PATHS" ] && \
   ! printf '%s\n' "$CHANGED_PATHS" | grep -qvE '^docs/|^\.claude/|\.md$'; then
  DOCS_ONLY=true
fi

# Resolve TEST_DATABASE_POOL_URL so changed integration suites never SKIP on
# a machine that has the DB configured (#643: the gate itself reported SKIP
# and then declared its own result not review-ready).
if [ -z "${TEST_DATABASE_POOL_URL:-}" ] && [ -f .env.local ]; then
  ENV_URL=$(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  [ -n "$ENV_URL" ] && export TEST_DATABASE_POOL_URL="$ENV_URL"
fi

# Serial DB provisioning — a precondition, never a parallel peer. Fail fast:
# every DB row downstream of a failed provision is noise.
DB_PROVISION_RESULT=""
if [ "$DOCS_ONLY" = false ] && [ "$DB_TOUCHING" = "true" ] && [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
  if pnpm test:db:setup > .feature/logs/db-provision.log 2>&1; then
    DB_PROVISION_RESULT="PASS"
  else
    gate_abort "db-provision" \
      "test-DB provisioning failed (tail .feature/logs/db-provision.log); parallel checks not started."
  fi
fi

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
  # One name = one status slot = one .feature/logs/<name>.log. A second row
  # under the same name can only be reported as the first one's result, so it
  # aborts the gate instead of resolving silently (#696). `${NAMES[@]+…}` is
  # the bash 3.2 spelling for expanding a possibly-empty array under `set -u`.
  assert_unique_row_name "$name" ${NAMES[@]+"${NAMES[@]}"} \
    || gate_abort "row-name-collision" "duplicate gate row name '$name' (see above)."
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
if [ "$DOCS_ONLY" = false ]; then
  if [ "$REVIEW_MODE" = true ]; then
    launch test run_full_suite pnpm test:coverage --maxWorkers="$VITEST_WORKERS"
  else
    launch test run_full_suite pnpm test --maxWorkers="$VITEST_WORKERS"
  fi
fi

# Every ci:* audit from package.json (excluding ci:fallow*).
while IFS= read -r SCRIPT; do
  launch "${SCRIPT#ci:}" pnpm "$SCRIPT"
done < <(jq -r '.scripts | keys[] | select(startswith("ci:")) | select(startswith("ci:fallow") | not)' package.json)

if { [ "$SURFACE" = "ui" ] || [ "$SURFACE" = "mixed" ]; } && [ "$DOCS_ONLY" = false ]; then
  launch build pnpm build
fi

# Extra commands declared in the intake (each entry is one shell command).
# Destructive DB commands are REJECTED, not run: the gate owns provisioning
# (serial, above) — a schema-dropping command can never be a safe parallel
# peer of the suites reading that schema (#643 step-5 gate incident).
#
# A rejected extra never reaches `launch`, so it asserts its own name: row_slug
# separates two DIFFERENT commands, but two IDENTICAL intake entries derive the
# same slug and would share one row and one log (#696).
REJECTED_EXTRAS=()
while IFS= read -r CMD; do
  [ -n "$CMD" ] || continue
  SAFE=$(row_slug "$CMD")
  if echo "$CMD" | grep -qiE 'test:db:setup|db:setup|drop schema'; then
    assert_unique_row_name "extra-${SAFE}" \
      ${NAMES[@]+"${NAMES[@]}"} ${REJECTED_EXTRAS[@]+"${REJECTED_EXTRAS[@]}"} \
      || gate_abort "row-name-collision" "duplicate gate row name 'extra-${SAFE}' (see above)."
    echo "rejected destructive verification_command: $CMD" > ".feature/logs/extra-${SAFE}.log"
    echo "The gate provisions the test DB serially when db_touching — remove this from the intake." >> ".feature/logs/extra-${SAFE}.log"
    REJECTED_EXTRAS+=("extra-${SAFE}")
    continue
  fi
  launch "extra-${SAFE}" bash -c "$CMD"
done < <(jq -r '.verification_commands[]?' "$INTAKE" 2>/dev/null)

# Changed live-DB integration suites (branch diff vs fork point + working
# tree). They self-skip without TEST_DATABASE_POOL_URL — never let that
# read as green.
CHANGED_INTEGRATION=$(printf '%s\n' "$CHANGED_PATHS" | grep -E '\.integration\.test\.ts$' || true)
INTEGRATION_SKIPPED=0
# Per-row coverage output. Each integration row is its own vitest process
# writing a COMPLETE coverage-final.json, so a shared directory would let the
# last row overwrite every other one (#563 item 2). One directory per row, then
# merged into the base report before diff-coverage reads it. "Per row" is only
# true because the row name is collision-free: while it was a 40-character
# truncation, two import-consent-*.integration.test.ts suites resolved to ONE
# directory and raced it to an ENOENT (#696) — and, worse, to one status slot.
INTEGRATION_COV_DIR=".feature/coverage"
rm -rf "$INTEGRATION_COV_DIR"
if [ -n "$CHANGED_INTEGRATION" ]; then
  if [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
    while IFS= read -r FILE; do
      [ -f "$FILE" ] || continue
      SAFE=$(row_slug "$FILE")
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

# Rows recorded outside the parallel section (appended after the wait loop so
# NAMES/PIDS index pairing above stays intact).
if [ -n "$DB_PROVISION_RESULT" ]; then
  NAMES+=("db-provision"); RESULTS+=("$DB_PROVISION_RESULT")
fi
for REJECTED in ${REJECTED_EXTRAS[@]+"${REJECTED_EXTRAS[@]}"}; do
  NAMES+=("$REJECTED"); RESULTS+=("FAIL")
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
if [ "$DOCS_ONLY" = false ] && jq -e '.tests_to_add | length > 0' "$INTAKE" >/dev/null 2>&1; then
  NAMES+=("promised-tests")
  if [ -n "$MISSING_TITLES" ]; then RESULTS+=("FAIL"); else RESULTS+=("PASS"); fi
fi

# --- reclassify: actual diff vs the intake's per-bucket estimates ---
# Buckets: test (__tests__/, *.test.ts(x), e2e/) vs production (the rest).
# Workflow artifacts (docs/superpowers/plans/**, docs/reviews/**) are excluded
# entirely — the plan document is not scope creep against itself.
RECLASSIFY_MSG=""
if [ "$DOCS_ONLY" = false ] && [ -n "$BASE" ]; then
  PROD_ACTUAL=0; TEST_ACTUAL=0
  while IFS=$'\t' read -r ADDS DELS PATHNAME; do
    [ -n "$PATHNAME" ] || continue
    case "$ADDS" in ''|*[!0-9]*) continue ;; esac
    case "$DELS" in ''|*[!0-9]*) continue ;; esac
    case "$PATHNAME" in
      docs/superpowers/plans/*|docs/reviews/*) continue ;;
    esac
    if echo "$PATHNAME" | grep -qE '(^|/)__tests__/|\.test\.tsx?$|^e2e/'; then
      TEST_ACTUAL=$((TEST_ACTUAL + ADDS + DELS))
    else
      PROD_ACTUAL=$((PROD_ACTUAL + ADDS + DELS))
    fi
  done < <(git diff --numstat "$BASE" 2>/dev/null)

  EST_PROD=$(jq -r '.estimated_prod_lines // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  EST_TEST=$(jq -r '.estimated_test_lines // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  if [ -n "$EST_PROD" ] || [ -n "$EST_TEST" ]; then
    OVER=""
    if [ -n "$EST_PROD" ] && [ "$EST_PROD" -gt 0 ] && [ "$PROD_ACTUAL" -gt $((EST_PROD * 2)) ]; then
      OVER="production ${PROD_ACTUAL} > 2x estimated_prod_lines (${EST_PROD})"
    fi
    if [ -n "$EST_TEST" ] && [ "$EST_TEST" -gt 0 ] && [ "$TEST_ACTUAL" -gt $((EST_TEST * 2)) ]; then
      [ -n "$OVER" ] && OVER="${OVER}; "
      OVER="${OVER}test ${TEST_ACTUAL} > 2x estimated_test_lines (${EST_TEST})"
    fi
    if [ -n "$OVER" ]; then
      NAMES+=("reclassify"); RESULTS+=("WARN")
      RECLASSIFY_MSG="${OVER} changed lines (workflow artifacts excluded) — re-run step 0 (re-classification trigger)."
    fi
  else
    # Legacy intakes: single estimated_diff_size vs the combined total.
    EST=$(jq -r '.estimated_diff_size // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    if [ -n "$EST" ] && [ "$EST" -gt 0 ] && [ $((PROD_ACTUAL + TEST_ACTUAL)) -gt $((EST * 2)) ]; then
      NAMES+=("reclassify"); RESULTS+=("WARN")
      RECLASSIFY_MSG="actual diff $((PROD_ACTUAL + TEST_ACTUAL)) changed lines (workflow artifacts excluded) > 2x estimated_diff_size (${EST}) — re-run step 0 (re-classification trigger)."
    fi
  fi
fi

# --- diff-coverage (review mode only; consumes the test row's coverage) ---
# The test row above ran with live-DB suites asleep, so changed lines that only
# a live-DB suite executes are absent from its report. Fold each integration
# row's coverage in first, or DB-orchestration modules read ~0% on changed lines
# despite their suites passing (#563 item 2).
if [ "$REVIEW_MODE" = true ] && [ "$DOCS_ONLY" = false ]; then
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

GATE_MODE="full"
[ "$DOCS_ONLY" = true ] && GATE_MODE="docs_only"
printf '{"passed":%s,"mode":"%s","timestamp":%s,"checks":%s}\n' \
  "$PASSED" "$GATE_MODE" "$(date +%s)" "$CHECKS_JSON" > .feature/gate-status.json

echo "VERIFY GATE:"
if [ "$DOCS_ONLY" = true ]; then
  echo "  (docs-only mode: every changed path is docs/, .claude/, or *.md —"
  echo "   test/build/promised-tests/reclassify/diff-coverage rows skipped)"
fi
for i in "${!NAMES[@]}"; do
  printf '  %-24s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
done

if [ "$INTEGRATION_SKIPPED" -gt 0 ]; then
  echo "WARNING: $INTEGRATION_SKIPPED changed integration suite(s) NOT run (TEST_DATABASE_POOL_URL unset)."
  echo "They self-skip locally and can go red in CI — set the var and re-run before review:"
  printf '%s\n' "$CHANGED_INTEGRATION" | sed 's/^/  - /'
fi
if [ "$DOCS_ONLY" = false ] && [ -n "$MISSING_TITLES" ]; then
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
