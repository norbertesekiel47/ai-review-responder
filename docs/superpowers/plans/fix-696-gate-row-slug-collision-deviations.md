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
