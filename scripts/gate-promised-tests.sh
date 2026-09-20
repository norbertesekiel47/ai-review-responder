#!/usr/bin/env bash
# scripts/gate-promised-tests.sh — promised-title matching for the /feature
# verify gate's promised-tests row (#1108).
#
# verify-gate.sh's promised-tests row checks every tests_to_add title from
# .feature/intake.json against the test sources under src, worker, scripts
# and tests. A JavaScript single-quoted test name spells an apostrophe as
# `\'` in source (a double-quoted name spells a literal quote as `\"`, a
# template literal spells a backtick as `` \` ``), but the intake promises
# the title's UNESCAPED text. Grepping the promised title verbatim therefore
# misses a test that exists, passes, and was mutation-verified — the row can
# only ever UNDER-report, and the failure reads as unwritten work rather than
# a quoting mismatch. This file tries the title's escaped spellings too, so a
# promised title matches regardless of which quoting style its test source
# happens to use.
#
# This lives in its own file for the same reason as scripts/gate-rows.sh:
# bash has no in-file unit-test seam, and sourcing verify-gate.sh would RUN
# the gate. scripts/ci/__tests__/gate-promised-tests.test.ts sources THIS
# file and calls its functions directly.
#
# NEVER `exit` from this file. It is SOURCED. An `exit` would take the gate
# down before it could record a RED .feature/gate-status.json, leaving the
# previous run's green file on disk for .claude/hooks/stop-gate.sh to read as
# this run's result. Signal failure with `return`, never `exit`.

# promised_title_spellings <title>
#   Prints the candidate spellings, one per line, most literal first:
#     1. T verbatim.
#     2. T with every  '  replaced by  \'   (source used a single-quoted name)
#     3. T with every  "  replaced by  \"   (source used a double-quoted name)
#     4. T with every  `  replaced by  \`   (source used a template literal)
#     5. T with every  \  replaced by  \\   (source escapes a literal
#        backslash the same way no matter which quote character wraps the
#        string, so this candidate is orthogonal to 2-4, not another
#        quote style)
#   Each candidate is emitted exactly once: if T contains none of a given
#   quote character (or, for #5, no backslash), that candidate is identical
#   to T verbatim and is skipped rather than reprinted.
#
#   Adding a candidate can only ever ADD a match, never manufacture a false
#   one: promised_title_found ORs plain `grep -F` lookups of fixed strings
#   derived only from T itself, so a new candidate either finds a substring
#   that is genuinely present in a test file or finds nothing — it can never
#   turn an absent title into a false GREEN.
#
#   This is the internal seam: the gate does not call it, the test suite
#   does. promised_title_found is the only entry point verify-gate.sh uses.
promised_title_spellings() {
  local title="$1"
  local apostrophe="'" escaped_apostrophe="\\'"
  local quote='"' escaped_quote='\"'
  local backtick='`' escaped_backtick='\`'
  local single="${title//$apostrophe/$escaped_apostrophe}"
  local double="${title//$quote/$escaped_quote}"
  local btick="${title//$backtick/$escaped_backtick}"
  # The doubled-backslash candidate is built with sed, NOT with bash's
  # ${var//pat/rep}, because that construct is not version-stable when the
  # REPLACEMENT text is a backslash — and macOS ships bash 3.2 while CI runs
  # bash 5.x, so the local gate cannot see the difference at all.
  #
  # Measured on bash 3.2.57 (macOS /bin/bash) and bash 5.2.15 (linux), for
  # the title `a \ b escape`:
  #   ${title//"$bs"/$esc}    3.2 → `a \\ b escape`    5.2 → `a \ b escape`
  #   ${title//"$bs"/"$esc"}  3.2 → `a "\\" b escape`  5.2 → `a \\ b escape`
  #   printf … | sed          3.2 → `a \\ b escape`    5.2 → `a \\ b escape`
  # bash >= 4.3 performs backslash processing on the unquoted replacement, so
  # `\\` collapses to `\`, the candidate then equals the title, the guard
  # below suppresses it, and no backslash candidate is ever emitted (#1345).
  # Quoting the replacement is NOT the fix: bash 3.2 inserts the quote
  # characters themselves. sed is byte-identical on both, and on BSD and GNU
  # sed alike, so no bash version can change this candidate.
  #
  # The three quote candidates above are left on ${var//pat/rep}: their
  # replacements (`\'`, `\"`, `` \` ``) are a backslash before a character
  # bash's replacement processing does not consume, and both versions emit
  # them identically. promised_title_spellings' candidate-list test asserts
  # the exact emitted list, so any future divergence in ANY candidate shows
  # up as a missing line rather than as a silent false from the matcher.
  local bslash
  bslash=$(printf '%s' "$title" | sed 's/\\/\\\\/g')

  printf '%s\n' "$title"
  [ "$single" = "$title" ] || printf '%s\n' "$single"
  [ "$double" = "$title" ] || printf '%s\n' "$double"
  [ "$btick" = "$title" ] || printf '%s\n' "$btick"
  [ "$bslash" = "$title" ] || printf '%s\n' "$bslash"
}

# promised_title_found <title> <root>...
#   Exit 0 when any candidate spelling of <title> (see promised_title_spellings
#   above) appears in a test file under any of <root>...; exit 1 otherwise.
#   Prints nothing.
#
#   Normalization only ADDS candidate spellings — it never rewrites the
#   searched files, so a title genuinely absent from every root still fails.
#
#   SECURITY: <title> is author-written text from .feature/intake.json, never
#   trusted as shell. Every candidate reaches grep as a fixed string through
#   -F and a quoted argument — never eval, never an unquoted expansion. A
#   title containing `$(touch pwned)` or a backtick is searched for LITERALLY
#   and runs nothing.
promised_title_found() {
  local title="$1"
  shift
  local candidate
  while IFS= read -r candidate; do
    grep -rqF "$candidate" --include='*.test.ts' --include='*.test.tsx' "$@" 2>/dev/null && return 0
  done < <(promised_title_spellings "$title")
  return 1
}
