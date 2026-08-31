# Deviations — feat/1009-refusal-ledger-write-path

**Twenty-seven entries.** Twenty-seven ACCEPT, zero RE-PLAN.

**Numbering note:** the ids run D1–D15, then **D16b**, then D17–D27 — there
is no plain "D16" in this file. In this run that label means #1008's write-site
deviation, the one this branch exists to settle, and reusing it here would be a
genuinely bad piece of record-keeping.

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
| D13 | Plan §2.3's prose and its pseudocode disagreed; T3 resolved it toward the prose | **ACCEPT** | The prose promised a surviving log line; the pseudocode showed only Sentry. The prose was right. |
| D14 | **Live-DB suites SILENTLY SKIP unless `TEST_DATABASE_POOL_URL` is EXPORTED** | **ACCEPT** | The `.env.local` fallback does not hydrate `process.env` for `describeWithDb`. A green file that ran nothing. |
| D15 | `DATABASE_POOL_URL` in the worktree's `.env.local` points at the LIVE Supabase pooler | **ACCEPT** | Copied in by `worktree:new`. Both vars must be overridden for any local test run, not just one. |
| D16b | T4b's Sentry assertion does not pin the account id's PLACEMENT | **ACCEPT** | Numbered `D16b` on purpose — "D16" in this run means #1008's write-site deviation and nothing else. |
| D17 | T6's two registry placement calls | **ACCEPT** | The plan left both open. Each went next to its nearest sibling, which is this repo's default. |
| D18 | A count-asserting neighbour broke a SECOND time — gate round 1 | **ACCEPT** | Same class as D10, different file. Two occurrences make it a class, not an incident. |
| D19 | Branch review REVERSED the plan's rejection of a per-lane union | **ACCEPT** | Owner-ratified. The original reasoning conflated storage authority with API shape. |
| D20 | Three plan rounds designed on a Sentry behaviour the SDK does not have | **ACCEPT** | The strongest finding of the run. Verify the primitive before designing on it. |
| D21 | Arm 11's SQL order is pinned TWICE — a test regex AND the allowlist snippet | **ACCEPT** | One pin removed, the other documented. The reported finding was half the problem. |
| D22 | A stale count in a THIRD title — "all 10 targets" | **ACCEPT** | Third instance of the D10/D18/D15 class in one run. Swept, not patched. |
| D23 | Red team: 9/9 mutants killed, no P0 — and the sweep class recurred a FIFTH and SIXTH time | **ACCEPT** | My own post-fix sweep was short by four. The class is now the run's defining finding. |
| D24 | Surface amendment **2 of 2** — `docs/runbooks/beta-launch-alerting.md` (RT-1) | **ACCEPT** | Owner-approved. The budget is now SPENT: a third amendment triggers the abort criteria. |
| D25 | Red-team round 2: my RT-4 fix replaced one false claim with ANOTHER, measured | **ACCEPT** | Owner chose to close the real gap. Test 29 kills the mutant that survived. Seventh and eighth instances of the class. |
| D26 | Red-team round 3 is attestation-only and exceeds the documented cap of two | **ACCEPT** | Recorded explicitly, because a cap that can be exceeded without a written reason is not a cap. |
| D27 | CI caught a real defect the local gate structurally could not see | **ACCEPT** | The gate runs CHANGED integration suites; this one was affected by a PRODUCTION change while itself unchanged. |

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
| `resetRefusalLedgerWarningForTests()` from `src/lib/refusals/write.ts` | §4 T3, *"export a test-only reset that clears both, on `circuit-breaker.ts`'s `reset()` precedent"* | `write.test.ts`'s `beforeEach`/`afterEach` — without it title 9's "exactly one Sentry warning per disabled episode" is satisfied by whichever case ran first. (**Historical quotation:** when this deviation was written the title read *"exactly one per process"*; red-team RT-7 renamed it to match the shipped per-EPISODE rule. The mechanism this row records is unchanged.) |
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

---

## D13 — plan §2.3's prose and its pseudocode disagreed, and the prose was right

**When:** wave 3, T3.

§2.3's outcome table promises that when Sentry always throws, *"the structured
log line still carries the fact"*. Its pseudocode block shows only
`Sentry.captureMessage`. A task following the pseudocode literally would ship a
kill switch whose only signal is the one that is failing.

