# Plan review round 2 — #679 Import consent worker guard

## Scope and baseline

Verification-only review of the 11 rows in the round-1 triage table. I inspected
commit `36134102` and the `4bef52d9..36134102` diff, then checked the revised plan
and intake against the cited source. I did not read a deviations file.

HEAD was `36134102441c0e8e5697fc561f1c6472364bc814`. The worktree was clean except
for the pre-existing untracked round-2 brief
`docs/reviews/feat-679-import-consent-worker-guard/plan-review-brief-round-2.md`.

## Result

All 11 round-1 findings are addressed. The two rejected sub-proposals are
supported by the source, and no fix introduces a defect. In particular, the new
business-row serialization closes both orders of the acceptance/guard race and
does not invert the lock order of another writer.

## Per-finding verification

| # | Round-1 finding | Disposition | Evidence |
|---|---|---|---|
| 1 | Lost-import race with acceptance | **Addressed** | Plan lines 61–89 and 249–266 require `sql.begin`, `SELECT … FOR UPDATE` on `businesses`, and `markOutboxCompleted(tx, …)` in that transaction. Acceptance already locks the business first (`src/lib/reviews/import-consent.ts:261-273`) and reaches the outbox afterward (`:302`, `:455-472`). The intake records the same load-bearing requirement at line 50 and adds the live race title at line 93. The two-order and deadlock checks are below. |
| 2 | Locked migration-rejection test was deleted | **Addressed** | The exact title is restored at intake line 116. Plan lines 191–199 require a live invalid insert in a rolled-back transaction and SQLSTATE `23514`; D1 at lines 347–354 explicitly retracts the deletion. |
| 3 | Decision analytics event was not proven to use the open transaction | **Addressed** | Plan lines 223–230 require `tx`, explicitly forbid outer `sql`, and require a forced-abort/no-surviving-event assertion. Intake line 109 contains the behavioral title. A transaction-buffered event and an outer-executor commit have different results under that abort, so the test pins the boundary rather than merely observing a successful commit. |
| 4 | Guard query did not pin `b.id = businessId` | **Addressed** | Plan lines 251–258 show the predicate, and lines 279–283 require assertions over both flattened SQL and the bound input value through `sqlCalls`. Intake line 91 carries the exact title. |
| 5 | Unsupported tier bypassed the guard | **Addressed; rejected reorder upheld** | The carve-out is explicit in intake line 51 and plan lines 297–307, with a new ordering title at intake line 100. Current code throws before the first SQL/provider/child action (`worker/jobs/zernio/ZernioBackfillWorker.ts:125-138`), and the existing test proves zero SQL, Zernio calls, imports, reconciles, or outbox completion (`worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts:259-273`). No import can occur; only throw/retry versus skip-complete differs. |
| 6 | Three hand-queued tests and unreachable missing-business log were omitted | **Addressed** | Plan lines 130–148 enumerate archived-location, missing-business, and already-completed; require the missing-business rewrite; and require both ordering JSDocs to change. The only production callers of `guardZernioJobEligibility` are the backfill and live-ingest workers; live ingest uses `jobKind: 'ingest'` and cannot depend on the backfill-only log. Literal search found only the one backfill test asserting `subscription_status=missing` (`ZernioBackfillWorker.test.ts:339-355`). |
| M1 | ADR 0015 has no R2 | **Addressed** | The plan header now cites ADR §§2–3 and locates R2 in spec §8a:301 (plan lines 6–14). ADR 0015 itself has numbered decisions §§1–4 (`docs/adr/0015-consented-import-unflagged-replacement.md:40-105`). |
| M2 | Spec producer count is stale | **Addressed** | Plan D8 at lines 378–381 records the source-verified four-producer reality and defers the out-of-surface spec correction. Source has three `enqueueInitialImport` callers plus the accepted-only reactivation insert (`src/lib/locations/archive-location-tx.ts:542-567`); spec lines 143–150 and 207–209 still say three. |
| M3 | Backfill INSERT line citation was inaccurate | **Addressed** | Plan lines 289–293 now distinguishes the branch at line 148 from the INSERT starts at `worker/jobs/zernio/ZernioBackfillWorker.ts:150` and `:163`. |
| M4 | Analytics CI was claimed to enforce the full taxonomy block | **Addressed; rejected audit-test upheld** | Plan lines 173–180 and intake line 60 now distinguish house style from CI enforcement. `parseDocumentedEvents` reads only the heading and optional Status (`scripts/ci/analytics-events-audit.ts:13-23`), while the audit checks only code/docs presence (`:26-43`). Its tests intentionally pass blocks containing only heading and Status (`scripts/ci/__tests__/analytics-events-audit.test.ts:4-39`). The other taxonomy fields are genuinely unenforced; adding a new repository-wide CI contract is outside this ticket's definition of done. |
| M5 | Intake misdescribed migration 097's test as live/locked | **Addressed** | Intake line 59 now calls it a pure SQL-text suite with neither live lock nor runtime DDL. That matches the suite header and imports (`src/lib/shared/__tests__/migration-097-suppression-analytics-events.integration.test.ts:1-24`). Plan lines 191–199 separately specifies 102's added live rejection assertion. |

