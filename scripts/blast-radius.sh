#!/usr/bin/env bash
# scripts/blast-radius.sh — list the importers of every changed production
# source file, so step 7 reviews see caller-side blast radius instead of
# only the diff (typecheck catches signature breaks; it cannot catch a
# semantic change whose callers relied on the old behavior).
#
# The matching lives in scripts/blast-radius-importers.ts (#888): real
# import-specifier nodes from the TypeScript AST, resolved against the
# changed set — the old bare-substring grep reported 82 phantom importers
# for any file named `route.ts`. This wrapper owns only the git plumbing
# and the atomic write of the report.
#
# Plumbing is NUL-delimited (`--name-status -z` / `--porcelain=v1 -z`) so a
# rename contributes BOTH its old and new path (the two formats order the
# pair differently — diff emits old then new, porcelain emits new then old)
# and paths with spaces survive. Importers of a DELETED path are still
# blast radius, so deletions stay in the changed set.
#
# Writes docs/reviews/<branch>/blast-radius.md (committed with the branch,
# handed to the spec & correctness agent as input). The report is rendered
# to a same-directory temp file and renamed into place only when the
# matcher succeeds — a matcher crash must never leave a plausible partial
# report behind a "wrote" line.
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
BRANCH=$(git branch --show-current)
[ -n "$BRANCH" ] || { echo "detached HEAD — run from the feature worktree"; exit 1; }
SLUG=$(printf '%s' "$BRANCH" | tr '/' '-')
BASE=$(git merge-base HEAD origin/main 2>/dev/null || true)
OUT="docs/reviews/${SLUG}/blast-radius.md"
mkdir -p "$(dirname "$OUT")"

# The matcher is resolved relative to THIS script, not the cwd, so the
# wrapper still works when invoked in a worktree (or a test's temp repo)
# that has no node_modules of its own. Overridable for the failure-path test.
SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MATCHER_CMD=${BLAST_RADIUS_MATCHER_CMD:-"${SCRIPT_DIR}/../node_modules/.bin/tsx ${SCRIPT_DIR}/blast-radius-importers.ts"}

CHANGED=()
add_changed() {
  case "$1" in
    src/*|worker/*) ;;
    *) return ;;
  esac
  case "$1" in
    *__tests__*|*.test.ts|*.test.tsx) return ;;
  esac
  case "$1" in
    *.ts|*.tsx) CHANGED+=("$1") ;;
  esac
}

# Branch diff: records are STATUS\0path\0, except renames/copies which are
# STATUS\0old\0new\0 — include both ends of the pair.
if [ -n "$BASE" ]; then
  while IFS= read -r -d '' STATUS; do
    IFS= read -r -d '' P1 || break
    case "$STATUS" in
      R*|C*)
        IFS= read -r -d '' P2 || break
        add_changed "$P1"
        add_changed "$P2"
        ;;
      *) add_changed "$P1" ;;
    esac
  done < <(git diff --name-status -z "$BASE")
fi

# Working tree: records are `XY path\0`, except index renames/copies which
# are `XY new\0old\0` — note the pair order is REVERSED vs `git diff` above.
while IFS= read -r -d '' REC; do
  XY=${REC:0:2}
  P1=${REC:3}
  case "$XY" in
    R*|C*)
      IFS= read -r -d '' OLD || break
      add_changed "$P1"
      add_changed "$OLD"
      ;;
    *) add_changed "$P1" ;;
  esac
done < <(git status --porcelain=v1 --untracked-files=all -z)

# Same-directory temp file: `mv` across filesystems degrades to
# copy-and-delete, which is not atomic — beside the destination it is a
# rename. The trap clears it on any failure path.
TMP=$(mktemp "${OUT}.tmp.XXXXXX") || exit 1
trap 'rm -f "$TMP"' EXIT

# `${CHANGED[@]+…}` is the bash 3.2 spelling for a possibly-empty array
# under `set -u`; printf with zero args would emit one spurious empty
# record, so the empty case feeds the matcher /dev/null instead.
if [ "${#CHANGED[@]}" -gt 0 ]; then
  printf '%s\0' ${CHANGED[@]+"${CHANGED[@]}"} | sort -zu | $MATCHER_CMD --branch "$BRANCH" > "$TMP"
else
  $MATCHER_CMD --branch "$BRANCH" < /dev/null > "$TMP"
fi
MATCHER_STATUS=$?
if [ "$MATCHER_STATUS" -ne 0 ]; then
  echo "blast-radius: importer matcher failed (exit ${MATCHER_STATUS}) — report NOT written" >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "wrote $OUT"
