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
# CROSS-PROCESS (#877): serial-within-one-run is NOT enough — every sibling
# worktree shares the one localhost test DB, and a concurrent gate's
# provisioning once dropped the schema under this run's rls-audit read.
# Coordination lives in the advisory-lock protocol on
# hashtext('repworth_live_db_integration'): test-db-setup.sh holds it
# exclusively in the same psql session as its DDL, ci:rls-audit's live check
# holds it shared, and the DDL suites hold it exclusively — so this gate's
# provisioning WAITS for a sibling's lock holders instead of racing them.
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
#     legacy fallback: estimated_diff_size vs the combined total). A run's own
#     mandatory paperwork is EXCLUDED, because a run cannot commit scope creep
#     against paperwork the lane requires it to produce — #643's plan and
#     deviations alone were 1,537 of 4,989 "changed lines", and #1082's
#     staging evidence and arch-review row were 108 against 27 executable
#     lines (#1114). `reclassify_bucket` below is the ONE list of what counts.
#
# `--review` mode (run once before step 7): the test row runs with
# coverage, then diff-coverage enforces changed-line coverage (default min
# 80%, override with DIFF_COVERAGE_MIN) via scripts/diff-coverage.ts.
#
# `--fast` mode (the unattended fix loop ONLY, speed lane build 5): the same
# row set, with exactly two rows narrowed against the last green SHA —
#   test  — `vitest run --changed <since>` instead of the full suite
#   build — skipped when nothing it compiles changed since <since>, because
#           the last green gate already proved the build at that SHA
# It writes .feature/gate-fast.json and NEVER .feature/gate-status.json, so a
# fast green can never be mistaken for review evidence: the Stop hook reads
# only gate-status.json's `passed` + `timestamp` and ignores `mode`, so a fast
# result written there would silently authorize finishing. Fast mode also
# never advances the phase. Run the full gate before review, always.
set -uo pipefail

REVIEW_MODE=false
BASELINE_MODE=false
FAST_MODE=false
HEARTBEAT=".feature/gate-heartbeat.json"
# Every write of the results file goes through this variable. Fast mode
# repoints it; nothing else may hard-code the path.
STATUS_FILE=".feature/gate-status.json"

# --status: report on a running/dead/finished gate WITHOUT running anything.
# Three sessions burned 10-minute blocking waits on a gate that was hung or
# never launched (2026-07-24, 2026-07-31); this answers in one command.
#   RUNNING — the gate process is alive; shows rows done and elapsed time.
#   DEAD    — a heartbeat exists but its pid is gone: the run crashed or was
#             killed mid-gate and wrote no final result. Exit 3.
#   otherwise — the last completed result (or "never ran").
if [ "${1:-}" = "--status" ]; then
  if [ -f "$HEARTBEAT" ]; then
    HB_PID=$(jq -r '.pid // empty' "$HEARTBEAT")
    HB_STARTED=$(jq -r '.startedAt // 0' "$HEARTBEAT")
    HB_MODE=$(jq -r '.mode // "full"' "$HEARTBEAT")
    ELAPSED=$(( $(date +%s) - HB_STARTED ))
    TOTAL=$(jq -r '.rows | length' "$HEARTBEAT")
    DONE=0; RUNNING_ROWS=""
    while IFS= read -r ROW; do
      [ -n "$ROW" ] || continue
      if [ -f ".feature/logs/${ROW}.rc" ]; then
        DONE=$((DONE + 1))
      else
        RUNNING_ROWS="${RUNNING_ROWS} ${ROW}"
      fi
    done < <(jq -r '.rows[]?' "$HEARTBEAT")
    # pid-alive alone is not enough: the OS reuses pids. Require the live
    # process to actually be a verify-gate run (same trick as live-view.mjs).
    if [ -n "$HB_PID" ] && kill -0 "$HB_PID" 2>/dev/null \
       && ps -o command= -p "$HB_PID" 2>/dev/null | grep -q "verify-gate"; then
      echo "GATE STATUS: RUNNING (pid ${HB_PID}, mode ${HB_MODE}, ${ELAPSED}s elapsed)"
      echo "  rows done: ${DONE}/${TOTAL}; still running:${RUNNING_ROWS:- (none launched yet)}"
      exit 0
    fi
    echo "GATE STATUS: DEAD — pid ${HB_PID:-?} is no live verify-gate process and no final result was written (started ${ELAPSED}s ago)."
    echo "  The run crashed or was killed mid-gate. Rows done before death: ${DONE}/${TOTAL}."
    echo "  Tail .feature/logs/<row>.log for the last row, then re-run the gate."
    exit 3
  fi
  if [ -f .feature/gate-status.json ]; then
    LAST_TS=$(jq -r '.timestamp // 0' .feature/gate-status.json)
    LAST_AGE=$(( $(date +%s) - LAST_TS ))
    LAST_PASSED=$(jq -r '.passed' .feature/gate-status.json)
    LAST_MODE=$(jq -r '.mode // "full"' .feature/gate-status.json)
    echo "GATE STATUS: NOT RUNNING — last result passed=${LAST_PASSED} (mode ${LAST_MODE}, ${LAST_AGE}s ago)"
    exit 0
  fi
  echo "GATE STATUS: NEVER RAN — no heartbeat, no .feature/gate-status.json"
  exit 0