T3 resolved it toward the **prose** and added one
`createWorkerLogger('[refusals:write]').warn(...)` **first** inside the same
guarded block — matching T4b's independently-stated rule that `logger.error`
runs first so the structured line survives even when Sentry does not.

**This is the right resolution and the plan was at fault.** The whole reason
this warning exists is that the ledger cannot show its own absence. A signal
path with a single point of failure would defeat that, and the prose said so
while the pseudocode quietly did not.

Visible consequence: the unit suite prints six JSON log lines to stderr. That is
the log line working, not noise.

**Verdict:** ACCEPT.

---

## D14 — live-DB suites SILENTLY SKIP unless `TEST_DATABASE_POOL_URL` is EXPORTED

**When:** wave 4, T4. **This is the most operationally important entry in this
file.**

T4's suite passed on a bare `pnpm vitest run` **while executing nothing**.
`describeWithDb` reads `process.env.TEST_DATABASE_POOL_URL` **directly**, and the
repo's `.env.local`-off-disk fallback does not hydrate `process.env` for it. The
variable is present in the file and absent from the environment, so the suite
self-skips and reports green.

T4 caught it by re-running with `--reporter=verbose` and checking that the cases
actually executed. Without that check, "done" would have meant *a green file
that ran nothing* — for the five tests that carry this slice's entire safety
argument.

