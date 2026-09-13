# Run C map gap: imported-review exclusion

**Verdict: ACCEPT — owner-approved 2026-09-13.** The owner answered "Yes go for it". The approval covers durable ingestion-origin markers, counts from confirmed live reviews only, and a visible label for reviews excluded because their origin is unknown. There is no migration. The prior RE-PLAN evidence stays below unchanged. Root revision 3 passed independent plan verification; see `plan-review-round-3.md`.

**Prior verdict (retained): RE-PLAN — owner decision pending.** The user requires imported reviews excluded from the consequence counts, no migration in Run C, and a stop on map-level doubts. The original T5 plan assumed persisted import provenance. Source inspection disproved that assumption.

| Evidence | Implication |
|---|---|
| `src/lib/reviews/process-review.ts:71` and `:560` call the same `insertNewReviewRow`; its INSERT at `:192` stores no ingestion-origin field. | Live ingestion and unanswered imports are indistinguishable in the review row. |
| Both paths call `startReviewRun` with `review_ingested`; its `recordStep` at `process-review.ts:246` supplies no provenance detail. | The initial step does not distinguish their origin either. |
| `worker/jobs/zernio/zernio-ingest-shared.ts:504` stamps `external_reply_ingested_at` for imported answered reviews; `ZernioBackfillWorker.ts:363` sends unanswered imports through `importReview`. | The external-reply marker does not cover unanswered imports. |
| `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:141` resets `connected_at` on reconnect. | The current connection cutoff cannot reliably classify historical ingestion. |
| `src/lib/reviews/on-demand-generate.ts:145` stamps the later generation request's origin, regardless of ingestion origin. | A draft's existence or generation lane cannot establish review provenance. |
| Backfill runs retain aggregate counts, not review membership (`028_zernio_backfill_runs.sql`; `ZernioBackfillWorker.ts:407`). | Historical membership cannot be reconstructed from those counters. |

Root verified the shared insert and initial-step behavior. A separate read-only Codex audit (`/root/run_c_veto_lock_audit`) independently confirmed the gap, including reconnects, answered/unanswered imports and later on-demand generation. No data was modified during the audit.

The owner question (retained as asked) proposed adding durable ingestion-origin markers to existing run-step JSONB, without a migration; including only reviews proved to be live-ingested; and labeling how many older reviews were excluded because their origin cannot be proved. The other offered choice was to pause consequence work for a separate provenance prerequisite. No heuristic classification or silent denominator change is authorized.

## Approved decision (2026-09-13)

- Contract: `ingestion_origin` (`live | imported | unknown`) in the `review_ingested` step's `agent_run_steps.detail`. It is written by the run-spine single writer in the same transaction as the actual first insertion.
- Writers: `processReview` (default/`LIVE_INGEST_NEW` → live, `BACKFILL` → imported, other explicit lane → unknown). `importReview` → imported. `insertImportedReview` → imported, only when the returned id equals the pre-minted UUID; the billing account comes from `businesses`.
- Never: a marker on a losing insert, a content update or on-demand generation; a relabel or backfill; a live inference from connection dates, generation lanes or missing drafts.
- Reader: exact account/business/review match, consistently live markers only, deduplicated review IDs, `excludedImported` and `excludedUnknown` surfaced in stored server-only fields, cards and receipts.
- Scope: T5.0 prerequisite inside T5. Eight tracers stay. The four earlier approved deltas do not change. Added allowed paths are listed in the intake.
- Approved tradeoff: early after deployment, more reviews may be excluded as unknown than counted.
- Status: plan amendment approved in verification round 3. The ingestion writers and their tests are integrated, with 95/95 targeted tests passing against the disposable local database. Consequence reader and Apply integration remain in progress; this is not full-gate evidence.
