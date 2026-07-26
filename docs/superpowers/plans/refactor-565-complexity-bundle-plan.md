# Plan — #565 complexity + single-owner bundle (absorbs #569, S1, S2, the `requireSettingsOwner` clone)

Intake contract: `docs/superpowers/plans/refactor-565-complexity-bundle-intake.json` (authoritative — this
plan never restates a field, it references one).
Tickets: #565 (with its two scope-extension comments), #569 (closes as absorbed).
Arch-review findings discharged: S1 (lock key two owners), S2 (terminalization written 3×).

Glossary terms used verbatim (`CONTEXT.md`): **Solicitation batch**, **Ask**, **Batch candidate window**,
**Withhold reason**, **Logical fan-out**, **Requests**.

## Design decisions this plan locks

**D1 — the shared terminal writer carries no mode flag.** All three `contact_csv_uploads` terminal
writers become one always-guarded UPDATE (`AND status = 'pending'`). The ingest path holds the advisory
lock and has already read `status = 'pending'` in the same transaction, so the predicate is a no-op
there. The writer returns `boolean` (did a pending row transition) rather than throwing, because the
two hook paths legitimately expect `false` on a lost race; the ingest path asserts `true` and throws,
turning a previously unrepresentable outcome into a named impossible state.

**D2 — export the lock acquisition, not the key string.** #569 asked for a `csvIngestLockKey` string
helper. The stronger seam is the existing private `acquireCsvIngestLock(tx, businessId)`, exported: a
caller holding only the key still has to remember `pg_advisory_xact_lock(hashtext(…))` and the
statement-order invariant. One owner of the key **and** the lock semantics.

**D3 — share the gate evaluation, not the gate consequence.** `prepareBatch` and `constructBatch`
duplicate `lockAccountBeforeOffboardingProjection` → account read → missing-account throw →
`getOffboardingState` → `closedGateReason`. That block becomes one private helper. The double
evaluation stays double **by design** — construction's re-check is the load-bearing one. The
byte-identical `DELETE FROM solicitation_batches … built_at IS NULL` also moves into a shared helper;
the *run-failing* stays at each call site, because the two callers genuinely differ (prepare fails an
`activeParent` only when one exists, construct always fails `preparation.parentRunId`).

**D4 — `recordCompletedChildRuns` is not decomposed.** Two set-based INSERTs, each followed by a count
assertion. Splitting adds names without hiding complexity; fallow flagged it on line count, not
structure. Verdict to be logged on #565 at merge.

**D5 — `constructBatch` splits by responsibility, never by phase.** The ownership CAS and the `built_at`
write stay inline: they are sequencing contracts whose position is the contract. Only the named
concepts are extracted (`Batch candidate window` load; the Ask+run commit unit).

## Modules and seams

