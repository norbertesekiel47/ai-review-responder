# Deviations — feat/1009-refusal-ledger-write-path

**Four entries.** Four ACCEPT, zero RE-PLAN.

| # | What | Verdict | One line |
|---|---|---|---|
| D1 | Surface overlap with the parked `feat/refusal-log` worktree | **ACCEPT** | No merge order exists to agree — the branch never merges. It is a read-only harvest source. |
| D2 | Surface amendment 1 of 2 — `AutonomyGovernorScheduler.ts` | **ACCEPT** | Owner-approved. The intake's observability claim was false; the code changed rather than the claim. |
| D3 | `tests_to_add` grew 19 → 26 → 28 across plan review rounds 1 and 2 | **ACCEPT** | Test-title additions are deviations, not amendments. Nine wrong implementations passed the first nineteen. |
| D4 | Round 2 found four defects that round 1's own FIXES introduced | **ACCEPT** | Two of them are one mistake twice: a lesson applied to the code that prompted it, not to the code the fix wrote. |

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