**This is the #520 class, and CLAUDE.md already warns about the neighbouring
half** ("Unsetting `TEST_DATABASE_POOL_URL` does NOT put live-DB suites to
sleep"). What this run adds is the mirror image: **setting it in `.env.local`
does not wake them either.** Both halves are true and they are not obvious
together.

**Binding on every later step of this run:** the verify gate must be launched
with the variable EXPORTED, and any gate reporting a live-DB `SKIP` row is not
review-ready for this branch.

**Queued for step 8 promotion.**

**Verdict:** ACCEPT.

---

## D15 — `DATABASE_POOL_URL` in the worktree's `.env.local` points at the LIVE Supabase pooler

**When:** wave 4, T4.

`pnpm worktree:new` copies `.env*.local` from the parent checkout, so a fresh
worktree inherits the developer's real `DATABASE_POOL_URL` —
`aws-1-us-west-2.pooler.supabase.com`. Any accidental singleton import during a
local test run reaches **production**.

T4 overrode it to the local test URL for its run rather than exporting only
`TEST_DATABASE_POOL_URL`. That is correct, and it is what CLAUDE.md means by
*"Locally export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` first"* —
the second variable is not redundancy, it is the blast shield.

Taken with D14 the rule is: **override BOTH, every time.** One of them decides
whether the tests run at all; the other decides what they run against.

**Verdict:** ACCEPT.

---

## D16b — T4b's Sentry assertion does not pin the account id's placement

**When:** wave 5, T4b.

Numbered **D16b** deliberately. In this run "D16" means #1008's write-site
deviation and nothing else, and a second D16 in the branch that exists to settle
the first one would be a genuinely bad piece of record-keeping.

Test 21 asserts the account id by `JSON.stringify(secondArg)` containing it.
That passes whether the id sits in `extra` or in `tags`, so the assertion pins
*presence* and not *placement*. T4b followed `worker/job-failure-sink.ts` —
identifiers in `extra`, subsystem in `tags` — which is the repo's shape.

Left as-is: the test's job is that the id reaches Sentry at all, and tightening
it to a specific key would pin a Sentry convention rather than a behaviour. The
precedent is what keeps placement consistent, and the precedent is followed.

**Verdict:** ACCEPT, no change.

---

## D17 — T6's two placement calls in the registries

**When:** wave 5, T6. Recorded because the plan left both open.

- `docs/eservices-variables.md` — `REFUSAL_LEDGER_ENABLED` went into the
  **Agentic autonomy** table rather than Database or LLM, since the flag belongs
  to the watchdog cluster its first write site sits in.
- `.claude/reference/env-vars.md` — the behaviour entry went into **Worker
  Infrastructure**, directly after `LLM_CIRCUIT_BREAKER_ENABLED`, because that
  section is where both existing default-ON kill switches already live.

Both are the "put it next to its nearest sibling" call, which is this repo's
default. Either is a one-line move if a reviewer disagrees.

**Verdict:** ACCEPT.

---

## D18 — a count-asserting neighbour broke a SECOND time, and that makes it a class

**When:** gate round 1. The only red row in a 27-row, 13,721-test full gate.

`src/lib/auto-approval/__tests__/suspension.test.ts` asserts
`expect(sqlCalls).toHaveLength(5)`. The ledger insert makes six, so the whole
suite failed on one number.

**This is D10 again, in a different file, from a different task.**

| | D10 | D18 |
|---|---|---|
| Change | `ArchivalPoller` gained an eleventh arm | `suspendAccountAutonomy` gained a sixth statement |
| Broke | `ArchivalPoller.test.ts`, `toHaveBeenCalledTimes(10)` | `suspension.test.ts`, `toHaveLength(5)` |
| Found by | the implementing task, which could not reach the file | the verify gate |
| Missed by | the eval, which extended only the *integration* suite | the same |

**Two occurrences is a class, not an incident, and the class is specific:**
adding one item to an enumerated sequence falsifies any neighbour that asserts
the sequence's LENGTH — and an eval-first discipline does not surface it,
because the eval is written against the behaviour being added, while the broken
assertion is about the behaviour already there.

**The generalisable rule, queued for step 8 promotion:** when a change appends
to an enumerated list — a poller's arms, a transaction's statements, a
registry's entries — grep the sibling UNIT suites for `toHaveLength`,
`toHaveBeenCalledTimes` and their kin *before* running the gate. Both times, the
fix was one number; both times, it cost a full gate cycle to find.

**The fix does more than renumber.** Shifting indices 3 and 4 to 4 and 5 would
have left the new statement at index 3 completely unasserted — a silent hole
where the slice's whole subject sits. The repair adds four assertions on it:
the target table, the byte-for-byte `ON CONFLICT` predicate, `DO NOTHING`, and
the lane. It also records WHY the ordering is what it is, so the next person to
insert a statement here knows the position is load-bearing rather than
incidental.

**Verdict:** ACCEPT. Inside `allowed_edit_surface`; no amendment.

---

## D19 — branch review REVERSED the plan's rejection of a per-lane union

**When:** branch review round 1, adversarial **A-01** (`high`) and standards
**S3** (`medium`), reached independently. Owner-ratified 2026-08-30.
Triage: `docs/reviews/feat-1009-refusal-ledger-write-path/triage.md`.

The plan rejected a discriminated union on `refusalSource` because *"a
TypeScript copy would be a second authority over the same five facts"*, citing
#1001's placement of those invariants in the database.

**Both reviewers said that conflates two different things, and they are right.**
Migration 116 must stay the STORAGE authority and keep all five CHECKs, because
TypeScript cannot protect SQL written by another process or an operational
query. **None of that requires the TypeScript API to accept states already known
to be illegal.** A union is a compile-time PROJECTION of the same authority, and
it cannot drift silently: adding a lane to `REFUSAL_SOURCES` without an arm is a
compile error.

Shipped as a mapped type over `RefusalSource`, with the totality guard verified
empirically rather than assumed. `refusalCategory` is deliberately NOT narrowed
per lane — #1001 declined to pin `held_draft`'s category because that would make
a future re-map migration-bearing, and that decision stands.

**Why it was `high` rather than a preference:** this module deliberately does
not catch, so a mis-paired lane raises `23514` and aborts the **deciding
transaction**. Ten more callers are planned.

**The lesson is about the shape of the error.** The plan's reasoning was not
sloppy; it was a category confusion between *where a fact is enforced* and
*what an API may express*. Those look identical when you are defending a
decision and different the moment someone else states them apart.

**Verdict:** ACCEPT.

---

## D20 — three plan-review rounds designed on a Sentry behaviour the SDK does not have

**When:** branch review round 1, adversarial **A-02** (`high`).
**This is the strongest finding of the entire run.**

Plan rounds 1, 2 and 3 each found a different bug in the same five-line warning
path:

| Round | Bug | Fix |
|---|---|---|
| 1 | unguarded emission can abort the decision | wrap it |
| 2 | latch-before-emit ⇒ one blip buys permanent silence | latch on success, cap attempts |
| 3 | a LIFETIME cap ⇒ three failures then recovery is still silent | cooldown in time |

Round 3's cooldown looked like the end of the chain. It was not, **because all
three rounds reasoned about a mechanism none of them read.**

The reviewer went to `node_modules` and established that `@sentry/node` 10.55.0's
`captureMessage` returns an event id immediately — even with no client
configured — buffers the event, sends the envelope asynchronously, and **catches
transport failures internally rather than throwing back**. So:

- "capture succeeded" only ever meant "capture was **queued**";
- the `try/catch` could never see a DSN/network delivery failure; and
- a real Sentry outage latched the flag with the warning undelivered — the exact
  permanent silence rounds 2 and 3 were chasing, by a route none examined.

**The shipped design makes each transport promise only what it can keep:** the
structured log line is primary and durable, emitted first and outside the Sentry
guard; the rate limit is per disabled EPISODE rather than per process; Sentry is
best-effort with no `flush()`, because awaiting delivery would put network
latency on the deciding transaction's path.

**Queued for step 8 promotion, as this run's primary lesson: verify the
primitive before designing on top of its assumed behaviour.** Three careful
adversarial rounds are no substitute for reading the library. Note also that the
review that caught it was reviewing CODE — the plan rounds could not have caught
it, because a plan does not name a version.

**Verdict:** ACCEPT.

---

## D21 — arm 11's SQL order is pinned TWICE, and the review saw only one pin

**When:** branch review round 1, standards **S4** (`low`); enlarged while fixing.

S4 reported that arm 11 puts `FOR UPDATE SKIP LOCKED` before `LIMIT`, unlike its
ten siblings, only because a test's capture regex stopped at `LIMIT` — production
SQL shaped by a test's parser (D9's original cause).