| Module | Seam | Deepening or new? |
|---|---|---|
| `acquireCsvIngestLock` | `src/lib/solicitation/ingest.ts` export | deepening (private → exported, existing fn) |
| `writeTerminalUploadState` | `src/lib/solicitation/ingest.ts` export | deepening (new fn, existing module) |
| `evaluateBatchGate` / `deleteUnbuiltBatch` | `src/lib/solicitation/batch-builder.ts` private | deepening (internal seam) |
| `loadCandidatePool` / `commitAskDecisions` | `src/lib/solicitation/batch-builder.ts` private | deepening (internal seam) |
| `requireSettingsOwner` | `src/lib/auth/route-helpers.ts` export | deepening (3rd sibling of `requireOwnerWithAccount`) |
| business-ownership check | `src/lib/solicitation/uploads.ts` result union | deepening (invariant #12) |

No new file. No new dependency. No new flag or env var.

## Tickets

Each ticket ends with the full verify gate green **and** its fallow hotspots passing
`pnpm ci:fallow` with **no** `fallow-ignore-next-line complexity` remaining on the functions it owns.

How that criterion is actually enforced (verified empirically on the untouched worktree, which reports
`Audit scope: 2 changed files vs origin/main` → `exit=0`): `fallow audit` scopes to files the branch
**changes**, and `--gate new-only` runs a base-snapshot attribution pass so only findings *introduced by
the changeset* affect the verdict. In the `origin/main` snapshot these functions carry
`fallow-ignore-next-line complexity`, so the base has **no** finding for them. Removing a suppression
therefore surfaces a finding the base lacked — attributed as introduced, and the gate fails. The same
applies to a hotspot merely relocated into a new function. Net effect: a suppression can only be deleted
if the function genuinely clears the threshold, which is exactly the acceptance test we want — but note
it is enforced by *attribution against the base snapshot*, not by "moved code counts as new".

Corollary to watch: a file this branch does **not** touch is never audited, so the criterion only binds
on the functions listed in these tickets.

### T1 — one owner for the lock key and the terminal upload write
Blocking edges: none.
Surface: `src/lib/solicitation/ingest.ts`, `worker/jobs/csv-ingest/failed-hook.ts`,
`src/lib/solicitation/__tests__/ingest.test.ts`, `worker/jobs/csv-ingest/__tests__/index.test.ts`.

- Export `acquireCsvIngestLock`; `worker/jobs/csv-ingest/failed-hook.ts:63` calls it instead of
  rebuilding the literal. (D2 — closes #569, discharges S1.)
- Add `writeTerminalUploadState(tx, { uploadId, businessId, status, report }): Promise<boolean>` owning
  the guarded UPDATE + `raw_csv = NULL` + `completed_at = NOW()` + `tx.json` encoding. Three callers:
  `terminalizeUpload`, `terminalizeUploadForInactiveSubscription`, and the failed-hook. (D1 —
  discharges S2.)
- `terminalizeUpload` asserts the `true` return and throws with the upload id on `false`.
- The failed-hook keeps its own transaction, outbox CAS ordering, and crash-net bookkeeping — only the
  lock call and the UPDATE move.

Tests (intake `tests_to_add` 1–5). The failed-hook test at `index.test.ts:169` currently asserts the raw
SQL text of the lock; keep an assertion that pins the key value, so the shared function cannot silently
change it.

### T2 — decompose the ingest lane to zero suppressions
Blocking edges: T1 (the terminal write must already be one owner).
Surface: `src/lib/solicitation/ingest.ts`, its unit + integration tests.

Remove all four `fallow-ignore-next-line complexity` comments and decompose until the gate passes:
`ingestContactsCsvUpload`, `upsertCandidates`, `updateMatchedContact`, `terminalizeUpload`.

Direction (measure with `pnpm ci:fallow`, do not pre-commit to a shape): the three terminal branches in
`ingestContactsCsvUpload` (byte cap / structural failure / success) collapse once they share one writer;
`upsertCandidates` separates the per-candidate decision+write step from the tally accumulation.
`updateMatchedContact` is only ~20 lines — if it passes fallow once its suppression is removed, leave it
alone and record that in the deviations file rather than splitting it to look busy.

The stale `fallow-ignore` justification comments (which explain integration-coverage-inflated CRAP) are
deleted with the suppressions; do not leave orphaned rationale.

### T3 — uploads route: ownership check into the module
Blocking edges: none.
Surface: `src/app/api/dashboard/contacts/uploads/route.ts`, `src/lib/solicitation/uploads.ts`,
`src/lib/solicitation/__tests__/uploads.test.ts`.

Move the business-ownership `SELECT` out of the route into `createContactsCsvUpload`, adding a
`business_not_found` variant to its existing result union; the route maps it to the same 404 with the
same body. This is what discharges `uploadContactsCsv`'s complexity flag (invariant #12) — shuffling
lines inside the route would not. `parseUploadForm` stays a route-local multipart validator; it is the
route's own input parsing and belongs there.

Test (intake `tests_to_add` 6).

### T4 — one owner for the Solicitation batch gate
Blocking edges: none (independent of T1–T3).
Surface: `src/lib/solicitation/batch-builder.ts`, `src/lib/solicitation/__tests__/batch-builder.test.ts`.

Extract `evaluateBatchGate` and `deleteUnbuiltBatch` per D3. Preserve exactly: the account-missing throw
message, the ordering of gate reasons inside `closedGateReason` (offboarding → flag → subscription), and
each caller's distinct run-failing consequence.

Test (intake `tests_to_add` 7) pins that both call sites derive the reason from one owner.

### T5 — decompose the executor to zero suppressions
Blocking edges: T4.
Surface: `src/lib/solicitation/batch-builder.ts`, `worker/jobs/solicitation-batch/failed-hook.ts`, their
tests.

- `constructBatch` (310 lines) → extract `loadCandidatePool` (the **Batch candidate window** query, the
  pool count, the prior-send lookup, and the `toCandidate` join) and `commitAskDecisions` (the Ask
  insert, `recordCompletedChildRuns`, the `agent_run_id` link, and their three count assertions as one
  atomicity unit). Ownership CAS and the `built_at` write stay inline (D5).
- `prepareBatch` (120 lines) shrinks via T4 alone; decompose further only if fallow still flags it.
- `handleSolicitationBatchFailed` (82 lines) → extract the terminal transaction body, leaving the
  exhaustion guard, the `missing_exact_attempt` branch, and the final log at the top level.
- `recordCompletedChildRuns` untouched (D4).

The integration suites (`batch-builder.integration.test.ts`) are the regression net here and must run —
`TEST_DATABASE_POOL_URL` is set in `.env.local`.

### T6 — extract `requireSettingsOwner`
Blocking edges: none (fully independent; may land first).
Surface: `src/lib/auth/route-helpers.ts`, `src/lib/auth/__tests__/route-helpers.test.ts`,
`src/app/api/settings/auto-approval/route.ts`, `src/app/api/settings/competitors/route.ts`.

Signature `requireSettingsOwner(sql: Sql, request: NextRequest)` — explicit DB client per invariant #15;
`route-helpers.ts` must not import `@/lib/db/server` (`pnpm ci:db-imports` enforces this). Both routes
delete their clone, their now-unused local `SettingsOwnerResult`/`OwnerWithAccount` type aliases, and
their `getOffboardingState`/`isOperationalUIBlocked` imports.

Do not change: the `?accountId` rejection happening **before** owner resolution, or the auto-approval
route's impersonation branch (which runs after the preamble, PATCH only).

Tests (intake `tests_to_add` 8–10), in the `describe('requireSettingsOwner')` style already used by the
file's siblings.

## Verification

Standard gate plus the intake's `verification_commands`: `pnpm ci:fallow` (the acceptance test for every
decomposition ticket) and both integration suites run explicitly with `TEST_DATABASE_POOL_URL` set.

`pnpm build` runs because the surface includes `src/app/`.

## Ship lane

RISK = high (two retry-exhaustion terminalizers with coupled outbox CAS). Rides `staging` before the PR
to `main`. No migration, no flag — rollback is a straight revert (intake `rollback_plan`).

Staging smoke (intake `observability`): one CSV upload reaches `status='completed'` with a non-null
report and `raw_csv IS NULL`, and its Solicitation batch reaches `built_at` non-null with unchanged
send/withhold counts.