## Finding 1 — race and lock-order proof

The revised sequence is:

1. `guardImportConsent` begins a transaction.
2. It locks the target `businesses` row with `FOR UPDATE` and derives consent from
   that locked row.
3. For a blocked state, it completes the current outbox attempt through the same
   `tx` before releasing the business lock.

Both interleaving orders are safe:

- **Guard first.** The guard locks the business, reads the non-accepted state,
  completes the old outbox row, and commits. Acceptance then acquires the business
  lock. Its `NOT EXISTS` query excludes the now-`completed` row and inserts a fresh
  runnable `pending` row. Final state: accepted consent plus one runnable import.
- **Acceptance first.** Acceptance locks the business, records `accepted`, sees the
  still-in-flight current row, and inserts no duplicate. The waiting guard then
  acquires the row lock and reads the committed `accepted` value, so it returns
  `proceed`; the current job performs the import. Final state: accepted consent and
  the already-dispatched job continues.

No lock-order inversion was introduced:

| Writer | Lock/touch order | Deadlock result |
|---|---|---|
| `recordImportDecisionAndEnqueue` | business row (`import-consent.ts:267-273`) → outbox read/possible insert (`:455-472`) | Same order as the guard. |
| `reactivateLocationTransaction` | lifecycle advisory lock → business row (`archive-location-tx.ts:396-412`) → account row (`:417-426`) → outbox insert (`:557-567`) | Never holds the target outbox row before requesting the business row. |
| Stripe `maybeEnqueueBackfillResume` | business row (`worker/ingress/stripe/shared.ts:114-120`) → possible outbox insert through `enqueueInitialImport` (`:171`) | Same order as the guard. |
| OutboxPoller claim | outbox-only atomic autocommit statement (`worker/background/pollers/OutboxPoller.ts:187-200`) → commit/release → BullMQ dispatch (`:206-208`) | It never holds an outbox lock while requesting a business lock. |

`markOutboxCompleted` accepts `SqlExecutor` and performs the outbox UPDATE through
the supplied executor (`src/lib/shared/outbox.ts:86-114`), so the plan's use of
`tx` is supported without a seam change. The required live race test is correctly
placed in a new `*.integration.test.ts` suite and must force this interleaving
against Postgres (plan lines 150–155).

## Finding 6 — missing-business reachability

Putting the consent guard immediately after `extractOutboxHandle` makes a missing
`businesses` row return `skipped` before any run INSERT or call to
`guardZernioJobEligibility`. Therefore the latter's backfill-only
`subscription_status=missing` branch is unreachable from the production backfill
worker. The branch remains usable defensively by the shared function, and live
ingest still receives its normal fail-closed missing-row behavior without the
backfill-specific log. No second production caller or second assertion depends on
that log, so rewriting the single worker test and the two ordering JSDocs is
sufficient.

## Validation

| Command | Result |
|---|---|
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 845 files passed, 42 skipped; 11,105 tests passed, 278 skipped |
| `pnpm ci:tenant-scope` | PASS — 414 entries, baseline 414 |
| `pnpm ci:rls-audit` | PASS — static coverage; live DB check skipped because `TEST_DATABASE_POOL_URL` was unset |
| `pnpm ci:analytics-events` | PASS |
| `pnpm ci:static-policy` | PASS — 1,123 files scanned |

The first sandboxed test/audit attempts hit environment-only `EPERM` errors when
`tsx`, fixture servers, and integration tests tried to use local IPC/localhost.
The required reruns outside the sandbox passed; no code failure remained.

## Appendix — deferred observation outside the round-2 change scope

An unchanged narrative line at plan line 26 still uses the shorthand “ADR 0015
R2.” The round-1 M1 target—the header citation—was corrected at lines 6–14, and
the round-2 brief forbids opening a new front against unchanged plan text. This
residual wording is therefore noted for the already-planned documentation sweep
and does not affect this verdict.

VERDICT: APPROVED
