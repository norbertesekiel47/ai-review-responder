# Handoff — feat-674-import-review-no-generation

**Checkpoint:** step 8 (ship). Implementation, gate and both review phases are DONE.
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation`
**Branch:** `feat-674-import-review-no-generation`, rebased onto `origin/main` @ `6bd45cfe`
**Phase file:** `.feature/state.json` → `reviewed`, `planReviewRounds=3`, `branchReviewRounds=2`
**Gate:** GREEN, 23/23, `lastGreenGateSha` == HEAD.

Hashes in this file are post-rebase. Anything quoted in the round-1/2/3 **plan**
review reports is from the pre-rebase base and no longer resolves —
`git log origin/main..HEAD` is the authority.

## Read these, in order

| Artefact | Path |
|---|---|
| Intake contract (arming copy) | `.feature/intake.json` |
| Intake contract (committed audit copy) | `docs/superpowers/plans/feat-674-import-review-no-generation-intake.json` |
| Implementation plan (4 tasks) | `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md` |
| Deviations D1–D16, **all ACCEPT** | `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md` |
| Branch review round 1 triage | `docs/reviews/feat-674-import-review-no-generation/branch-round-1-triage.md` |
| Branch review round 2 triage | `docs/reviews/feat-674-import-review-no-generation/branch-round-2-triage.md` |
| Design of record (epic) | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` — **owned by `main` via #681**, not by this branch (D12) |
| Glossary | `CONTEXT.md` → **Review import** (added by this branch) |

Ticket [#674](https://github.com/RepWorth/ai-review-responder/issues/674),
map [#667](https://github.com/RepWorth/ai-review-responder/issues/667).

## What shipped

`importReview` in `src/lib/reviews/process-review.ts` — insert-only, classifies
sentiment at the write site, writes AND completes a `review_ingested` run-spine
record in the insert transaction, enqueues nothing, never mutates an existing
row. Plus a **private** `insertNewReviewRow` seam shared with `processReview`.

**No migration. No feature flag. Zero callers** — the caller is #675.

- Production surface: one file.
- Tests: 37/37 unit (mocked bindings) + 4/4 live-Postgres (proves the SQL runs).
- `user_visible_behavior: none` is literally true.

## State

- **Classification:** RISK=high · SURFACE=backend · SIZE=normal.
- **Plan review: 3 rounds, exhausted at REVISE.** Owner cleared the D11 gate.
- **Branch review: 2 rounds** (round 1 full three-axis; round 2 verification-only).
  Spec axis found **nothing** at ≥80% confidence in round 1.
- **Amendment budget: EXHAUSTED (2 of 2, D8) — and never spent again.**
  Implementation and both review rounds required no third `allowed_edit_surface`
  change. This is why `docs/directory.md` was NOT updated here (see below).

## Step 8 — remaining

1. ~~Ride `staging`~~ / 2. ~~Verify~~ / 3. Open PR → **PAUSE for owner merge approval.**

**Honest note on the staging ride:** there is no migration, no flag, and no
caller, so the ride redeploys the stack but exercises **nothing** at runtime that
CI has not already proven. It is done because RISK=high prescribes it, not
because it is evidence.

## MUST happen at ship time — do not drop these

**Three comments on #675** (it inherits every one of these):

1. **The CORRECTED D4** — a review stored by `importReview` is never drafted by
   any lane, and **this needs no race**. The live lane enqueues only on INSERT or
   content-hash change; a later `processReview` matches the hash and returns
   `'unchanged'`. All three Zernio lanes converge on that same `processReview`.
   The original "race" framing would send an implementer after a narrow
   concurrency guard and leave the real gap open. **Do not paste the old wording.**
2. **KPI consequence** — imported reviews (`status='new'`, no `responses` row)
   count as unanswered in `MonthlyImpactWorker.ts:168` and the `src/lib/kpi/*`
   response rate. Same class as the D3 stalled-run catch.
3. **Audit-trail fragmentation** — a later owner-generated response opens a
   SECOND run for the same review (D16 / A2's secondary clause).

**One comment on map #667:** `CONTEXT.md` has no **Origin lane** entry, which the
map's reuse note #2 cites and #678 depends on.

**`docs/directory.md` is stale** (module description covers only `processReview`;
the second entry point and the new integration suite are absent). It is
deliberately NOT fixed on this branch — it is outside `allowed_edit_surface`, and
adding it would be the third amendment, which D8 says MUST trigger the abort
path. It belongs to the post-merge `document-feature` sweep.

**Lab-notes promotion candidates** (from the deviations file):

- The zernio suite's misleading `.integration.` name (D7) — it mocks `sql` and
  the whole `process-review` module, so it proves nothing about real SQL.
- `describeWithDb` does **not** assert schema; a live-DB suite must call
  `assertSchemaReady` itself, and must assert what the code under test **writes**,
  not only what the suite reads (round 2 V1 — 071 vs `agent_runs.parent_run_id`
  from 088).
- Plan-embedded code is neither linted nor executed until a subagent runs it;
  schema identifiers in a plan need the same "look it up, don't guess" discipline
  as production code (D10).
- A "the output must mention X" check is only non-vacuous if the tool prints X on
  success (D15).
- Correcting a hazard means correcting **every** copy — the plan embeds the
  implementation code, so the JSDoc lives in two places (round 2 V2).

## Things a resumed session will otherwise get wrong

- **Do not re-litigate the D11 owner gate or the D16 A2 decision.** Both are
  owner-decided and recorded.
- **Do not "fix" the D4 hazard.** Deliberately deferred to #675; fixing it means
  editing `processReview`'s existing-row branch, the behaviour change this ticket
  forbids.
- **Do not refactor the existing `describe('processReview')` block.** Byte-for-byte
  untouched is this ticket's regression evidence.
- **A `SKIP` on the integration suite is a FAILURE, not a pass.** A bare
  `pnpm vitest run <path>` skips — the DB URL must be exported.
  `scripts/verify-gate.sh` hydrates it itself, so the gate is immune (D15).
- **`db_touching: true`** — the gate provisions the test DB. Never put
  `pnpm test:db:setup` in `verification_commands`.
