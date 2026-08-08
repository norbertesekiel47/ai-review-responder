# Deviations — fix-696-gate-row-slug-collision

Entries the intake did not anticipate. Each carries a triage verdict (step 6).

---

## D1 — two test titles added beyond the locked `tests_to_add` (five → seven)

**What.** Added `"accepts the first row name when no rows are registered yet"`
and `"registers every launched row through assert_unique_row_name"`.

**Why.** The first covers the bash-3.2 trap at the new call site: `set -u` is on
in `verify-gate.sh`, and `"${NAMES[@]}"` on an *empty* array errors on macOS's
bash 3.2 — the `${NAMES[@]+"${NAMES[@]}"}` spelling is load-bearing for the very
first `launch lint` call and nothing else would have caught a regression there.
The second closes a real gap: the intake's five titles proved `row_slug` and
`assert_unique_row_name` in isolation but nothing asserted that
`verify-gate.sh`'s `launch()` actually *calls* the assert — the function could be
correct and unwired, which is precisely the #696 theme (a check that structurally
cannot see what it claims to enforce).

Per the workflow this is a deviations-file entry, not an `allowed_edit_surface`
amendment; both intake copies were updated so `promised-tests` stays the honest
drift detector.

**Verdict:** ACCEPT.

---

## D1b — review round 1 replaced the wiring test with behavioural coverage

**What.** D1's second title, `"registers every launched row through
assert_unique_row_name"`, asserted verify-gate.sh's *source text*. The spec
review reproduced a mutant whose `launch()` asserted uniqueness over
`${PIDS[@]}` instead of `${NAMES[@]}` — every duplicate detection disabled, and
that test still passed 7/7. It was deleted and replaced with three tests that
run the REAL `launch` / `gate_abort` bodies (extracted from verify-gate.sh with
`sed`) plus one that runs the real gate with its library removed.

**Lesson (promote to lab notes at step 8).** A "is it wired?" test written
against source text is the same defect class as the bug it guards: it cannot
see what it claims to enforce. If the function is cheap to invoke, invoke it.

**Verdict:** ACCEPT.

---

## D2 — `gate_abort()` extracted; the db-provision abort now calls it

**What.** The intake scoped the change to row identity. The duplicate-name abort
needed the same "write a RED `gate-status.json`, print the table, exit 1"
sequence the db-provision failure path already open-coded, so that block became
a function used by both call sites (net −2 lines at the db-provision site).

**Why it matters beyond tidiness.** Aborting *without* writing
`gate-status.json` would leave the previous run's green file on disk, and
`.claude/hooks/stop-gate.sh` reads that file — a stale green satisfying the Stop
hook is the same silent-success class the ticket is about. `gate_abort` also
kills already-launched detached children (`kill $(jobs -p)`), which the
db-provision path never needed because it aborts before any `launch`.

**Verdict:** ACCEPT — second use, and the shared behaviour is a correctness
requirement rather than a convenience.

---

## D3 — `scripts/gate-rows.sh` is not added to `docs/directory.md`

**What.** CLAUDE.md's working rules say to check `docs/directory.md` before a new
file. The `scripts/` table there is scoped to TypeScript operational scripts
("Run with `tsx scripts/<name>.ts`") and lists **none** of the twelve existing
`.sh` files — `verify-gate.sh`, `feature-setup.sh`, `new-worktree.sh` and the
rest are all absent.

**Why.** Adding a row for this one shell library and no other would misrepresent
the table's scope. Left for the post-merge `document-feature` sweep to decide as
a whole, if shell scripts should be inventoried at all.

**Verdict:** ACCEPT.

---

## D4 — `echo` → `printf` in the slug's `tr` input (behaviour change, deliberate)

**What.** The old sites piped `echo "$FILE"` into `tr`, so the trailing newline
became a trailing `-` on every slug shorter than 40 characters.
`row_slug` uses `printf '%s'`, dropping it.

**Why.** Cosmetic-looking, but it is why the truncation boundary was ambiguous:
a 39-character path and a 40-character path could both end in `-`. No consumer
reads row names (`arm-check.sh` and `.claude/hooks/stop-gate.sh` read only
`passed` from `gate-status.json`), so the rename is free.

**Verdict:** ACCEPT.

---

## D5 — the fix had to grow past row identity to keep its own invariant

**What.** Review round 1 found three blocking defects, all in code the intake
did not scope but the fix itself created:

- `gate-rows.sh` ran `exit 1` at **source** time when no `shasum`/`sha1sum` was
  on PATH. A sourced file's `exit` terminates the caller — so the gate died
  *before* `gate_abort` existed, leaving the previous run's `{"passed":true}` on
  disk for `.claude/hooks/stop-gate.sh` to read. The fix's own locked invariant
  ("the gate never exits with a stale-green gate-status.json") was violated by
  the fix. `gate_abort` is now defined **before** the source; the library sets
  no variable and returns; the caller aborts through `gate_abort`.
- A library that failed to load surfaced as a **bogus duplicate-row abort**:
  with `assert_unique_row_name` undefined, `launch` read exit 127 as a collision
  and named an innocent row. A post-source `command -v row_slug` guard now
  reports the real cause, and `CDPATH=` hardening on the `cd` that resolves the
  script directory closes one way to reach that state.
- The rejected-destructive-extra path registers its row via `NAMES+=` and never
  reaches `launch`, so it bypassed the assert entirely. Two *identical*
  `verification_commands` derive the same slug — the one collision `row_slug`
  structurally cannot separate. That path now asserts its own name, and
  `REJECTED_EXTRAS` became an array (deleting the newline-delimited-string
  round-trip).

**Why recorded rather than re-planned.** All three are defects *in the fix*, on
paths the intake already named; none contradicts a locked decision and the edit
surface did not move. Under the abort criteria this is round 1 of 3, not an
amendment.

**Verdict:** ACCEPT.

---

## D6 — `kill $(jobs -p)` in `gate_abort` is best-effort, and the comment said otherwise

**What.** The original comment claimed the kill reaps `pnpm build` and the full
vitest suite. The review reproduced that it does not: `( run_full_suite … ) &`
is a real subshell, so `kill` reaches the subshell while its `pnpm`/`node`
grandchildren survive.

**Why not fixed properly.** Per-row process groups need job control (`set -m`),
which changes the `jobs -rp` throttle the whole fan-out is built on — a real
regression risk on a path that only executes when the gate itself has a bug in
it. The comment now states what the call actually does.

**Verdict:** ACCEPT (comment corrected, behaviour deliberately unchanged).

---

## D7 — `reclassify` WARN fired; step 0 re-run; lane unchanged

**What.** After the round-1 fixes the gate reported production 147 vs an
`estimated_prod_lines` of 65, and test 183 vs 80 — both ~2.3x, tripping the
re-classification trigger.

**Step 0 re-run with the real numbers.** SIZE = **small**, unchanged: 147
production lines (≤ ~150), 3 code files (≤ ~3), one seam, no migration, no new
dependency. RISK = normal and SURFACE = backend are untouched. Estimates
corrected to 150 / 200 so the detector is honest for any further rounds.

**Why the estimate was wrong.** It was written before review round 1, which
found three blocking defects (D5) whose fixes are real production code —
`gate_abort` reordering, the post-source load guard, and the rejected-extras
assert — plus the behavioural tests that replaced the text-assertion one (D1b).
The estimate underran because the *fix* grew, not because the lane was wrong;
the SMALL-path controls (single session, one review axis, no staging ride) were
the right ones throughout.

`allowed_edit_surface` was never amended — 0 of the 2-amendment abort budget
used.

**Verdict:** ACCEPT.
