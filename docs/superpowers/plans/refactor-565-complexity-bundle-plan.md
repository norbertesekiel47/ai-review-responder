# Plan — #565 single-owner + executor-decomposition bundle (absorbs #569, S1, S2, the `requireSettingsOwner` clone)

Intake contract: `docs/superpowers/plans/refactor-565-complexity-bundle-intake.json` (authoritative —
this plan references fields, never restates them).
Tickets: #565 (with its two scope-extension comments), #569 (closes as absorbed).
Arch-review findings discharged: S1 (lock key two owners), S2 (terminalization written 3×).

Glossary terms used verbatim (`CONTEXT.md`): **Solicitation batch**, **Ask**, **Batch candidate window**,
**Withhold reason**, **Logical fan-out**.

Revision history: round-1 and round-2 adversarial reviews returned REVISE (1 blocker each). Both were
accepted; this document is the post-round-2 rewrite, with the ticket set re-derived from measurement
rather than from the ticket text.

## What measurement changed

`#565` was written as "decompose 5 fallow complexity hotspots in the contacts ingest lane", later
extended to the executor. Running `fallow health --complexity` directly disproved most of that framing:

| Claimed hotspot | Measured | Outcome |
|---|---|---|
| `constructBatch` (batch-builder) | cyc=16 cog=16, 310 lines | **real** → T5 |
| `prepareBatch` (batch-builder) | cyc=10 cog=11, 120 lines | **real** → T5 |
| `handleSolicitationBatchFailed` | 82 lines, no complexity finding | large-only → T5 (line count) |
| `ingestContactsCsvUpload`, `upsertCandidates`, `updateMatchedContact`, `terminalizeUpload` | **zero findings with all 4 suppressions stripped** | **dropped** |
| `uploadContactsCsv`, `parseUploadForm` | absent from `findings` AND `large_functions` | **dropped** |

The ingest suppressions do not guard complexity — they guard **CRAP** (complexity × uncovered²), which
only materializes under the real CI gate `ci:fallow:coverage`, where `vitest --coverage` omits the
integration suites that actually cover those functions. Decomposition cannot clear a coverage-driven
finding: splitting an 89-line function with ~0% apparent coverage yields several functions with ~0%
apparent coverage. The existing in-file comments already said this. **The coverage blind spot is the
real debt and is filed separately** — it affects every integration-tested module in the repo.

Net effect: the branch keeps the four single-owner/decomposition tickets that have a verified reason to
exist, and drops the two that measurement showed were mis-specified.

## Design decisions this plan locks

**D1 — the shared terminal writer carries no mode flag, and asserts nothing.** All three
`contact_csv_uploads` terminal writers become one always-guarded UPDATE (`AND status = 'pending'`). The
ingest path holds the advisory lock and has already read `status = 'pending'` in the same transaction,
so the predicate cannot change the outcome for a row that still exists.

*Revised after round-1 review (blocker).* The first draft had the ingest path assert the write matched a
row, on the reasoning that a 0-row result was impossible. **That was wrong.**
`worker/jobs/account-offboarding/purge-stages.ts:256` hard-DELETEs `contact_csv_uploads` by `account_id`
*without* the advisory lock, so the offboarding purge can commit between the pending read at
`ingest.ts:136` and the terminal write at `ingest.ts:155/167`. Today the unguarded UPDATE matches 0 rows
and the job completes; the assert would have turned that tolerated race into a throw → retries →
exhaustion → failed-hook noise. The writer returns `void`, **no caller asserts**, and a comment on the
writer names the purge race so the next reader does not "fix" it into an assert.

**D2 — export the lock acquisition, not the key string.** #569 asked for a `csvIngestLockKey` string
helper. The stronger seam is the existing private `acquireCsvIngestLock(tx, businessId)`, exported: a
caller holding only the key still has to remember `pg_advisory_xact_lock(hashtext(…))` and the
statement-order invariant. One owner of the key **and** the lock semantics.

**D3 — share the gate evaluation, not the gate consequence, and pin its call site.**
`prepareBatch` and `constructBatch` duplicate `lockAccountBeforeOffboardingProjection` → account read →
missing-account throw → `getOffboardingState` → `closedGateReason`. That block becomes one private
helper. The double evaluation stays double **by design** — construction's re-check is the load-bearing
one. The byte-identical `DELETE FROM solicitation_batches … built_at IS NULL` also moves into a shared
helper; the *run-failing* stays at each call site (prepare fails an `activeParent` only when one exists,
construct always fails `preparation.parentRunId`).