**Fixing it revealed the finding was half the problem.** The regex was widened
and is now order-independent. But restoring the sibling ordering then failed
`ci:tenant-scope`: `scripts/ci/tenant-scope-allowlist.ts` matches its
`sqlSnippet` by exact whitespace-normalised equality, so the allowlist pins the
order too — and that file was outside the fixing agent's surface.

So the arm's order was constrained by **two** independent pins in two files. One
is now gone; the other is recorded in the arm's own comment, so the next
maintainer knows the two files move in lockstep instead of discovering it from a
red audit.

**The agent stopped and reported rather than reaching outside its surface**,
which is exactly the behaviour the parallel-wave discipline exists to produce.

**Verdict:** ACCEPT.

---

## D22 — a stale count in a THIRD title, and the sweep that should have caught it

**When:** branch review round 1 fixes; found by the orchestrator while reading a
sibling agent's diff, not by any reviewer.

`ArchivalPoller.test.ts` still carried
`'logs "Nothing to archive" when all 10 targets return 0'` after the poller
reached eleven arms.

**This is the third instance of one class in this run** — D10 (`toHaveBeenCalledTimes(10)`),
D18 (`toHaveLength(5)`), and now a stale count in prose that no assertion
checks. It is also the fourth time the branch has been bitten by #1008's D15:
*in this repo a documentation fix is a SWEEP, never an edit.* Twice the sweep
was of test assertions; here it is of a test's own title, which nothing
mechanical validates.

Swept rather than patched: every count in that file was re-checked against the
eleven arms, not just the one the eye landed on.

**Verdict:** ACCEPT.

---

## D23 — the red team: 9/9 mutants killed, no P0, and the sweep class recurred twice more

**When:** step 7.5, red-team round 1, against committed HEAD `fc00bb9b`.
Report: `docs/reviews/red-team/feat-1009-refusal-ledger-write-path-29ea70/`.

### What it could not disprove

**Mutation score: 10 planted, 9 killed, 1 survived and was arbiter-reclassified
as EQUIVALENT** (see below), then killed by a follow-up mutant. Every mutation
the brief demanded was planted, and the kills were by measurement rather than
inspection: the `ON CONFLICT` predicate mutant died on a real `42P10`, the
lane-pairing mutant died at compile time on `TS2345`, and the crossed-clock,
episode-reset, log-placement and log-object mutants each died on this branch's
own live-DB cases.

It also verified TRUE, independently: the flag-OFF byte-identical path, "no
migration 117", `NOW()` = `transaction_timestamp()`, all seven CI audits, and a
PII/secret-logging sweep.

### RT-4 — a mutant survived because the CLAIM was wrong, not the code

