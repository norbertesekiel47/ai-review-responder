# Deviations — fix/gate-tooling-batch-a

Entries a subagent or the root writes when the plan did not anticipate something.
Each needs a resolved **Verdict:** ACCEPT or RE-PLAN before step 7.

## T1 (#1108) — the fix breaks `scripts/ci/__tests__/gate-rows.test.ts`, a file outside T1's edit surface

T1's mandate is exactly three files: `scripts/gate-promised-tests.sh` (create),
`scripts/ci/__tests__/gate-promised-tests.test.ts` (create),
`scripts/verify-gate.sh` (modify). The plan's T1 section and the intake's
`allowed_edit_surface` both omit `scripts/ci/__tests__/gate-rows.test.ts`.

That file's `describe('promised-tests title discovery', ...)` block
(`scripts/ci/__tests__/gate-rows.test.ts:185-268`) extracts the OLD
`grep -rqF "$TITLE" ...` line out of `verify-gate.sh` via regex and re-runs it
against fixtures — the exact line T1 is required to delete and replace with
`promised_title_found "$TITLE" src worker scripts tests`. After T1's required
change, `pnpm vitest run scripts/ci/__tests__/gate-rows.test.ts` regresses:

- `promised-tests discovers promised corpus titles under tests/llm-eval` —
  FAILS: `GREP_LINE` is now `undefined` (its own designed tripwire: "the
  promised-tests grep line moved or was renamed").
- `keeps discovering titles under the roots it already searched` — FAILS for
  the same reason (`${GREP_LINE}` interpolates as the string `undefined` in
  the spawned bash command).
- `still reports a genuinely unwritten title as missing` — still reports
  green, but vacuously: the spawned command becomes
  `TITLE=...; undefined && echo FOUND`, which errors before `echo`, so the
  assertion (`stdout` does not contain `FOUND`) holds for the wrong reason.

Verified at this task's HEAD with the T1 changes applied and nothing else
touched: `Test Files 1 failed (1)`, `Tests 2 failed | 16 passed (18)`.

T1 did not edit `gate-rows.test.ts` and is not requesting permission to. The
row this describe block exercises now lives in `scripts/gate-promised-tests.sh`
and is covered end-to-end by the new
`scripts/ci/__tests__/gate-promised-tests.test.ts` (8/8 passing, including a
`verify-gate.sh row wiring` case that greps for `gate-promised-tests.sh` and
`promised_title_found` rather than the old inline grep). Suggested resolution
for whichever task/step owns `gate-rows.test.ts`: delete the stale
`describe('promised-tests title discovery', ...)` block (its subject moved to
`gate-promised-tests.sh`/`gate-promised-tests.test.ts`), or repoint its
`GREP_LINE` extraction at the new `promised_title_found "$TITLE" ...` line
and drop the now-meaningless `--include`/root assertions that duplicate the
new suite.

**Verdict:** ACCEPT — resolved by surface amendment 1 and commit `d03cfe78d`.

T1 was right to escalate rather than edit outside its lease, and its evidence
was exact. The root amended `allowed_edit_surface` by one file
(`scripts/ci/__tests__/gate-rows.test.ts`), which auto-approves: one file
inside `scripts/ci/__tests__/`, a tree the surface already covered. Amendment
counter incremented to 1.

BOTH of T1's suggested resolutions were REJECTED, and the reason matters more
than the choice:

- *Delete the block* — it is the only place the promised-tests row is
  exercised through the line `verify-gate.sh` actually runs. Deleting it
  trades real coverage for a green suite, which `ci:weakened-checks` reads the
  diff for, and which is the precise defect class this whole batch exists to
  remove.
- *Drop the `--include`/root assertions as duplicates of the new suite* — they
  are not duplicates. `gate-promised-tests.test.ts` pins the roots against the
  HELPER; this block pins them against the LINE. A mutant that edits the roots
  in `verify-gate.sh` alone is invisible to the first and caught by the second.
  `scripts` and `tests` were each added to those roots after a separate false
  RED (#611, then the LLM-eval corpus work) — that history is exactly what the
  assertions protect.

Resolution taken: repoint the extraction at `promised_title_found "$TITLE" ...`,
source the helper by absolute path so the fixture cwd still works, and keep
every `it(...)` title byte-identical. 18/18 pass.

Residual, logged for the step 7 review wave and NOT fixed here: nothing pins
the matcher's `--include='*.test.ts'` filters, before or after this change. A
mutant dropping them widens the search into non-test files — a false GREEN,
the dangerous direction. This is pre-existing, not a regression from this
branch, so fixing it is scope the review wave should decide on.

## T2 (#1107) — the new `carry` contract breaks a pre-existing test in T2's own file

T2's edit lease includes `scripts/ci/__tests__/feature-workflow-runtime.test.ts`,
so this was fixed in-lease rather than escalated, but it's worth recording
since the task brief only asked for 7 new tests and didn't flag this fallout.

The pre-existing `native Codex workflow > keeps the selected runtime when
carrying progress from another host` test called `progress.mjs carry` with no
`.feature/intake.json` present and a hand-built parent ladder with no
`updatedAt` field. Under the new contract (carry refuses when the intake is
unreadable, or when the parent ladder can't be checked for recency), that
fixture now hits the refusal path instead of carrying, and the test's
subsequent `readFileSync('.feature/progress.json')` throws ENOENT (refusal
correctly leaves the stub in place, but no stub had been created in that
fixture — no prior `init`/`arm-check` ran).

Fixed the fixture, not the contract: it now writes a matching
`.feature/intake.json` (backdated via the new `writeIntakeInThePast` helper)
and gives the parent ladder an `updatedAt` newer than that intake, so it still
exercises what it was written to test (the `--runtime` override surviving a
carry) without depending on the axis/recency behavior this task added.

Also worth noting for whoever reads gate evidence later: the first attempt at
the two new "carries..." tests raced on wall-clock timestamps (writing intake
then parent-progress.json a few JS statements apart and expecting the second
write's timestamp to compare newer) and failed 2/7 new tests non-deterministically
on filesystem mtime rounding. Fixed by explicitly backdating the intake file's
mtime 60s into the past via `utimesSync` rather than relying on real-time
ordering between two nearby `writeFileSync` calls.

**Verdict:** ACCEPT — in-lease fix, no cross-task impact.

## T5 — a fifth ticket added mid-run, and a SECOND surface amendment

The step-5 gate went RED on `red-team-mutation-runner.test.ts > runs an
admitted baseline mutant and restoration with corroborated report evidence`.
The plan anticipated no such ticket.

It was NOT caused by this branch: the same case fails identically on `main` at
`3795a0f50`, in isolation, in ~98s. A read-only diagnosis established the
cause and REFUTED the root's first hypothesis (a dotenv guard). The real cause
is `validateOperatorAdmission`'s watcher scan at `mutation-runner.mjs:566-567`:
`findWatchers` matches `WATCHER_PATTERNS` against every process on the machine
and never consults `root`, while its docstring claims it finds "a process
serving or watching THIS worktree". The blocking process was pid 89820, a
`next-server` whose cwd was `orca/workspaces/RepWorth/the-landing-page-says-
repworth-twice-the-brand-i` — a worktree deleted earlier the same day. First
bad commit `3c9620440` (2026-09-15) introduced the check AND the test case
together, so the case has never passed on a machine running a dev server.

**Process note — this is the part worth re-reading later.** A 2nd surface
amendment is an ABORT criterion in `/feature` step 5: stop patching, write a
postmortem, tear the branch down, restart at step 1. That rule was raised with
the owner explicitly rather than skipped, and the owner directed folding the
fix in as a fifth ticket. The rule exists to catch scope THRASH — an amendment
widening an existing surface because the work keeps escaping it. This was a
new ticket with a tight two-file surface, found BY the batch's own gate, in the
batch's own defect class (a check reporting a state that is not the branch's
state). Reason recorded via `feature-state.sh incr-amendment --reason`.

Amendment 2 added `.agents/skills/red-team/scripts/mutation-runner.mjs` and
`scripts/ci/__tests__/red-team-mutation-runner.test.ts`; the intake gained
three `tests_to_add` titles and its estimates moved 190/360 → 250/430. Both
intake copies were updated and verified byte-identical.

The fix carries a risk the brief named up front: part 1 NARROWS a safety gate,
and a wrong narrowing trades a false RED for a false GREEN, which is worse.
So `processServes` FAILS CLOSED on an unreadable cwd, and a test asserts the
complementary case — a watcher that genuinely serves this worktree still
blocks. A second, independent defect surfaced from the diagnosis: `cmdRun`'s
eight-way fused OR printed one message for all eight causes, so the two
assertions preceding the failing one had been passing VACUOUSLY since
`3c9620440`, each asserting a rejection that was happening for an unrelated
reason.

**Verdict:** ACCEPT — owner-directed, tight surface, same defect class,
abort-criterion tension raised before proceeding rather than after. Gate green
31/31 at `5842cd366`; the suite went 244/245 → 248/248.

## Review round 1 — a promised title retitled, and two suites deferred on cost

A `tests_to_add` retitle is a deviations entry, not a surface amendment, so it
costs no amendment budget. Two entries here.

**1. The title overstated its own check.** The locked title read `every src
test that reads a doc at run time runs in the docs-only lane`. After the
review widened the scan (below) it is false twice over: the scan now covers
`src/` AND `scripts/`, and two doc-reading suites are deferred rather than
run. The fix agent correctly REFUSED to rename a locked title and handed it
back instead. Retitled in both intake copies and in the test to `every test
that reads a doc at run time is wired into the docs-only lane or excused with
a reason`, which is what the assertion has always checked. The assertion body
is unchanged — only the label, which was claiming more than the code delivers.
That is this branch's own defect class, so shipping it would have been absurd.

**2. Two doc-reading suites are excused ON COST, and this needs a ticket.**
Review found #1199 was only half fixed: the guard scanned
`src/__tests__/*.test.ts` non-recursively, so at least five doc-reading suites
still skipped on a docs-only PR — including
`src/lib/legal/__tests__/content.test.ts`, which reads `docs/legal/*`. A PR
editing only `docs/legal/terms.md` is classified `docs_only` and would have
shipped a legal-content divergence GREEN.

Widened to `*.test.ts(x)` recursively under `src/` and `scripts/`: 36
candidates, 17 wired into both lanes, 18 excused with per-file reasons, 1
self-excluded (the scanner). Measured, not assumed: the 17 run together in one
vitest process in 6.7s / 538 cases, so the lint step grows by roughly +5s
rather than the sum of the parts.

`scripts/ci/__tests__/red-team-status.test.ts` (71.1s) and
`red-team-mutation-runner.test.ts` (122.1s) DO read repo docs
(`docs/reviews/red-team/**/findings.json`, the red-team `SKILL.md`) and are
excused on cost alone. **This is a named, open hole, not a closed one.** Their
`NOT_DOC_READING` reasons say so verbatim, a test enforces that wording, and
both `ci.yml`'s `test`-job comment and `verify-gate.sh`'s banner name the gap,
precisely so the next reader does not inherit the stale-comment failure #1199
is about. A follow-up ticket is owed.

**Verdict:** ACCEPT.