fi

case "${1:-}" in
  --review) REVIEW_MODE=true ;;
  # --baseline: run every check but NEVER advance the phase. For proving a
  # worktree green at plan time — a baseline run once auto-advanced the phase
  # to gate_green and had to be hand-rolled back (2026-08-08).
  --baseline) BASELINE_MODE=true ;;
  --fast) FAST_MODE=true; STATUS_FILE=".feature/gate-fast.json" ;;
  "") ;;
  *) echo "usage: verify-gate.sh [--review|--baseline|--fast|--status]"; exit 2 ;;
esac

INTAKE=".feature/intake.json"
mkdir -p .feature/logs

# Heartbeat: written FIRST (before anything that can gate_abort), extended per
# row in launch(), removed on every exit path. While it exists,
# `verify-gate.sh --status` can tell a live run from a crashed one. Per-row
# completion is a .rc marker written by the row's own subshell, so status
# stays accurate while the main shell blocks in wait.
rm -f .feature/logs/*.rc
GATE_MODE_LABEL="full"
[ "$REVIEW_MODE" = true ] && GATE_MODE_LABEL="review"
[ "$BASELINE_MODE" = true ] && GATE_MODE_LABEL="baseline"
[ "$FAST_MODE" = true ] && GATE_MODE_LABEL="fast"
jq -n --argjson pid "$$" --arg mode "$GATE_MODE_LABEL" --argjson now "$(date +%s)" \
  '{pid: $pid, mode: $mode, startedAt: $now, rows: []}' > "$HEARTBEAT"

# Fatal abort taken before the results table exists. Records a RED
# gate-status.json on the way out: leaving the previous run's green file on
# disk would let the Stop hook read a stale success as this run's result.
#
# Defined BEFORE anything that can fail, including the sourced row library, so
# every later failure exits THROUGH here rather than around it.
gate_abort() {
  local row="$1" message="$2"
  # ${HEARTBEAT:-}: the gate-rows test harness runs this body standalone
  # under `set -u` without the heartbeat wiring.
  [ -n "${HEARTBEAT:-}" ] && rm -f "$HEARTBEAT"
  # Best effort: TERM the launched subshells so an abort does not leave a pile
  # of visibly running rows. Their own children (pnpm → node) share this
  # shell's process group and are NOT reaped — building per-row process groups
  # would mean enabling job control, which changes the `jobs -rp` throttle the
  # fan-out depends on. A duplicate row name is a gate bug that should never
  # reach a user; this is tidiness, not a guarantee.
  kill $(jobs -p) 2>/dev/null || true
  printf '{"passed":false,"mode":"%s","timestamp":%s,"checks":[{"name":"%s","result":"FAIL"}]}\n' \
    "${GATE_MODE_LABEL:-full}" "$(date +%s)" "$row" > "${STATUS_FILE:-.feature/gate-status.json}"
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
# shellcheck source=scripts/gate-promised-tests.sh
. "$GATE_SCRIPT_DIR/gate-promised-tests.sh"
# A library that did not load must not surface as a bogus collision: with
# assert_unique_row_name undefined, `launch` reads the resulting exit 127 as a
# duplicate and aborts naming a row that is perfectly fine.
command -v row_slug >/dev/null 2>&1 && [ -n "${GATE_ROW_HASH_CMD:-}" ] \
  || gate_abort "row-identity" \
       "scripts/gate-rows.sh did not load (see above) — row names cannot be made collision-free."
# A matcher that did not load must not surface as "every title missing": with
# promised_title_found undefined, the promised-tests loop below would read
# every call's exit 127 as a genuine absence and fail every promised title
# (#1108's exact failure direction).
command -v promised_title_found >/dev/null 2>&1 \
  || gate_abort "promised-tests" \
       "scripts/gate-promised-tests.sh did not load (see above) — every promised title would be reported missing."

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

# --- fast mode: what "since" means ---------------------------------------
# The narrowing anchor is the SHA the last FULL gate went green at. Every row
# passed there, so a fast run only has to prove what changed after it. Without
# a recorded green (first run of a branch) fall back to the fork point, which
# narrows nothing that matters and is never wrong. A fast run is never review
# evidence, so an over-broad anchor costs time, never correctness.
FAST_SINCE=""
FAST_CHANGED=""
FAST_UI_CHANGED=true
if [ "$FAST_MODE" = true ]; then
  FAST_SINCE=$(jq -r '.lastGreenGateSha // empty' .feature/state.json 2>/dev/null || true)
  # A recorded SHA that no longer resolves (rebase, amend) narrows against
  # nothing — fall back rather than hand vitest a dead ref.
  if [ -z "$FAST_SINCE" ] || ! git cat-file -e "${FAST_SINCE}^{commit}" 2>/dev/null; then
    FAST_SINCE="$BASE"
  fi
  if [ -n "$FAST_SINCE" ]; then
    FAST_CHANGED=$(
      {
        git diff --name-only "$FAST_SINCE" HEAD
        git status --porcelain --untracked-files=all | cut -c4-
      } 2>/dev/null | sort -u | grep -v '^$' || true
    )
    # `pnpm build` is skipped only when nothing it compiles moved since the
    # anchor. An empty change list means the build result at the anchor still
    # holds; grep -q on empty input is false, which is the answer we want.
    printf '%s\n' "$FAST_CHANGED" \
      | grep -qE '^src/|^next\.config|^tailwind|^postcss|^package\.json$' \
      || FAST_UI_CHANGED=false
  fi
fi

# Resolve TEST_DATABASE_POOL_URL so changed integration suites never SKIP on
# a machine that has the DB configured (#643: the gate itself reported SKIP
# and then declared its own result not review-ready).
if [ -z "${TEST_DATABASE_POOL_URL:-}" ] && [ -f .env.local ]; then
  ENV_URL=$(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  [ -n "$ENV_URL" ] && export TEST_DATABASE_POOL_URL="$ENV_URL"
fi

# Point the APPLICATION client at the same test database, and FORCE it.
#
# ci.yml:48 sets DATABASE_POOL_URL and TEST_DATABASE_POOL_URL to the same
# ephemeral Postgres, so a live-DB suite that reaches `src/lib/db/server.ts`'s
# singleton — as the publisher entitlement-linearization suite does through
# `applyTierChange` — finds a real database there. The local gate exported only
# the TEST url, so the singleton fell back to postgres.js's own default
# (localhost:5432) and the row failed ECONNREFUSED: a false RED indistinguishable
# from a genuine failure, which is the same defect class as the promised-tests
# search roots above.
#
# FORCED, not defaulted, and that is the load-bearing half. `.env.local`'s own
# DATABASE_POOL_URL is the PRODUCTION pooler; a shell that had sourced it would
# otherwise hand the gate's test suites a production client. The gate runs
# tests, and no test may reach production, so overriding is strictly safer than
# honouring an inherited value.
if [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
  export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
fi

# Serial DB provisioning — a precondition, never a parallel peer. Fail fast:
# every DB row downstream of a failed provision is noise.
DB_PROVISION_RESULT=""
if [ "$DOCS_ONLY" = false ] && [ "$DB_TOUCHING" = "true" ] && [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
  # Fast mode re-provisions only when a migration moved since the anchor. The
  # last full gate provisioned to head, and `pnpm test:db:setup` replays every
  # migration from a dropped schema — the single most expensive serial step in
  # a DB-touching gate, and pure waste when no migration changed.
  PROVISION_NEEDED=true
  if [ "$FAST_MODE" = true ] && [ -n "$FAST_SINCE" ]; then
    printf '%s\n' "$FAST_CHANGED" | grep -q '^supabase/migrations/' || PROVISION_NEEDED=false
  fi
  if [ "$PROVISION_NEEDED" = true ]; then
    if pnpm test:db:setup > .feature/logs/db-provision.log 2>&1; then
      DB_PROVISION_RESULT="PASS"
    else
      gate_abort "db-provision" \
        "test-DB provisioning failed (tail .feature/logs/db-provision.log); parallel checks not started."
    fi
  else
    DB_PROVISION_RESULT="SKIP"
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
  if [ -n "${HEARTBEAT:-}" ] && [ -f "$HEARTBEAT" ]; then
    jq --arg row "$name" '.rows += [$row]' "$HEARTBEAT" > "${HEARTBEAT}.tmp" \
      && mv "${HEARTBEAT}.tmp" "$HEARTBEAT"
  fi
  (
    "$@" > ".feature/logs/${name}.log" 2>&1
    RC=$?
    echo "$RC" > ".feature/logs/${name}.rc"
    exit "$RC"
  ) &
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
  elif [ "$FAST_MODE" = true ] && [ -n "$FAST_SINCE" ]; then
    # Same `vitest run` the full row uses, narrowed by --changed so the row
    # keeps the project config, setup files and live-DB switches identical.
    # --passWithNoTests is fast-only and load-bearing: an empty change set is
    # the CORRECT answer here (nothing moved since the anchor), but vitest
    # exits 1 on "No test files found" and would report a red gate for it.
    launch test run_full_suite pnpm test --changed "$FAST_SINCE" \
      --passWithNoTests --maxWorkers="$VITEST_WORKERS"
  else
    launch test run_full_suite pnpm test --maxWorkers="$VITEST_WORKERS"
  fi
else
  # #1199: docs-only mode skips the `test` row above (ci.yml's `test` job
  # comment carries the same reasoning), but three src/__tests__ suites read a
  # doc at RUN TIME (DESIGN.md tables, CLAUDE.md, the reference/rules/context/
  # directory tree) and can bust a documentation shape cap on a docs-only
  # branch. Run them here so such a branch can never go green silently. Keep
  # this path list in lockstep with ci.yml's `lint` job "Run doc-reading test suites"
  # step — src/__tests__/ci-audit-wiring.test.ts derives every doc-reading
  # suite from source and fails if the two lanes diverge.
  launch doc-shape pnpm vitest run src/__tests__/reference-shape.test.ts src/__tests__/claude-md-shape.test.ts src/__tests__/design-doc-token-pin.test.ts
fi

# Every ci:* audit from package.json (excluding ci:fallow*).
while IFS= read -r SCRIPT; do
  launch "${SCRIPT#ci:}" pnpm "$SCRIPT"
done < <(jq -r '.scripts | keys[] | select(startswith("ci:")) | select(startswith("ci:fallow") | not)' package.json)

# The build runs for EVERY surface, not only ui/mixed. AGENTS.md requires it
# before any behavior-affecting completion claim, and "backend" is not a
# boundary the build respects: src/lib is shared with the Next.js app, and the
# build catches server/client boundary breaks that typecheck does not. Only a
# docs-only change skips it; fast mode narrows it below.
BUILD_SKIPPED=false
if [ "$DOCS_ONLY" = false ]; then
  if [ "$FAST_MODE" = true ] && [ "$FAST_UI_CHANGED" = false ]; then
    BUILD_SKIPPED=true
  else
    launch build pnpm build
  fi
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
# Search `scripts` and `tests` too, not just src/worker. This is one defect that
# has now been found twice, so treat it as a pattern rather than two accidents:
# a promised title is reported missing whenever its suite lives under a root
# this line does not name, and a false RED there is indistinguishable from a
# genuinely unwritten test.
#   - `scripts`: the CI audits under scripts/ci/ carry their own suites
#     (scripts/ci/__tests__/*.test.ts). Added at #611 (2026-07-28).
#   - `tests`: the LLM-eval suites live at tests/llm-eval/__tests__/. Added by
#     feat/safety-review-auto-approval (plan round-1 finding 13), whose intake
#     promises 13 corpus titles there.
# Adding a root is cheap; the grep is fixed-string and bounded by --include.
#
# Quoting style no longer matters (#1108): promised_title_found
# (scripts/gate-promised-tests.sh) tries the title verbatim and each
# single-character escape a JavaScript test name might spell it with — `\'`
# for a single-quoted name, `\"` for a double-quoted one, `` \` `` for a
# template literal — so a promised title matches regardless of which quoting
# style its test source happens to use.
MISSING_TITLES=""
while IFS= read -r TITLE; do
  [ -n "$TITLE" ] || continue
  promised_title_found "$TITLE" src worker scripts tests && continue
  MISSING_TITLES="${MISSING_TITLES}  - ${TITLE}
"
done < <(jq -r '.tests_to_add[]?' "$INTAKE" 2>/dev/null)
if [ "$DOCS_ONLY" = false ] && jq -e '.tests_to_add | length > 0' "$INTAKE" >/dev/null 2>&1; then
  NAMES+=("promised-tests")
  if [ -n "$MISSING_TITLES" ]; then RESULTS+=("FAIL"); else RESULTS+=("PASS"); fi
fi

# --- reclassify: actual diff vs the intake's per-bucket estimates ---
# Buckets: test (__tests__/, *.test.ts(x), e2e/) vs production (the rest).
#
# `skip` is the workflow's OWN paperwork: files a run is REQUIRED to produce,
# which therefore cannot be scope creep against itself (#643, #1114).
#   docs/superpowers/plans/**            the plan, intake and deviations file
#   docs/reviews/**                      review reports and triage verdicts
#   docs/runbooks/evidence/**            the staging evidence a RISK = high
#                                        branch MUST write before it may ship
#   .claude/reference/arch-review-log.md the row `ci:merge-ledger` makes
#                                        mandatory for every merge touching
#                                        production
#   .claude/reference/lab-notes/**       the durable lesson step 8 asks for
#
# NARROW BY CONSTRUCTION, and the tests are the fence. A runbook that is not
# evidence is production. `.claude/reference/env-vars.md` and
# `migrations-log.md` are production: they are the registry half of a new flag
# or a new migration, so exempting them would hide exactly the scope growth
# this row exists to notice. Only the two files the lane MANDATES are skipped.
reclassify_bucket() {
  case "$1" in
    docs/superpowers/plans/*|docs/reviews/*|docs/runbooks/evidence/*)
      echo skip; return 0 ;;
    .claude/reference/arch-review-log.md|.claude/reference/lab-notes/*)
      echo skip; return 0 ;;
  esac
  if echo "$1" | grep -qE '(^|/)__tests__/|\.test\.tsx?$|^e2e/'; then
    echo test
  else
    echo prod
  fi
}

# Reads a `git diff --numstat` transcript on stdin; echoes "<prod> <test>".
# A FUNCTION rather than an inline loop so the test can run the wiring, not
# only the classifier: the arms below are as easy to swap as the case list is
# to mis-edit, and a source-text assertion catches neither.
reclassify_totals() {
  local prod_lines=0 test_lines=0 adds dels pathname
  # `|| [ -n "$pathname" ]` keeps the LAST line when the transcript has no
  # trailing newline: `read` fills the variables and still returns non-zero at
  # EOF, so a plain `while read` silently drops it. `git diff` always ends with
  # one, which is why the inline version this replaced never showed the bug.
  while IFS=$'\t' read -r adds dels pathname || [ -n "$pathname" ]; do
    [ -n "$pathname" ] || continue
    # git writes `-\t-\t<path>` for a binary blob; counting the dashes as
    # lines would poison both totals.
    case "$adds" in ''|*[!0-9]*) continue ;; esac
    case "$dels" in ''|*[!0-9]*) continue ;; esac
    case "$(reclassify_bucket "$pathname")" in
      skip) continue ;;
      test) test_lines=$((test_lines + adds + dels)) ;;
      *)    prod_lines=$((prod_lines + adds + dels)) ;;
    esac
  done
  echo "$prod_lines $test_lines"
}

RECLASSIFY_MSG=""
if [ "$DOCS_ONLY" = false ] && [ -n "$BASE" ]; then
  PROD_ACTUAL=0; TEST_ACTUAL=0
  read -r PROD_ACTUAL TEST_ACTUAL < <(
    git diff --numstat "$BASE" 2>/dev/null | reclassify_totals
  )

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

# A skipped build is reported, never silent: the row is why this run is cheap,
# and a reader must be able to see it did not run.
if [ "$BUILD_SKIPPED" = true ]; then
  NAMES+=("build")
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
[ "$FAST_MODE" = true ] && GATE_MODE="fast"
printf '{"passed":%s,"mode":"%s","timestamp":%s,"checks":%s}\n' \
  "$PASSED" "$GATE_MODE" "$(date +%s)" "$CHECKS_JSON" > "$STATUS_FILE"
rm -f "$HEARTBEAT"

echo "VERIFY GATE:"
if [ "$FAST_MODE" = true ]; then
  echo "  (fast mode: test narrowed to --changed ${FAST_SINCE:0:8}; build skipped when"
  echo "   nothing it compiles moved. Written to ${STATUS_FILE} — NOT review evidence.)"
fi
if [ "$DOCS_ONLY" = true ]; then
  echo "  (docs-only mode: every changed path is docs/, .claude/, or *.md —"
  echo "   test/build/promised-tests/reclassify/diff-coverage rows skipped;"
  echo "   doc-shape runs the src/__tests__ suites that read a doc at run time)"
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
  if [ "$BASELINE_MODE" = true ]; then
    echo "GATE: GREEN (baseline — phase NOT advanced)"
    exit 0
  fi
  # Fast mode proves the fix, never the branch. It advances no phase, resets
  # no budget, and leaves gate-status.json untouched, so the Stop hook still
  # demands a full green newer than HEAD before this session can finish.
  if [ "$FAST_MODE" = true ]; then
    echo "GATE (FAST): GREEN — run the full gate before review; phase NOT advanced."
    exit 0
  fi
  # Record the green gate in the machine-readable state (lastGreenGateSha
  # snapshot) when this is an armed feature run, and zero the gate-loop
  # fail-round budget — a NEW red streak gets a fresh budget.
  if [ -f .feature/intake.json ] && [ -f scripts/feature-state.sh ]; then
    bash scripts/feature-state.sh set-phase gate_green || true
    bash scripts/feature-state.sh reset-gate-rounds >/dev/null 2>&1 || true
  fi
  echo "GATE: GREEN"
  exit 0
else
  echo "GATE: RED — tails in .feature/logs/<name>.log"
  exit 1
fi