M9 swallowed the helper's INSERT error and the suspension test still passed.
That looked like fake coverage. It is not: postgres.js records `uncaughtError`
per query inside `scope()` and **rethrows after the callback returns**
(`index.js:290-296`), so the transaction aborts whether or not the helper
swallows. The mutation is genuinely equivalent.

**What was wrong was the test's comment**, which claimed a swallowing helper
"would leave all three behind and a green caller". A reader would have trusted a
guarantee the assertion does not provide. Corrected in place, and the comment now
states plainly what the test does and does not discriminate.

### RT-1 — both new Sentry signals page nobody

`beta-launch-alerting.md`'s six rules key on explicit tag values with no
catch-all, so `subsystem:refusal_ledger` and `subsystem:autonomy_governor` reach
Sentry and stop there. **The gap is pre-existing and documented** — that runbook
already records that no Discord route is configured, and every `warning`-level
capture in the repo shares it — but the intake called this warning "the only
evidence a ledger gap exists", which overstated what it delivers. The claim is
corrected; the routing decision is the owner's.

### RT-2, RT-3, and my own sweep being short a FOURTH, FIFTH and SIXTH time

- **RT-3** — the fourth D16 sweep miss, and the brief predicted it. T7 appended
  the CLOSED paragraph to `## D16`'s section and never touched the summary TABLE
  ROW 470 lines above, which still read "unsettled". That file's own rule, 13
  lines below the row, is *"A new deviation adds a ROW here, not just a
  section."* The same file had already been a casualty of this twice.
- **RT-2** — `docs/directory.md` still said "once-per-process Sentry warning"
  while `env-vars.md`, corrected in the SAME commit, said the opposite. **That
  commit was mine**, and its message claimed a sweep.
- **Then my sweep of RT-2 was itself short by four**: re-running the grep found
  three more "per process" claims in the intake and one in the plan.

