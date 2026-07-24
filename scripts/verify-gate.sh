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
set -uo pipefail

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
launch test      pnpm test

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

if [ "$PASSED" = "true" ]; then
  echo "GATE: GREEN"
  exit 0
else
  echo "GATE: RED — tails in .feature/logs/<name>.log"
  exit 1
fi
