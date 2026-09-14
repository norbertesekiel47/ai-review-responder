# Run D — focused async correction review

Reviewer: native Codex `/root/run_d_standards_async_final`, original D-A1 reviewer.
Reviewed committed HEAD: `bd23d56e542a825da1dc16b2c0375127ded2443c`.
Prior reviewed HEAD: `8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2`.
Scope: accepted finding D-A1 only; no new general review or unrelated fronts.

VERDICT: APPROVE

D-A1: RESOLVED. No further actionable findings in this correction.

The new terminal predicate at `worker/background/pollers/OutboxPoller.ts:142–148` selects the exact previously stranded state: an exhausted `agent_turn` outbox row in `dispatching`, once its timestamp is older than the existing two-minute dispatch claim fence or absent. Fresh dispatches remain untouched. The existing dispatched-row timeout and other-topic dispatching behavior retain their predicates and attempt budgets.

The row enters the existing terminal UPDATE and `RETURNING` path, then the same `reconcileTurnForFailedOutbox` call inside the watchdog transaction (`OutboxPoller.ts:149–157`). Consequently the accepted turn and its outbox terminalize together. A further transaction abort leaves the aged dispatching row eligible for the next watchdog cycle, closing the missing continuation identified by D-A1. Live or contended turn claims still use the unchanged reconciler's `SKIP LOCKED` and visibility check to restore recoverable dispatched work; deferred rows remain excluded from failed counts. The status-specific fallback describes a dispatching exhaustion accurately, while a nonempty existing error remains preserved.

Committed regression coverage now continues the original rollback case through a fresh watchdog no-op and an aged watchdog pass, asserting the failed pair, unchanged attempt count, matching non-null completion timestamps, and the dispatching fallback. Additional cases cover a live claim, an exhausted row from another topic, a missing dispatch timestamp, and a turn held by a concurrent completion transaction that subsequently finishes both records. These assertions address the correction's recovery, containment, and lock-order obligations directly.

Validation boundary: root reports the regression failed first at the accepted/dispatching pair and then passed, with 57 focused tests passing across four poller/worker suites. This reviewer inspected the committed change and its relevant source through `git show`; no tests, tracked edits, commits, providers, or external mutations were performed. This approval closes D-A1 only and does not certify concurrent verifier-budget changes or refresh the final feature gate.

## Prepared staging runner — focused operational review

The same native Codex reviewer separately reviewed the scoped staging runner before execution and approved its corrected form, committed at `091d86bc778480dfd3c2cbc9fbbf61017392bbe0`. Finding **D-RUN1 (medium/P2), ACCEPT and fixed**: cleanup ownership previously began only after the seed acknowledgement, and a hard timer could exit across cleanup. The corrected runner sets `seedAttempted` before the transaction, resolves uncertain commits by checking the six durable identities, retains exact ownership and activity guards, and uses a deadline flag so `finally` retains cleanup responsibility. Database waits can extend the nominal observation window; no hard wall-clock completion guarantee is claimed.

Reviewer verdict: **APPROVE; D-RUN1 resolved**. The reviewer confirmed that the seed transaction makes no pending outbox visible, requests no model work, and requires the actual deployed poller to produce the exact failed pair. This was read-only operational review, with no remote execution, tests, source changes, or provider calls. Execution and independent cleanup readback are recorded separately in the staging evidence.