**This class has now bitten this branch six times** (D12 ×3, RT-2, RT-3, and the
miss inside RT-2's own fix). It is the defining finding of the run.

**The rule that actually works, and it is mechanical rather than attentive:**
after changing a fact, grep for the FACT across every artifact and re-grep after
fixing, in the same breath. Not the cited line, not the file the finding named,
and never once — the re-grep is what caught four of the six.

**Queued for step 8 promotion** as this run's second lesson, beside D20's.

**Verdict:** ACCEPT. Six of seven findings fixed; RT-1's routing decision is the
owner's and is recorded in the PR description.

---

## D24 — surface amendment 2 of 2: `docs/runbooks/beta-launch-alerting.md`

**When:** step 7.5, in response to red-team **RT-1**. Owner-approved 2026-08-30.
**Counted mechanically** with the owner's reason:
`feature-state.sh incr-amendment --reason "…"` → `surfaceAmendments=2`.

RT-1 found that both new Sentry signals reach Sentry and stop there. The fix the
owner chose is to correct the overstated intake claim and add both tags to the
alerting runbook's pending checklist. That file is under `docs/runbooks/`, a tree
the declared surface does not cover, so it needed the amendment.

**Verifying the finding sharpened it.** RT-1 said neither signal pages anyone.
Checking what the code actually emits shows that is true of only one:

| Signal | Emitted as | Reaches |
|---|---|---|
| `subsystem:refusal_ledger` | `captureMessage(…, level: 'warning')` | **captured, not paged** — a warning-level message does not reliably classify as high priority |
| `subsystem:autonomy_governor` | `captureException(error, …)` — defaults to level `error` | the existing default high-priority rule, i.e. email to issue owners |

This is **CONFIG-1's shape exactly**, already recorded in that runbook for
`feature:stripe_reconciliation`. CONFIG-1's own remedy — option (b), raise the
level — is deliberately NOT applied here: a flipped kill switch is an operator's
deliberate state, not an error, so raising it to `error` would be lying about
severity to buy routing. The tag-based rule is the correct fix, and it waits on
the Discord route the runbook already lists as pending.

### The amendment budget is now SPENT

Two of two used (D2, D24). **A third amendment triggers the abort criteria**, at
which point the correct move is a post-mortem and a restart rather than another
widening. Recorded here so a resumed session sees the limit before reaching for
it.

**Verdict:** ACCEPT.

---

## D25 — the RT-4 fix replaced one false claim with another, and the fix for THAT closed a real gap

**When:** step 7.5, red-team **round 2** (the final round), finding **RT-8**
(P1, measured). Owner-adjudicated 2026-08-30.

### What happened

Round 1's RT-4 said a test comment claimed coverage the test did not provide. I
corrected it. **My correction asserted something else that was equally false** —
that the test *does* discriminate a helper opening its own connection.

Round 2 planted exactly that mutant (INSERT plus `occurredAtFragment` rerouted
onto a fresh postgres.js client), baseline green, and **it SURVIVED**. It
survives because that case's fixture forces a CHECK violation, so the INSERT
fails on either connection and **no row exists to survive the rollback**.

So: fixing a finding about a false claim, I wrote a false claim, in the same
comment. That is the **seventh** instance of this run's defining class. The
**eighth** turned up minutes later — the plan's §1 code sample still showed the
pre-union flat `WriteRefusalEventInput` while the prose beneath it described the
union.

### Why it was fixed rather than accepted

The owner's call. Underneath the bad comment sat a **real gap**: nothing on this
branch discriminated an own-connection helper on the SUCCESS path, and
`ci:db-imports` matches only the `@/lib/db/server` specifier, so a direct
`postgres(…)` inside `src/lib/refusals/` was caught by nothing.

Test 29 closes it — a successful ledger write, then a caller-owned rollback,
then an assertion of zero rows. **It makes the comment true instead of merely
quieter**, which is the difference between fixing a claim and deleting it.

### The proof is a measurement, which is the whole point

M10 was re-planted and **test 29 killed it**. The kill mechanism was itself
verified rather than assumed: the private connection's INSERT blocks on
`lockAutonomyAccount`'s `accounts FOR UPDATE`, reproduced in isolation under
`lock_timeout` as `55P03`. The test's comment now records both the mechanism and
the fact that the ASSERTION, not the hang, carries the property for any future
caller that does not take the account lock.

The RT-8 work also exposed a **third** false claim in the same file's header,
which said an own-connection helper "would pass all of them" — untrue the moment
test 29 existed. Swept in the same pass.

### The lesson, and it is not "be more careful"

Three false claims about one test, across three rounds, each written while
fixing the previous one. What broke the chain was not attention — it was
**planting the mutant**. A claim about what a test discriminates is checkable in
about a minute, and none of the three authors checked it.

**Queued for step 8 promotion:** a comment asserting that a test catches
something is a claim to MEASURE, not to reason about. Plant the mutant.

**Verdict:** ACCEPT.

---

## D26 — red-team round 3 is attestation-only, and it exceeds the documented cap

**When:** after the RT-8 fix.

The protocol caps red-team at **two rounds**, and both were spent. But
`red-team-status.mjs` recomputes rather than trusts, and it correctly refuses the
`reviewed` transition whenever the tree or the intake hash has moved since the
sidecar was written — which the RT-8 fix did, by design and with owner approval.

That leaves a genuine corner: the fix the owner authorized is the very thing that
voids the evidence, and the round that would re-establish it is over cap.

**Resolution:** a third pass that is **attestation-only** — no new findings, no
new mutation sweep beyond re-confirming M10 dies, its sole job to re-record
`head_sha`, `intake_sha256` and every disposition at the current HEAD. It is
recorded here explicitly rather than quietly, because a cap that can be exceeded
without a written reason is not a cap.

### What round 3 established, by measurement

M10 re-planted at HEAD: **test 29 FAILS** (30016 ms against the block's 30 s
timeout) where the baseline passes. The kill mechanism was reproduced in
isolation rather than assumed — connection B's insert needs `FOR KEY SHARE` on
the `accounts` row that `account-lock.ts` holds `FOR UPDATE`, giving **55P03**
under `lock_timeout`. All five documentation fixes were verified against source,
including both postgres.js citations read at the installed 3.4.9.

Sidecar: **status CLEAR**, 24 inventory rows, 10 killed, **zero open**. RT-1
`accepted-risk` under the owner's authorization; RT-2 … RT-11 `fixed`.

### The override, stated plainly

`red-team-status.mjs` still refuses, on **exactly one** ground:
`round must be 1 or 2 (hard cap)` (`:253`). Every other check passes — forcing
`round: 2` in memory yields zero shape errors, recomputed counts that match, and
a recomputed status of `CLEAR`.

**The attesting agent declined to lower the number, and that was correct.**
Writing `round: 2` over a round that genuinely happened would be a claim that
does not match reality, which is the exact defect class this run caught nine
times. The integrity of the record is worth more than a green checker.

**Owner decision, 2026-08-30: proceed to `reviewed` with the override
documented.** The transition is taken with the checker reporting this single
structural objection, because the evidence it guards is genuinely current and
self-consistent, and the objection is to a number rather than to a fact.

### The tooling gap this exposes, which is NOT this branch's

The cap makes an **owner-authorized late fix unshippable**: fixing a P1 in round
2 voids round 2's own evidence, and the round that would re-establish it is over
cap. The workflow has no attestation mode and `set-phase` has no override flag,
so honouring the checker is discipline rather than mechanism.

Patching `red-team-status.mjs` here was **rejected**: it would change a workflow
control from inside a feature branch, spend a third surface amendment (which
triggers the abort criteria), and set a bad precedent — a branch loosening its
own gate. Filed as a workflow issue instead.

**Verdict:** ACCEPT.

---

## D27 — CI caught a real defect the local gate structurally could not see

**When:** step 8, the PR's `test` job. `lint`, `build`, `e2e`, `changes` and
React Doctor (91/100) all passed; `test` failed with 1 suite / 2 tests against
1051 passing.

### The defect, and it is genuinely mine

```
PostgresError: update or delete on table "accounts" violates foreign key
constraint "refusal_events_account_id_fkey" on table "refusal_events"
```

`refusal_events.account_id REFERENCES accounts(id)` carries **no `ON DELETE`
action**, and that is deliberate — migration 116 states it plainly: accounts are
`retain_deidentified` and never deleted in production, so **nothing may take a
Refusal away on another table's clock** (#996's third ruling).

