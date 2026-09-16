# Run D — async and operations

Reviewer: native Codex `/root/run_d_standards_async_final` (also the independent standards reviewer; these are two axis reports from one reviewer).

Pinned HEAD: `8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2`.
Pinned fork/merge base: `a95478037fb662cae6ce2e4cc1eb89671016b492`.
Gate input: GREEN, fingerprint `7cc2dca733f1417ff888833d86ad14289a32e6484e9973d2f08f497a5cad65bb`, supplied by root; tooling was not rerun.

VERDICT: REQUEST CHANGES

## D-A1 — [medium / P2] Recover exhausted dispatching rows after the new coupled transaction rolls back

Confidence: 97% in the failure mechanism; 90% that it violates Run D's locked recovery contract.

Primary location: `worker/background/pollers/OutboxPoller.ts:251–265` (the new exhaustion transaction and reconciliation call). Missing continuation: the watchdog predicates at `OutboxPoller.ts:137–139` and `OutboxPoller.ts:161–163`.

On the final enqueue failure, `runOutboxDispatchFailure` successfully changes an outbox row from `dispatching` to `failed`, then executes the newly added turn reconciliation queries before commit. If a transient database failure or process interruption aborts this transaction after that first UPDATE, both writes correctly roll back. The durable result is an accepted turn beside `status='dispatching', attempts=max_attempts`, with no queued worker when enqueue truly failed. The new integration test `dispatch exhaustion rolls back the outbox transition when its turn update fails` explicitly asserts this exact resulting pair at `worker/background/pollers/__tests__/OutboxPoller.operator.integration.test.ts:129–133`.

That pair has no automatic continuation after the database recovers. The outer poller logs the rejection and leaves the cycle (`OutboxPoller.ts:523–525`). Its claim query only selects `pending` rows (`:205–207`). Watchdog terminalization only selects `dispatched` rows (`:137`), while stale `dispatching` recovery explicitly requires `attempts < max_attempts` (`:161–163`). Aging the timestamp cannot make either predicate match. The owner therefore remains in Preparing indefinitely instead of receiving the new `dispatch_exhausted` recovery action.

Scope distinction: the generic omission of exhausted `dispatching` rows already exists at the fork, and this report does not attribute that original omission to Run D. Run D introduces additional rollback points after an otherwise successful terminal CAS and specifically promises that a valid nonterminal turn retains recoverable work unless both rows terminalize atomically. Its new rollback test stops at atomicity and does not prove recovery of the state it leaves. This is the concrete interaction between the new transaction and the inherited recovery gap, not a request to redesign generic watchdog timing.

Smallest correction: give stale exhausted `agent_turn` rows in `dispatching` a topic-scoped watchdog terminalization path using the same transactional `reconcileTurnForFailedOutbox` helper. Keep the existing stale-dispatch age fence, attempt budget, live/contended-claim deferral, and other-topic behavior. Extend the rollback integration case to age the stranded row, run the production watchdog, and verify that the exact turn/outbox pair terminalizes together; a live or contended claim must remain recoverable.

Alert boundary: `checkStaleDispatching` will emit the generic `outbox_stale_dispatching` error after its configured age (default 600 seconds; `worker/background/pollers/health-alert/checks.ts:79,154–169`). This is observable, so the finding does not claim a total alert blind spot. That alert does not recover the turn, and `outbox_failed:agent_turn` does not see the row while it remains `dispatching` (`checks.ts:113–123`).

## Coverage and limits

Every line of `docs/reviews/finding-checklists/async.md` was read and checked for applicability. Review input was the supplied brief and final test-only addendum, with targeted committed source reads only; no tests, mutation repros, provider calls, tracked edits, or external mutations were performed.

The remaining inspected transitions preserve the intended properties: terminal CAS winners are read from persisted rows; account, turn, conversation and aggregate identities bind the affected turn; malformed account identities avoid unsafe casts; live or locked claims restore recoverable dispatched work; turn locks use `SKIP LOCKED` when holding the reverse outbox-first order; expired claims are revalidated under lock; stale attempts/tokens cannot refresh liveness or release another claim; healthy predecessor wait refresh and claim release commit together; delay scheduling failure rethrows to BullMQ; crashed dispatched waits age back into the existing watchdog. Successful terminalization stamps completion for the existing failed-outbox health check. The campaign's controlled recovery fixture is not treated as an alert-delivery drill, and the owner-approved shorter observation is not treated as 24-hour coverage.

No additional actionable async finding met the confidence threshold. The final sibling-proposal addendum changes only its test ordering oracle and does not alter the async assessment.
