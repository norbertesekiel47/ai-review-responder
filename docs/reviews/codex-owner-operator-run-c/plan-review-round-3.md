# Plan verification round 3

Reviewer: `/root/run_c_plan_skeptic` (same independent Codex reviewer, verification-only). Date: 2026-09-13. Reviewed root revision 3, the owner-approved ingestion-origin amendment, against current insertion and run-spine source. **Verdict: APPROVED.** No finding met the reviewer's 80% confidence threshold.

| Area | Evidence and conclusion |
|---|---|
| Actual insertion | `process-review.ts:192` returns the winning insert count. The answered-import `ON CONFLICT DO UPDATE RETURNING id` at `zernio-ingest-shared.ts:499` requires pre-minted UUID comparison. The amendment distinguishes both and prohibits duplicate/update relabeling. |
| Transaction and tenant | Existing run-spine APIs write the marker in the review insertion transaction. Billing tenant comes from `businesses`, following `process-review.ts:228`; the provider account ID is never used. Requiring a created run prevents completing an existing run. |
| Reader and counts | Exact account/business/review/run-kind/step matches; consistently live only; unknown/invalid/conflicting evidence excluded and labeled; deduplication before caps; retention/resurrection handled without inference. |
| Prior findings | PC1 token-domain invalidation, PC2 explicit query-order assertions, and PC3 candidate staging before promotion remain intact. |

The amended test contract covers atomic rollback, losing inserts, update non-relabeling, lane classification, answered-import races, billing-account resolution, foreign/mismatched markers, conflicting evidence, deduplication and rendered unknown exclusions. This is plan approval, not implementation or gate evidence.
