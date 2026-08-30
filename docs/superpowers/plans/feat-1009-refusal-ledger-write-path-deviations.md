# Deviations — feat/1009-refusal-ledger-write-path

**Twelve entries.** Twelve ACCEPT, zero RE-PLAN.

| # | What | Verdict | One line |
|---|---|---|---|
| D1 | Surface overlap with the parked `feat/refusal-log` worktree | **ACCEPT** | No merge order exists to agree — the branch never merges. It is a read-only harvest source. |
| D2 | Surface amendment 1 of 2 — `AutonomyGovernorScheduler.ts` | **ACCEPT** | Owner-approved. The intake's observability claim was false; the code changed rather than the claim. |
| D3 | `tests_to_add` grew 19 → 26 → 28 across plan review rounds 1 and 2 | **ACCEPT** | Test-title additions are deviations, not amendments. Nine wrong implementations passed the first nineteen. |
| D4 | Round 2 found four defects that round 1's own FIXES introduced | **ACCEPT** | Two of them are one mistake twice: a lesson applied to the code that prompted it, not to the code the fix wrote. |
| D5 | Round 3 disproved a claim a rejection rested on, and found the SAME warning path wrong a third time | **ACCEPT** | Three rounds, three different bugs in one five-line warning. The pattern, not any one bug, is the lesson. |
| D6 | T1's eval FIXES three API names the plan described but never spelled, and forces test 20's rejection through the vocabulary map | **ACCEPT** | A RED eval is the API's first caller; T3 and T4 now have identifiers to bind to rather than a description to guess from. |
| D7 | T2 narrowed the parked map's `\| null` | **ACCEPT** | The brief said "carried unchanged" and was loose. `null` is a decision other lanes record, not a state this one can reach. |
| D8 | `tenant-scope-allowlist.ts` has an `ALLOWLIST_BASELINE` count the plan never mentioned | **ACCEPT** | A ratchet: a silent append fails CI. Undocumented step, now documented. |
| D9 | The plan's arm-11 SQL could not pass its own test 24 | **ACCEPT** | The eval wins over the plan. `FOR UPDATE SKIP LOCKED` moved before `LIMIT`; `EXPLAIN` measured byte-identical. |
| D10 | The eleventh arm broke a pre-existing UNIT test that counts arms | **ACCEPT** | T5 reported rather than reached across the wave; the orchestrator fixed it serially. 26/26 green. |
| D11 | `ci:directory-map` needs `docs/directory.md` rows T2 could not write | **ACCEPT** | Already T6's job. Recorded so the gate's dependency on T6 is explicit. |
| D12 | The D16 sweep table was short THREE times — inside D16's own sweep | **ACCEPT** | Counting is not a thing you do once. A branch writing new copies has a moving target. |

---

## D1 — `src/lib/refusals/**` overlaps the parked `feat/refusal-log` worktree

**When:** step 2, `feature-setup.sh` overlap report, before planning.

`scripts/feature-setup.sh` reported two code-pair collisions:

| Ours | Theirs |
|---|---|
| `src/lib/refusals/**` | `src/lib/refusals/vocabulary.ts` |
| `src/lib/refusals/**` | `src/lib/refusals/read.ts` |

plus one unlisted test-glob overlap.

**Why this needs no merge order.** The overlap check assumes both branches are
heading for `main`. `feat/refusal-log` is not. It is PARKED by owner decision
(2026-08-29), recorded on map #994:

> `feat/refusal-log` is **PARKED, not merged** (owner call, 2026-08-29). It is
> the reference implementation and the harvest source … It will drift against
> `main` — that is accepted.

A merge order is an agreement about which of two branches lands first. Neither
half of that question applies when one branch never lands.

**What this run does with those two files instead.** It reads them through
`git show feat/refusal-log:<path>` and writes nothing to that worktree.