*Ordering is part of D3, not an implementation detail* (round-1 review, should-fix). In `prepareBatch`
the `activeParent SELECT … FOR UPDATE` at :186-196 currently sits *between* `getOffboardingState` and
`closedGateReason`. `evaluateBatchGate` **must** be called **before** that query: calling it after would
place the accounts-row lock after the `agent_runs` lock and reverse the current lock order. Pinned by a
promised test (`tests_to_add` 6), not by prose alone (round-2 review, should-fix).

**D4 — `recordCompletedChildRuns` is not decomposed.** Two set-based INSERTs, each followed by a count
assertion. Splitting adds names without hiding complexity; fallow flagged it on line count, not
structure. Verdict to be logged on #565 at merge.

**D5 — `constructBatch` splits by responsibility, never by phase.** The ownership CAS and the `built_at`
write stay inline: they are sequencing contracts whose position *is* the contract. Only named concepts
are extracted.

## Modules and seams

| Module | Seam | Deepening or new? |
|---|---|---|
| `acquireCsvIngestLock` | `src/lib/solicitation/ingest.ts` export | deepening (private → exported, existing fn) |
| `writeTerminalUploadState` | `src/lib/solicitation/ingest.ts` export | deepening (new fn, existing module) |
| `evaluateBatchGate` / `deleteUnbuiltBatch` | `src/lib/solicitation/batch-builder.ts` private | deepening (internal seam) |
| `loadCandidatePool` / `commitAskDecisions` | `src/lib/solicitation/batch-builder.ts` private | deepening (internal seam) |
| `requireSettingsOwner` | `src/lib/auth/route-helpers.ts` export | deepening (3rd sibling of `requireOwnerWithAccount`) |

No new file. No new dependency. No new flag or env var.

## How each ticket is accepted

