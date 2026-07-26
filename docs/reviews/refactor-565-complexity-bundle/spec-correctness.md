# Spec-fidelity & correctness review — `refactor-565-complexity-bundle`

Reviewer: spec/correctness pass. Read-only (no source edits).
Diff reviewed: `git diff origin/main...HEAD` — 14 files, 1297 insertions / 365 deletions.
Contract: `docs/superpowers/plans/refactor-565-complexity-bundle-intake.json`.

**Verdict: PASS.** No behavior change found. Zero findings at >=80% confidence
that constitute a defect. One housekeeping gap (an uncommitted docs section) and
three low-confidence observations are recorded below.

---

## 1. Evidence — what was actually run

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` (eslint) | pass |
| `pnpm test` (full unit suite) | **752 files / 9434 tests pass**, 37 files / 227 tests skipped (DB-gated) |
| `pnpm ci:db-imports` | pass — strict, no non-composition-root importer of `db/server` |
| `pnpm ci:static-policy` | pass (1029 files) |
| `pnpm ci:tenant-scope` | pass — 407 entries, baseline 407 (unchanged) |
| `pnpm ci:rls-audit` | pass (static) |
| `pnpm ci:process-env` | pass (baseline 9) |
| `pnpm ci:fallow` (`--gate new-only`) | pass — "No issues in 16 changed files" |
| Targeted complexity check (intake `verification_commands` #2) | **`PASS: batch-builder complexity clear`** |
| `batch-builder.integration.test.ts` (live DB) | **12/12 pass**, incl. gate-closure, exhaustion, 5000-cap rotation, offboarding serialization |
| `ingest.integration.test.ts` (live DB) | pass (9 tests) |
| `worker/jobs/__tests__/terminal-failure-checkpoints.integration.test.ts` | skipped in that invocation (env not loaded by that runner); covered by the batch-builder integration suite's exhaustion test |

Note on the DB env: `pnpm test` reports `TEST_DATABASE_POOL_URL unset` and skips
the integration suites; invoking the files directly through `pnpm vitest run`
picks up `.env.local` and they execute for real. This is the pre-existing
documented gotcha (CLAUDE.md, "`pnpm test:integration` hard-gates only the
publisher suite"), not something this branch introduced — but it is why the
integration suites had to be run explicitly to obtain the evidence above.

---

## 2. Hunt A — behavior change

### 2.1 batch-builder.ts SQL — moved verbatim

Normalized SQL-line multiset comparison of `origin/main:batch-builder.ts` vs the
branch shows **only** the expected de-duplication deltas:

- 2× `DELETE FROM solicitation_batches` → 1 (`deleteUnbuiltBatch`)
- 2× `SELECT subscription_status FROM accounts WHERE id = ?::uuid` → 1 (`evaluateBatchGate`)
- 3× `AND built_at IS NULL` → 2 (one DELETE collapsed; the `built_at` UPDATE's copy retained)
- identifier renames only: `batch.account_id` → `ids.accountId` / `batch.accountId`, etc.

No predicate, bound id, `ORDER BY`, `LIMIT`, `COALESCE`, join condition, or
`::uuid` cast differs. Specifically verified byte-for-byte (modulo indentation):

- the **Batch candidate window** query (`loadCandidatePool`) — including the
  `latest_visit` correlated `LIMIT 1` with its `visit_date DESC, upload_id ASC,
  id ASC` tiebreak, the `latest_evaluation` LEFT JOIN, the outer
  `decided_at ASC NULLS FIRST, visit_date DESC, c.id ASC` order, and
  `LIMIT ${MAX_DATA_ROWS}`;
- the pool-count query and its `?? candidateWindow.length` fallback;
- the `DISTINCT ON (send_ask.contact_id)` prior-send query and its
  `contactIds.length > 0` guard;
- the `jsonb_to_recordset` ask INSERT, its column list and its
  `insertedAsks.count !== askRows.length` message string;
- the `unnest(askIds, runIds)` link UPDATE, its three scoping predicates and its
  error string;
- the `built_at` UPDATE and its `expected to build batch … updated …` string.

Both `account missing for batch ${batch.id}` throws collapse into
`evaluateBatchGate`, which is called with `batchId: batch.id` from both sites —
**message strings unchanged**.

Bindings at the two `deleteUnbuiltBatch` call sites resolve to exactly the old
values (`prepareBatch`: `batch.id / batch.account_id / batch.business_id`;
`constructBatch`: `batch.id / accountId / businessId`, where `accountId =
batch.account_id` and `businessId = batch.business_id`).

### 2.2 Ordering inside `constructBatch`

`decidedAt = new Date().toISOString()` is still taken **after** the candidate
load and **before** `evaluateBatch`, so the same timestamp still flows into
`evidence.decided_at`, `solicitation_asks.decided_at` and
`solicitation_batches.built_at`. Ask/run UUIDv7 minting moved inside
`commitAskDecisions` but stays after `summarize`, i.e. the same point in the
sequence.

### 2.3 Statuses / reports / withhold reasons / HTTP codes

- `closedGateReason` precedence (offboarding → flag → subscription) untouched.
- `summarize` / `emptyReasonCounts` / `toCandidate` untouched.
- Settings routes: `400 account_id_not_allowed`, `403 account_offboarding_blocked`,
  `403 no-account`, `401`, `409 auto_approval_expansion_blocked` — all preserved,
  now asserted in `route-helpers.test.ts`.

### 2.4 Log lines

- `[csv-ingest] csv ingest completed` field set unchanged (verified against the
  intake `observability` list — all 9 fields plus the rejection histogram).
- `[SolicitationBatchWorker.failed] solicitation batch build exhausted` observed
  live in the integration run with the exact field set
  `status/batch_id/business_id/outbox_attempt/error_class/parent_terminalized`.
- `terminal_checkpoint_failed`, `stale`, `missing_exact_attempt` statuses all
  preserved verbatim.
- Sentry tags `worker:'csv_ingest'`, `kind:'on_failed_handler_crash'` untouched
  in `captureCsvIngestFailedHookCrash`.

---

## 3. Hunt B — the D1 purge-race contract

**Satisfied.**

- `writeTerminalUploadState` returns `Promise<void>`; the function body does not
  bind the result of the tagged template. No `.count`, no `rows.length`, no throw.
- All three call sites (`terminalizeUpload`, `terminalizeUploadForInactiveSubscription`,
  `worker/jobs/csv-ingest/failed-hook.ts`) `await` it and discard. Verified by
  reading each site; no row-count assertion was reintroduced.
- The doc comment on the writer names `purge-stages.ts` and explicitly forbids
  the assert, so the next reader cannot "fix" it silently.
- Test 4 (`ingestContactsCsvUpload completes normally when its terminal write
  finds no pending row`) drives the 0-row path through the mock and asserts the
  report is still returned, `csv ingest completed` is still logged, and
  `logger.warn` / `logger.error` are **not** called. Adding an assert would fail
  this test.

**Can the new `AND status = 'pending'` change the ingest outcome for a row that
still exists?** No.

- `ingestContactsCsvUpload` takes `acquireCsvIngestLock` as the transaction's
  first statement, then reads `status` and returns early unless it is `pending`.
- A repo-wide grep confirms that after this branch there is **exactly one**
  `UPDATE contact_csv_uploads` in production code (`src/lib/solicitation/ingest.ts:415`),
  and exactly one `DELETE FROM contact_csv_uploads`
  (`worker/jobs/account-offboarding/purge-stages.ts:256`). There is no other
  status writer, locked or unlocked.
- Therefore the only divergence between "predicate" and "no predicate" is a row
  that has been **deleted**, where both forms match 0 rows. Outcome identical.
- Downstream, `createSolicitationBatchTrigger` already carried its own
  `AND upload.status = 'completed'` guard, so the purge-race case still yields
  `batchCreated = false` exactly as before.

`terminalizeUpload` has three call sites, all inside `ingestContactsCsvUpload`
after the pending check (`ingest.ts:155/167/180`). No path reaches it with a
non-pending row.

---

## 4. Hunt C — statement-order contracts

| Contract | Status | Evidence |
|---|---|---|
| csv-ingest failed-hook: advisory lock is the tx's FIRST statement | **preserved** | `failed-hook.ts:66` — `acquireCsvIngestLock` is the first statement inside `sql.begin`. Test pins `sqlCalls[0].values === ['csv_ingest_business-1']`. |
| csv-ingest failed-hook: outbox CAS immediately after the lock | **preserved** | `markOutboxFailed` is the next statement; test asserts `acquireCsvIngestLock.invocationCallOrder[0] < markOutboxFailed.invocationCallOrder[0]`. |
| csv-ingest failed-hook: terminal write stays in the CAS's tx, after the CAS | **preserved** | `writeTerminalUploadState` sits after the `if (!ownsAttempt) return`, inside the same `begin`. |
| solicitation-batch failed-hook: outbox CAS is the tx's FIRST statement | **preserved and hardened** | `commitTerminalCheckpoint` owns `sql.begin`; `markOutboxFailed` is line 1 of the callback with the "Do not add a query or lock above this statement" comment retained. The helper takes `sql`, not `tx`, so there is no seam above the CAS at the call site. |
| solicitation-batch failed-hook: watchdog posture on throw (leave outbox `dispatched`, never split) | **preserved** | The `try`/`catch` stayed at the top level; `commitTerminalCheckpoint` documents "Throws on any write failure; the caller decides the recovery posture". `catch` logs `terminal_checkpoint_failed` and `return`s — no compensating write. Identical to `origin/main`. |
| solicitation-batch failed-hook: no use-before-assign on the new `let checkpoint` | **safe** | The `catch` block `return`s unconditionally, so `checkpoint` is definitely assigned at the final log. Typecheck agrees. |
| batch-builder `prepareBatch`: `evaluateBatchGate` before the `activeParent … FOR UPDATE` | **preserved** | `batch-builder.ts:221` (gate) precedes `:226` (agent_runs). Lock order is still accounts → agent_runs, identical to `origin/main`. Pinned by test 6. |
| batch-builder `constructBatch`: ownership CAS is the FIRST statement | **preserved** | `:584` `completeOwnedAttempt` is the first statement in the `begin` callback, comment retained. |
| batch-builder `constructBatch`: `built_at` UPDATE remains inline and last | **preserved** | `:682-695`, after `completeSolicitationBatchRun`, still with the `built.count !== 1` assert. |
| batch-builder `constructBatch`: advisory lock `solicitation_batch_<business>` still after the batch row lock, before the gate | **preserved** | `:603-607`, unchanged position and key. |

The only reordering anywhere in the diff is that the **pure** `closedGateReason(...)`
computation in `prepareBatch` now happens before the `agent_runs` SELECT instead
of after it. Its inputs (`account.subscription_status`, `getOffboardingState`)
were already read before that SELECT on `origin/main`; the only newly-earlier
call is `solicitationWatchEnabled()`, a `process.env` read. No I/O, no lock, no
observable difference.

---

## 5. Hunt D — shared-gate semantics

- **Still evaluated twice, in two separate transactions.** `prepareBatch` calls
  `evaluateBatchGate` inside its own `sql.begin`; `constructBatch` calls it again
  inside its own `sql.begin`. Nothing is cached across the boundary — the helper
  takes `tx` and performs its own account lock, account read and
  `getOffboardingState` on every call.
- Test 5 asserts `lockAccountBeforeOffboardingProjection` and `getOffboardingState`
  are each called **exactly twice** across one `buildSolicitationBatch`. Collapsing
  the two evaluations into one would fail this test.
- **Different run-failing postures preserved.** `prepareBatch` fails the run only
  `if (activeParent)` and reports `parentTerminalized: activeParent !== undefined`;
  `constructBatch` unconditionally fails `preparation.parentRunId` and reports
  `parentTerminalized: true`. Test 5 exercises both in one test (run 1 →
  `parentTerminalized: false` from prepare; run 2 → `parentTerminalized: true`
  from construct).
- Test 5 additionally asserts the account-read SQL **text** and the DELETE
  **text + values** are identical between the two call sites, which is the actual
  "one owner" claim rather than a proxy for it.

---

## 6. Hunt E — T6

- **`?accountId` rejected before owner resolution.** `route-helpers.ts:206-208`
  is the first statement of `requireSettingsOwner`, ahead of
  `requireOwnerWithAccount`. Test 7 asserts `mockRequireRole` is **not called**
  and `mockGetOffboardingState` is **not called** on the 400 path — a reordering
  would fail it. This is a genuine mutation-resistant assertion, not a status-code
  smoke test.
- **Impersonation branch unchanged.** `auto-approval/route.ts` still calls
  `hasImpersonationCookie(request)` *after* `requireSettingsOwner`, inside
  `patchSettings` only, returning `409 auto_approval_expansion_blocked` with
  `blockReasons: ['impersonation_not_allowed']`. `GET` still passes
  `impersonated: hasImpersonationCookie(request)` through to
  `getAutoApprovalSettings`. Neither moved.
- **Invariant #15.** `route-helpers.ts` does not import `@/lib/db/server`; it
  takes `sql: postgres.Sql` explicitly, exactly like its sibling
  `requireWritableOwner`. `pnpm ci:db-imports` passes in strict mode.
- **No import cycle / no boundary violation.** The new dependency is
  `@/lib/account-offboarding/gate`, whose only imports are `import type postgres`
  and `import type { ActiveOffboardingState } from './types'` — no runtime edges,
  no path back to `route-helpers`. `pnpm lint` and
  `src/__tests__/eslint-boundaries.test.ts` both pass.
- Both routes' now-dead `OwnerWithAccountResult` / `OwnerWithAccount` /
  `SettingsOwnerResult` aliases and their `getOffboardingState` /
  `isOperationalUIBlocked` imports were removed as specified. `NextResponse` is
  still imported where it is still used.
- `SettingsOwnerResult = OwnerAccountResult` mirrors the existing
  `WritableOwnerResult = OwnerAccountResult` convention — same result shape, so
  the 87 importers of `route-helpers.ts` see a purely additive export.

---

## 7. Hunt F — the 9 promised tests

All 9 `tests_to_add` titles exist verbatim, and each fails under the mutation it
claims to guard. Assessment per test:

| # | Title | Where | Would it fail if the contract were violated? |
|---|---|---|---|
| 1 | `acquireCsvIngestLock is the single owner of the csv_ingest advisory-lock key` | `ingest.test.ts` | **Yes, strongly.** Beyond pinning the key value, it walks `src/lib/solicitation` + `worker/jobs/csv-ingest` (excluding tests) for the literal `csv_ingest_${` and asserts the file list is exactly `['src/lib/solicitation/ingest.ts']`. Re-inlining the key anywhere in the lane fails it. |
| 2 | `the csv-ingest failed hook takes the advisory lock through acquireCsvIngestLock` | `csv-ingest/__tests__/index.test.ts` | **Yes.** Spies (not stubs) the real implementation, asserts it was called once with `(tx, 'business-1')`, that `sqlCalls[0]` is the lock (first-statement contract), and `invocationCallOrder` lock < CAS. Inlining the SQL back would leave the spy uncalled. |
| 3 | `writeTerminalUploadState guards the terminal write with the pending predicate` | `ingest.test.ts` | **Yes.** Asserts the exact bound-value tuple `['failed', report, 'upload-1', 'business-1', 'pending']`. Dropping the predicate shortens the array. |
| 4 | `ingestContactsCsvUpload completes normally when its terminal write finds no pending row` | `ingest.test.ts` | **Yes — this is the D1 test.** Drives the 0-row result and asserts the report is returned, the completion log fires, and no `warn`/`error` is emitted. Any assert/throw on row count fails it. |
| 5 | `prepareBatch and constructBatch derive the closed-gate reason from one owner` | `batch-builder.test.ts` | **Yes.** Asserts 2 gate evaluations (not 1), and byte-identical account-read text plus identical DELETE text and values across the two call sites. Both "collapse the double evaluation" and "let the two SQL copies drift" fail it. |
| 6 | `evaluateBatchGate runs before the activeParent row lock in prepareBatch` | `batch-builder.test.ts` | **Yes, as a forward guard.** Asserts `accounts` index < `agent_runs` index by both `sqlCalls` position and `invocationCallOrder`. Note it also passes on `origin/main` — correctly so, since the contract is *preservation* of the existing lock order, not a change to it. |
| 7 | `requireSettingsOwner rejects an accountId query parameter with 400` | `route-helpers.test.ts` | **Yes.** Asserts `requireRole` and `getOffboardingState` were never reached — it pins the *order*, not just the code. |
| 8 | `requireSettingsOwner returns 403 when offboarding blocks the operational UI` | `route-helpers.test.ts` | **Yes.** Asserts 403 + body + `Cache-Control: no-store, private` + `getOffboardingState('acct-1', fakeSql)`. Dropping the gate yields `ok: true`. |
| 9 | `requireSettingsOwner forwards the owner when the account is not offboarding` | `route-helpers.test.ts` | **Yes.** Exact object equality on the success shape. |

A 10th test was added beyond the promise (`forwards the AuthError response (401)
without touching the offboarding gate`) — additive, no contract impact.

No existing test assertion was deleted: the four test files' deletions total 4
lines, all of them import/mock-declaration lines replaced in place
(`route-helpers.test.ts` −1, `ingest.test.ts` −2, `csv-ingest/index.test.ts` −1,
`batch-builder.test.ts` −0). The acceptance criterion "every existing suite stays
green unmodified" holds.

---

## 8. Hunt G — drift

**Edit surface.** All 14 changed files are inside `allowed_edit_surface`:

```
src/app/api/settings/auto-approval/route.ts        ✓
src/app/api/settings/competitors/route.ts          ✓
src/lib/auth/route-helpers.ts                      ✓
src/lib/auth/__tests__/route-helpers.test.ts       ✓
src/lib/solicitation/batch-builder.ts              ✓
src/lib/solicitation/__tests__/batch-builder.test.ts ✓
src/lib/solicitation/ingest.ts                     ✓
src/lib/solicitation/__tests__/ingest.test.ts      ✓
worker/jobs/csv-ingest/failed-hook.ts              ✓
worker/jobs/csv-ingest/__tests__/index.test.ts     ✓
worker/jobs/solicitation-batch/failed-hook.ts      ✓
docs/superpowers/plans/refactor-565-complexity-bundle-{intake.json,plan.md,deviations.md} ✓
```

Nothing outside it. The four allowed-but-untouched entries (the two integration
suites, `worker/jobs/solicitation-batch/__tests__/index.test.ts`) are correctly
left alone — the integration suites are the regression net and must stay
unmodified to be meaningful.

**Non-goals honoured.** No migration (head stays 089 — `supabase/migrations/`
untouched). No new flag or env var (`ci:process-env` baseline unchanged at 9,
`ci:static-policy` `NEXT_PUBLIC_*` allowlist unchanged). No dependency added.
`recordCompletedChildRuns` untouched (D4). `ingest.ts`'s four
`fallow-ignore-next-line complexity` comments and their justifications retained.
`worker/jobs/zernio/ingest-failed-hook.ts` untouched. `purge-stages.ts` untouched
(race filed, not fixed).

**`user_visible_behavior: None`.** Confirmed — nothing in the diff adds a
behavior, response field, log field, status, or reason.

**`edge_cases` — every entry handled:**

1. Ingest 0-row terminal write reachable, not asserted → §3. ✓
2. failed-hook / `terminalizeUploadForInactiveSubscription` 0-row silent no-op → both call `writeTerminalUploadState` and discard. ✓
3. Double gate evaluation not collapsed → §5, test 5. ✓
4. Different failure postures preserved → §5. ✓
5. `evaluateBatchGate` before `activeParent … FOR UPDATE` → §4, test 6. ✓
6. `?accountId` rejected before owner resolution → §6, test 7. ✓
7. Impersonation branch unchanged, PATCH-only, after the preamble → §6. ✓
8. `ci:fallow --gate new-only` is a regression check, not proof → run anyway, passes. ✓
9. `fallow health` cannot be gated directly → the JSON-plus-inline-check form was used and prints `PASS`. ✓

**Deviations file verdicts — are the ACCEPTs justified?**

- *Deviation 1 (`prepareBatch` not decomposed)* — **justified.** T5's own text
  said "decompose further only if the targeted check still flags it". The
  targeted check prints `PASS` with `prepareBatch` untouched, reproduced
  independently in this review. Churning it would have been the wrong call.
- *Deviation 2 (the finding was CRAP, not raw cyclomatic)* — **justified, and the
  correction is the honest version.** It changes no decision; recording it
  prevents the next reader inheriting a too-tidy dichotomy. The follow-up (#581)
  is filed rather than silently absorbed.
- *Deviation 3 (`commitTerminalCheckpoint` owns its `sql.begin`)* — **justified,
  and stronger than the plan.** A `tx`-taking helper would have left a seam above
  the CAS at the call site, which is precisely what the in-code warning polices.
  Owning `begin` makes "CAS first" structurally unbreakable. Failure semantics
  verified unchanged in §4: the `try`/`catch`, the `terminal_checkpoint_failed`
  log, and the leave-it-`dispatched` posture all stayed at the top level, and a
  throw from inside `begin` lands in exactly the same handler it did before.

---

## 9. Findings

### >=80% confidence

| Severity | File:line | Finding |
|---|---|---|
| Info | `docs/superpowers/plans/refactor-565-complexity-bundle-deviations.md` | The "Gate — re-classification trigger fired" section (+30 lines, recording the 1662-vs-420 diff-size WARN and the lane re-derivation) exists only in the working tree — `git status` shows the file as ` M`, so it is **not** in `origin/main...HEAD`. As committed, the branch's deviations file omits the re-classification record. Commit it before opening the PR. |

No correctness or spec-fidelity defect was found. The refactor is
behavior-preserving on every axis the contract names.

### Low-confidence appendix (NOT findings — recorded for completeness)

1. **Query-text whitespace changed for the two de-duplicated statements.** The
   shared `deleteUnbuiltBatch` / `evaluateBatchGate` bodies are indented 4 spaces
   where the two originals were indented 6–8. Postgres.js sends the literal
   template text, so the SQL *string* differs from `origin/main` even though the
   parsed statement is identical. Consequence is limited to `pg_stat_statements`
   grouping and prepared-statement cache identity — no semantic effect, and the
   two call sites now genuinely share one text (which is the point of the
   ticket). Not a defect.

2. **Test 6 also passes on `origin/main`.** `evaluateBatchGate runs before the
   activeParent row lock` cannot fail on the base branch, because the base
   already takes the accounts lock first. It is a forward regression guard, which
   is the correct instrument for a preservation contract — but it should not be
   read as evidence that the branch *fixed* an ordering. The deviations/plan text
   already frames it as "pinned by a promised test", which is accurate.

3. **`TerminalUploadWrite` and `writeTerminalUploadState` are now exported from a
   module that a client component imports** (`UploadCard.tsx` imports from
   `@/lib/solicitation/ingest`). The import there is type-only and both
   `eslint-boundaries.test.ts` and `pnpm lint` pass, so invariant #1 is intact;
   noted only because the module's public surface widened toward the browser
   boundary. If a future edit makes that import runtime-valued, the boundary test
   is the backstop.

4. **`pnpm test` does not load `TEST_DATABASE_POOL_URL`**, so the two integration
   suites named in `verification_commands` do not run under the plain `pnpm test`
   invocation and did not run in the 9434-test sweep above; they had to be
   invoked directly. Pre-existing and already documented in CLAUDE.md, but worth
   restating for whoever signs off on the staging ride: the batch-builder
   integration suite is the real regression net for the T5 rewrite and must be
   run explicitly.