- `vocabulary.ts` is **harvested and corrected**, never copied. Its two closed
  axes are wrong against the schema that actually shipped: six lanes where
  migration 116 admits seven (`policy_gate_held` joined in #1003) and seven
  categories where 116 admits eight (`owner_review_required` coined in #998).
  `RENDER_WITHHOLD_REASONS` is dropped rather than ported — it existed only to
  partition `read.ts`'s timestamp anchor, and #1002 killed `read.ts`.
- `read.ts` **survives nothing**. #1002 ruled there is no backfill, ever, so its
  six `UNION ALL` arms have no second life and the file dies with the projection.

**The surface is not narrowed.** This slice creates `src/lib/refusals/` on
`main` for the first time, and a glob is the honest declaration of a directory
this run owns end to end.

**Verdict:** ACCEPT. Recorded here only. The parked branch's own deviations file
is a closed record of a STOPPED run; appending a merge-order note to it would
require committing to a branch this run must not touch, and would record an
agreement that does not exist.

---

## D2 — surface amendment 1 of 2: `AutonomyGovernorScheduler.ts`

**When:** plan review round 1, finding 2 (`medium`). Owner-approved 2026-08-30.
**Counted mechanically:** `bash scripts/feature-state.sh incr-amendment` →
`surfaceAmendments=1`.

`suspendAccountAutonomy` has two production callers, and they reach Sentry by
different routes. `JudgeWorker` is a BullMQ worker, so `attachJobFailureSink`
raises an issue on the terminal attempt. `AutonomyGovernorScheduler` is a
guarded poll, **not** a BullMQ worker, and its per-candidate `catch` emitted
`logger.error` alone.

Before this slice that gap was latent. This slice makes a ledger CHECK violation
a new way to reach it, and the shape is bad: the transaction rolls back, the
account **stays un-suspended**, the cursor advances, and the same thing repeats
silently every fifteen minutes on the autonomy *safety* lane.

**The intake's `observability` field claimed `attachJobFailureSink` covered
this. That was false.** One of two things had to change — the code or the claim.

**Both changed.** The owner chose the code: add `Sentry.captureException` inside
the existing `catch`, ~10 lines, containment untouched. The intake's
`observability` entry is also rewritten to state the two-caller asymmetry
explicitly, because the next reader needs the fact, not the fix.

Why this is not scope creep: the amendment is bounded to one `catch` block in
one file, it adds no branch and removes none, and it is the minimum that makes a
locked intake claim true. Widening it — reworking the containment, the cursor
advance, or the logged error class — is explicitly a non-goal.

**Verdict:** ACCEPT.

---

## D3 — `tests_to_add` grew from nineteen to twenty-eight

**When:** plan review round 1, findings **1, 2, 3, 4, 5, 8 and 9** — seven, not
the six an earlier draft of this section claimed (round 2, defect 4; finding 2
was the omitted one, and test 21 is its test). Then round 2 added two more.
Not an amendment —
`allowed_edit_surface` is the only field the amendment budget counts, and test
titles are recorded here instead (the #643 precedent, where two test renames
nearly triggered a teardown).

The review's brief asked one question: *can this eval pass while the feature is
still wrong?* It answered yes, **nine** times across two rounds. Each new test
names one wrong implementation an earlier list admitted:

| New test | Wrong implementation it admits otherwise |
|---|---|
| 6 — compile-time required `occurredAt` | `occurredAt?: …` defaulting to `NOW()`; every runtime test supplies the field |
| 8 — false→true→false in one process | the flag read cached at module construction |
| 10 — throwing Sentry capture | telemetry aborting the disabled path, breaking "byte-identical" |
| 20 — forced rejection, full rollback | a helper that catches the insert error, or one that ignores `tx` |
| 21 — Governor cycle raises an issue | D2's gap |
| 23 — crossed retention clocks | a sweep keyed on `created_at`; aged-together fixtures answer identically under both clocks |
| 26 — no `.todo`/`.skip`/`.fails` | an entirely inert eval — `promised-tests` greps titles only |
| 27 — throwing Sentry in the Governor catch | telemetry added to observe a CONTAINED failure turning it into an uncontained one (round 2) |
| 28 — throw once, then recover | one transient capture failure buying permanent silence about a ledger gap (round 2) |

**Finding 1 is the one worth promoting past this branch.** The gate's
`promised-tests` row proves a title EXISTS, never that it RUNS. Every future
`/feature` run can satisfy its whole eval with `it.todo`. Queued for step 8
promotion into the lab notes.

`estimated_test_lines` moves ±950 → ±1350; `estimated_prod_lines` ±520 → ±540
for D2. Both intake copies updated and verified byte-identical with `cmp`.

**Verdict:** ACCEPT.

---

## D4 — round 2 found four defects that round 1's own FIXES introduced

**When:** plan review round 2 (verification-only), against commit `eaa0545d`.
Full report: `docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r2.md`.
Triage table: plan §5c.

Round 2's job is to check that round 1's findings were addressed and to catch
defects the fixes created. It did both: eight ADDRESSED, two PARTIAL, the
rejection of finding 6 confirmed SOUND — and **four new defects, none of which
existed before round 1's fixes**.

**Two of the four are the SAME mistake, made twice, and that is the durable
lesson here.**

Round 1's finding 9 states a rule: *telemetry must never poison the path it
observes.* Then:

- **Fix 2** (the Governor Sentry sink) added a `captureException` **inside a
  containment `catch`** with no guard of its own. A throwing Sentry would
  propagate out of the handler whose entire purpose is containment, abort the
  cycle, and skip every remaining candidate. The fix for an observability gap
  created an availability bug in the code it was observing.
- **Fix 9** (the guarded emission) obeyed the rule but chose "latch before
  emit", which prevents spam by trading it for **permanent silence**: one
  transient capture failure and the only evidence a ledger gap exists is gone
  for the process life.

Neither is careless. Both come from applying a lesson to the code that *prompted*
it and not to the code the *fix wrote*. That is #1008's D15 — *in this repo a
fix is a SWEEP, never an edit* — recurring in code rather than in prose, and it
is the sharper form of it: **the sweep has to include the diff you just wrote.**

The other two defects are counting errors of the same family D15 names: "six
files" over a seven-row map, and "six wrong implementations" over a seven-row
table.

**Queued for step 8 promotion**, as the run's primary lesson: after fixing a
review finding, re-run the finding's own rule against the fix.

**Verdict:** ACCEPT. All four corrected; `tests_to_add` 26 → 28.

---

## D5 — round 3 disproved a claim a rejection rested on, and found the same warning path wrong a third time

**When:** plan review round 3, the protocol's final round, against `5dbe8efa`.
Full report: `docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r3.md`.
Triage: plan §5d.

Three defects: one `high`, one `medium`, one `low`. All accepted.

### The `high` is against reasoning, not design

Round 2's defect 1 was fixed partly by asserting that
`verify-gate.sh --review`'s `diff-coverage` row independently catches an inert
eval, and that assertion was used to **reject** a proposed CI audit.

**The assertion is false.** `scripts/diff-coverage.ts` excludes `__tests__` and
`.test.*` files and measures only ADDED PRODUCTION lines. So it passes at T1
with nothing to cover, and passes later off the other twenty-seven tests'
coverage while test 26 alone sits `.todo`. It catches a *wholly* inert eval,
never a *single* inert test — and a single inert test is the entire hole.

The lesson is specific: **a claim used to reject a reviewer's fix carries more
weight than an ordinary claim, and has to be verified rather than reasoned.**
The rejection may still be right — it is, on a better ground — but it was
resting on something untrue, and nothing in rounds 1 or 2 would have caught
that, because only round 3 was asked to check it.

The replacement guard is a **module-scope** check in test 26's own file. Vitest
loads a module even when its tests are `.todo`, so the check runs regardless of
whether test 26 does. That is the property the audit script was wanted for,
without a permanent `package.json` / `ci.yml` / `lefthook.yml` obligation.

### The `medium` is the third bug in one five-line warning

| Round | The bug | The fix |
|---|---|---|
| 1 | unguarded emission can abort the decision transaction | wrap it |
| 2 | latch-before-emit ⇒ one transient failure buys permanent silence | latch on success, bound attempts at 3 |
| 3 | a LIFETIME ceiling of 3 ⇒ three failures then recovery is still permanently silent | cooldown in TIME, not a counter |

Every fix was correct about the failure it addressed and created the next one.
**The pattern is the finding, not any single bug.** The cooldown ends the chain
for a structural reason worth keeping: it is counted in **time**, and time
always recovers, whereas an attempt counter cannot distinguish "Sentry is
broken" from "Sentry was briefly broken".

Why so much scrutiny for one warning: it is the **only** evidence that the
ledger has a gap. The ledger cannot show its own absence, so silencing this
warning silences the only thing that could.

### Queued for step 8 promotion

1. **After fixing a review finding, re-run the finding's own rule against the
   fix.** (D4's lesson, confirmed again here.)
2. **Verify — do not reason about — any claim used to reject a reviewer's
   proposed fix.**
3. **Bound a retry in time, not in attempts,** when the thing being retried is
   the only evidence of a fault.

**Verdict:** ACCEPT. All three corrected. One disagreement remains open and is
the owner's call: plan §5d, the module-scope check versus a new `ci:*` audit
script.

---

## D6 — the eval fixes three API names the plan described but never spelled

**When:** step 5, task T1, while authoring the twenty-eight failing tests.

A RED eval is the first CALLER of an API that does not exist yet, so it does not
merely describe the surface — it decides it. Three identifiers the plan names
only in prose are now pinned by an import, and T3/T5 must bind to them rather
than choose their own:

| Identifier | Where the plan describes it | Where the eval now pins it |
|---|---|---|
| `resetRefusalLedgerWarningForTests()` from `src/lib/refusals/write.ts` | §4 T3, *"export a test-only reset that clears both, on `circuit-breaker.ts`'s `reset()` precedent"* | `write.test.ts`'s `beforeEach`/`afterEach` — without it title 9's "exactly one per process" is satisfied by whichever case ran first |
| `WARN_RETRY_COOLDOWN_MS` exported from the same module | §2.3's cooldown pseudocode, `300_000` | title 28 advances a stubbed `Date.now()` by exactly this value, so the case pins the cooldown rather than an arbitrary "long enough" margin |
| `REFUSAL_LEDGER_RETENTION_DAYS` exported from `ArchivalPoller.ts` | §4 T5 step 1 | read off the poller's DYNAMIC import in the live-DB suite's `beforeAll` — a static import would bind the `@/lib/db/server` singleton before `DATABASE_POOL_URL` points at the test DB |

None of the three changes the design. They are recorded because a later task
choosing a different name would turn a red test green-by-rewriting rather than
by implementing, which is the one thing a locked eval exists to prevent.

### And one mechanism the plan did not anticipate: how test 20 forces its rejection

Plan §3 requires title 20 to force a real `writeRefusalEvent` rejection and
assert full rollback, but does not say HOW. Three candidates were considered:

1. **Mock `@/lib/refusals/write` to reject.** Rejected — it proves only that a
   stub can reject. The claims that a real helper does not catch its own insert
   error and does not open its own connection both disappear.
2. **Pass an out-of-vocabulary `trigger` to `suspendAccountAutonomy`.** Rejected
   — `AUTONOMY_SUSPENSION_REASONS[trigger]` would be `undefined` too, so the
   POLICY insert fails first and the rejection never comes from the ledger.
3. **Mock `@/lib/refusals/vocabulary` and bend ONE map entry** to a category the
   CHECK does not admit. Chosen: the real helper, the real deciding
   transaction, a real `23514` from `refusal_events`, and the rest of the
   vocabulary untouched.

The stand-in map is DERIVED from the real one inside the mock factory rather
than re-typed, so titles 16-19 run against the production vocabulary and the
test never becomes a second authority over the four triggers. It was verified
that `vi.mock` on a module that does not exist yet does NOT break collection, so
the six pre-existing cases in that suite keep running through the RED phase.

**Verdict:** ACCEPT. No surface change, no amendment; `allowed_edit_surface`
already covers every file T1 touched.

---

## D7 — T2 narrowed the parked map's `| null`, deliberately

**When:** wave 2, T2.

The parked branch declares `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` as
`satisfies Record<AutonomySuspensionTrigger, RefusalCategory | null>`. T2's brief
said "carried unchanged", but plan §4 T2 and test 4 both specify the non-null
form, so T2 shipped `Record<AutonomySuspensionTrigger, RefusalCategory>` and
flagged the divergence rather than silently reconciling it.

**The narrowing is correct and the brief was loose.** `| null` exists in the
parked file because it is one arm of a *seven-lane* union where other lanes DO
map members to `null` ("known, not a refusal"). This lane has no such member:
all four `AutonomySuspensionTrigger` values are Refusals, and #998's rule is that
`null` is an explicit recorded decision, never a placeholder. Keeping `| null`
here would type a state the lane cannot reach, which the repo's own
"assert impossible states, don't branch around them" rule forbids. The lanes
that need `| null` bring it with them in #1010–#1013.

**Verdict:** ACCEPT. Flagging rather than reconciling is the behaviour wanted.

---

## D8 — the tenant-scope allowlist has a BASELINE COUNT the plan did not mention

**When:** wave 2, T5.

`scripts/ci/tenant-scope-allowlist.ts` carries an `ALLOWLIST_BASELINE` constant,
and the audit rejects an added entry unless the number moves with it. T5 bumped
it 370 → 371.

This is a ratchet: the allowlist may only grow deliberately, and a silent append
fails CI. Plan §4 T5 described the entry and its `sqlSnippet` and said nothing
about the count, so a task following the plan literally would have failed
`ci:tenant-scope` and had to discover this. It is worth knowing before the next
slice adds its own sweep arm.

**Verdict:** ACCEPT. Correct behaviour, undocumented step, now documented.

---

## D9 — the plan's arm-11 SQL could not pass its own test, and the fix is measured

**When:** wave 2, T5.

Plan §4 T5 spells the arm with `FOR UPDATE SKIP LOCKED` **after** `LIMIT 5000`,
copying arm 7 verbatim. Test 24 captures the arm with
`/SELECT id FROM refusal_events([\s\S]*?)LIMIT/` — the capture STOPS at `LIMIT`,
so a locking clause written after it falls outside the captured text and
`toContain('FOR UPDATE SKIP LOCKED')` fails.

T5 moved the locking clause before `LIMIT`. **The equivalence was measured, not
assumed**: Postgres accepts either order and the `EXPLAIN` output is
byte-identical (`Limit → LockRows → Sort`). The emitted SQL is otherwise the
plan's verbatim, and the arm's comment records why the clause sits where it does.

**Why this is worth a deviation rather than a silent edit.** The plan and the
eval disagreed, and only one of them can be authoritative. The eval won, which
is the correct precedence — a test is a claim about behaviour, a plan is a
description of intent — but a reader comparing the shipped arm against its nine
siblings will see one written differently and deserves the reason.

**Verdict:** ACCEPT.

---

## D10 — the eleventh arm broke a pre-existing unit test outside T5's brief

**When:** wave 2, T5 reported it; the orchestrator fixed it.

`worker/background/pollers/__tests__/ArchivalPoller.test.ts` asserts
`expect(mockSql).toHaveBeenCalledTimes(10)` and titles two cases "10 SQL
queries" / "10 target counts". An eleventh arm makes all three wrong.

T5's brief restricted it to two production files, correctly — three agents were
editing in parallel and a shared test file is exactly where they would have
collided. So T5 reported rather than reached. The orchestrator applied the
one-line fix serially after the wave closed: 10 → 11 in the assertion and in
both titles. Suite green at 26/26.

**The generalisable point:** T1's eval extended only the *integration* suite,
because that is where the new behaviour lives. A production change can still
falsify a sibling UNIT test that merely counts things, and no amount of
eval-first discipline surfaces that until the code lands. Look for
count-asserting neighbours whenever a change adds an item to an enumerated list.

**Verdict:** ACCEPT. Inside `allowed_edit_surface`; no amendment.

---

## D11 — `ci:directory-map` needs rows T2 could not write

**When:** wave 2, T2.

`src/lib/refusals/vocabulary.ts` is a new production file under `src/lib/`, so
`ci:directory-map` fails until `docs/directory.md` carries a row for it — in
this PR. T2's brief confined it to one file, so it reported instead.

This is already T6's job (plan §4 T6 item 3: a new `### \`refusals/\`` section
with one row per production file). Recorded so the dependency is explicit rather
than implied: **the gate cannot go green until T6 runs**, whatever else is done.

**Verdict:** ACCEPT. Planned work, surfaced early.

---

## D12 — the D16 sweep table was short THREE times, inside D16's own sweep

**When:** wave 2, T7's pre-edit sweep.

Plan §0's table claimed a complete inventory of the copies. It was wrong three
times over:

| Found by | Copies it added |
|---|---|
| plan review round 1 | `docs/reviews/feat-1008-…/standards.md`, `…/triage.md` |
| **T7's pre-edit sweep** | `docs/reviews/feat-1008-…/spec-correctness.md` — a THIRD #1008 review record |
| **T7's pre-edit sweep** | `src/lib/refusals/vocabulary.ts` — a living copy in code, written by sibling T2 *during this very wave* |

Both new ones already AGREE with the settlement, so nothing contradicts. The
defect is the completeness claim, not the content.

**This is D16's own failure mode recurring inside D16's own sweep, and that is
the lesson rather than the embarrassment.** D16 says *count every copy before
choosing the edit direction*. What this run adds is that **counting is not a
thing you do once**: a branch that is itself creating new copies has a moving
target, so the count must be re-run at the moment of editing. T7 did exactly
that and caught what three plan-review rounds had not — including a copy that
did not exist when the table was written.

**Queued for step 8 promotion**, sharpening D16's own lesson: re-run the sweep
at edit time, not at plan time, whenever the branch also writes copies.

**Verdict:** ACCEPT. Table corrected in plan §0; neither new copy is edited.