`pnpm ci:fallow` (`--gate new-only`) audits only **changed** files and fails only on findings
**attributed as introduced** vs the `origin/main` snapshot. The batch-builder findings already exist in
the base, so they stay *inherited* and `ci:fallow` passes whether or not T5 happens. It is a regression
check (don't introduce new hotspots) — **never** proof of decomposition.

T5's acceptance is therefore the targeted check in the intake's `verification_commands`, verified to
behave correctly before being committed: it captures `fallow health --complexity --format json` to
`.feature/` (tolerating that command's exit 1) and fails only if `batch-builder.ts` still has complexity
findings. Measured now: `FAIL … <arrow>:312 cyc=16 cog=16, <arrow>:136 cyc=10 cog=11`. It must print
`PASS` when T5 is done. (`fallow health` cannot be invoked directly in a gate: it rejects positional
paths with exit 2, has no scoping flag, and exits 1 on any project finding — round-2 blocker.)

T1/T4/T6 are accepted by their promised tests plus the unchanged existing suites.

## Tickets

### T1 — one owner for the lock key and the terminal upload write
Blocking edges: none.
Surface: `src/lib/solicitation/ingest.ts`, `worker/jobs/csv-ingest/failed-hook.ts`, their tests.

- Export `acquireCsvIngestLock`; `worker/jobs/csv-ingest/failed-hook.ts:63` calls it instead of
  rebuilding the literal. (D2 — closes #569, discharges S1.)
- Add `writeTerminalUploadState(tx, { uploadId, businessId, status, report }): Promise<void>` owning the
  guarded UPDATE + `raw_csv = NULL` + `completed_at = NOW()` + `tx.json` encoding. Three callers:
  `terminalizeUpload`, `terminalizeUploadForInactiveSubscription`, and the failed-hook. (D1 —
  discharges S2.)
- **No caller asserts the row count** (D1). Comment the purge race on the writer.
- The failed-hook keeps its own transaction, outbox CAS ordering, and crash-net bookkeeping — only the
  lock call and the UPDATE move. The round-1 review confirmed the same-`tx`, post-CAS statement order
  survives this extraction.
- The four `fallow-ignore-next-line complexity` comments in `ingest.ts` are **left in place** with their
  existing CRAP/coverage justification — see "What measurement changed".

Tests: `tests_to_add` 1–4. Keep an assertion pinning the lock key *value* (existing style at
`worker/jobs/csv-ingest/__tests__/index.test.ts:169`) so the shared function cannot silently change it.

### T4 — one owner for the Solicitation batch gate
Blocking edges: none.
Surface: `src/lib/solicitation/batch-builder.ts`, `src/lib/solicitation/__tests__/batch-builder.test.ts`.

Extract `evaluateBatchGate` and `deleteUnbuiltBatch` per D3. Preserve exactly: the account-missing throw
message, the gate-reason ordering inside `closedGateReason` (offboarding → flag → subscription), the
DELETE predicates and ids, and each caller's distinct run-failing posture. `evaluateBatchGate` is called
**before** `prepareBatch`'s `activeParent` query.

Tests: `tests_to_add` 5 (one owner) and 6 (lock order pinned).

### T5 — decompose the executor
Blocking edges: T4.
Surface: `src/lib/solicitation/batch-builder.ts`, `worker/jobs/solicitation-batch/failed-hook.ts`, their
tests.

- `constructBatch` (cyc=16, cog=16, 310 lines) → extract `loadCandidatePool` (the **Batch candidate
  window** query, the pool count, the prior-send lookup, the `toCandidate` join) and `commitAskDecisions`
  (the Ask insert, `recordCompletedChildRuns`, the `agent_run_id` link, and their three count assertions
  as one atomicity unit). Ownership CAS and the `built_at` write stay inline (D5).
- `prepareBatch` (cyc=10, cog=11, 120 lines) shrinks via T4; decompose further only if the targeted
  check still flags it.
- `handleSolicitationBatchFailed` (82 lines, no complexity finding — line count only) → extract the
  terminal transaction body, leaving the exhaustion guard, the `missing_exact_attempt` branch, and the
  final log at the top level.
- `recordCompletedChildRuns` untouched (D4).

Acceptance: the targeted complexity check prints `PASS`. Record before/after numbers in the deviations
file. The integration suite (`batch-builder.integration.test.ts`) is the regression net and must run —
`TEST_DATABASE_POOL_URL` is set in `.env.local`.

### T6 — extract `requireSettingsOwner`
Blocking edges: none (fully independent; lands first).
Surface: `src/lib/auth/route-helpers.ts`, `src/lib/auth/__tests__/route-helpers.test.ts`,
`src/app/api/settings/auto-approval/route.ts`, `src/app/api/settings/competitors/route.ts`.

Signature `requireSettingsOwner(sql: Sql, request: NextRequest)` — explicit DB client per invariant #15;
`route-helpers.ts` must not import `@/lib/db/server` (`pnpm ci:db-imports` enforces this). The round-1
review confirmed the two clones are behavior-identical and that the injected `Sql` avoids both the
invariant-#15 problem and any import cycle via `@/lib/account-offboarding/gate`.

Both routes delete their clone, their now-unused `SettingsOwnerResult`/`OwnerWithAccount` aliases, and
their `getOffboardingState`/`isOperationalUIBlocked` imports. Do not change the `?accountId` rejection
happening **before** owner resolution, or the auto-approval route's PATCH-only impersonation branch.

Tests: `tests_to_add` 7–9, in the `describe('requireSettingsOwner')` style used by the file's siblings.

## Follow-ups to file (not fixed here)

- **fallow CRAP coverage blind spot** — **filed as #581** *(the real finding behind #565's ingest lane)*: `ci:fallow:coverage`
  scores CRAP from `vitest --coverage`, which excludes integration suites. Every integration-tested
  module reads as ~0% covered and accrues inflated CRAP, which is why `ingest.ts` carries four
  suppressions for functions that comfortably clear the complexity thresholds. Repo-wide, not lane-local.
- **Purge/ingest race**: `worker/jobs/account-offboarding/purge-stages.ts:256` hard-DELETEs
  `contact_csv_uploads` by `account_id` without the `csv_ingest_<businessId>` advisory lock, so it can
  delete a row mid-ingest. Today's outcome is benign, which is why this branch preserves it rather than
  asserting on it — but the lock contract is genuinely incomplete.
- **#569** closes as absorbed by T1 (D2), noting the exported lock function is a stronger seam than the
  `csvIngestLockKey` string the ticket asked for.
- **#565** gets the D4 verdict on `recordCompletedChildRuns` and the measurement table above, which
  supersedes its ingest-lane and uploads-route scope.

## Ship lane

RISK = high (two retry-exhaustion terminalizers with coupled outbox CAS). Rides `staging` before the PR
to `main`. No migration, no flag — rollback is a straight revert (intake `rollback_plan`).

Staging smoke (intake `observability`): one CSV upload reaches `status='completed'` with a non-null
report and `raw_csv IS NULL`, and its Solicitation batch reaches `built_at` non-null with unchanged
send/withhold counts.