Live-DB **test fixtures do** delete accounts. The moment a suspension writes a
Refusal, every teardown path that reaches `accounts` needs to clear it first.
`SET CONSTRAINTS ALL DEFERRED` does not save it: that FK is not DEFERRABLE.

**This is the forced-consequence chain again**, the same shape #1008's
arch-review row describes for `TABLE_DISPOSITIONS` → `verificationQuery` →
`runContentPurgeStage`. The first WRITE site forces test-fixture teardown the
way the first CLASSIFICATION forced purge SQL.

### Why the local gate could not see it

**The gate runs CHANGED `*.integration.test.ts` suites.**
`AutonomyGovernorScheduler.integration.test.ts` was **not** changed by this
branch — the production file beside it was. So the suite was invisible locally
and ran in CI, which runs all of them.

That is precisely the trap CLAUDE.md documents: *"live-DB suites self-skip
locally and can go red in CI — the #520 class."* What this run adds is the
specific shape: **a suite can be affected by a change to production code while
itself remaining unchanged, and the changed-files heuristic cannot see that.**

**Queued for step 8 promotion.** The mitigation is not "run everything always"
— it is: when a change adds a row to a table with a restrictive FK, grep the
live-DB suites for teardowns that delete the parent, whether or not those suites
are in the diff.

### The fix, and the sweep it needed

The fix belongs in the CALLERS, not the shared helper —
`cleanupTenantAccount`'s own contract already says *"callers must have removed
their own domain rows referencing the pair first"*, and it is right.

**CI named one path. The file had THREE**, and only a deliberate sweep found the
other two:

| # | Path | Found by |
|---|---|---|
| 1 | `cleanupGovernorFleet` | CI's stack trace |
| 2 | `cleanupGovernorRows` | re-running the suite locally after fix 1 |
| 3 | the judge-signal case's inline `finally`, which suspends its own `mirror` account that `cleanupGovernorRows` does not cover | re-running again after fix 2 |

A comment written at fix 2 said "there are TWO such paths". Fix 3 made that
false, and it was corrected in the same pass — the stale-count class, caught this
time before it shipped.

A repo-wide sweep confirmed only **two** suites can trigger a suspension at all;
the other already cleaned up, because T1 wrote it that way.

**Verdict:** ACCEPT. Inside `allowed_edit_surface` — no amendment; the file was
already covered by amendment 1.
