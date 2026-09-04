Review standard: post-implementation red-team; only approach findings held at ≥80% confidence are included.

1. P1 — The runtime signal defends no currently reachable production state.

   Evidence: both producers of `AutoApprovalDecision` construct `blockReasons` locally from typed literals ([auto-approval.ts:318](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/worker/jobs/response-generation/auto-approval.ts:318), [auto-approval.ts:337](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/worker/jobs/response-generation/auto-approval.ts:337)); `persist.ts` calls those producers and passes the result directly without serialization or an untyped boundary ([persist.ts:305](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/worker/jobs/response-generation/persist.ts:305), [persist.ts:326](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/worker/jobs/response-generation/persist.ts:326)). The map is already total through `satisfies Record<AutoApprovalBlockReason, …>` ([vocabulary.ts:464](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/vocabulary.ts:464)), while precedence totality has its own compiler assertion ([vocabulary.ts:641](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/vocabulary.ts:641)).

   Consequence: the branch adds state, transport behavior, transaction-path branching, and substantial maintenance surface for a condition production cannot presently produce except through a future unsafe cast or mutation. It places the defence far from the hypothetical boundary that would create the invalid value.

   Smallest correction: do not ship the runtime signal; retain the existing compile-time assertions. If an untrusted or serialized source is introduced later, validate and report the invalid value at that boundary.

2. P1 — The process-wide latch contradicts the only threat model left after the compiler guarantees.

   Evidence: one boolean suppresses every later code ([write.ts:341](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/write.ts:341), [write.ts:506](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/write.ts:506)). The stated justification assumes a systemic static map hole, but that class is rejected by the map’s `Record<AutoApprovalBlockReason, …>` constraint. A value that actually escapes the union instead comes from unsound or unvalidated runtime data and may vary between decisions.

   Consequence: in the long-lived, single-replica worker, the first malformed value permanently suppresses a second distinct malformed value. The second event may identify a different unsafe producer and is not redundant evidence.

   Smallest correction: if the signal remains, latch per code with a small bounded set and emit one overflow marker when the bound is reached. Do not use one process-wide boolean.

3. P1 — Dynamic Sentry messages fragment one fault into arbitrary issue groups.

   Evidence: the capture message includes the joined code sequence ([write.ts:530](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/write.ts:530)), while the contract deliberately preserves order and duplicates ([write.ts:501](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/write.ts:501)). Repository operations already rely on grouping and per-issue throttling for repeated `captureMessage` events ([beta-production-standup.md:543](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/docs/runbooks/beta-production-standup.md:543)).

   Consequence: different sets, orderings, or duplicates generate separate issues, scatter one fault’s history, and bypass per-issue throttling. Which group appears depends on the first event after each worker restart.

   Smallest correction: use a constant capture message such as `auto_approval_unmapped_block_reason`; put the joined codes in `extra`, leaving the structured log to carry the same detail.

4. P1 — The chosen Sentry signal has no completed operator route.

   Evidence: the alerting runbook’s refusal-ledger rule covers `subsystem:refusal_ledger` only at `warning` ([beta-launch-alerting.md:54](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/docs/runbooks/beta-launch-alerting.md:54)), while the new event is `error` ([write.ts:530](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/src/lib/refusals/write.ts:530)). The same runbook still says an unmapped reason raises nothing while the switch is off ([beta-launch-alerting.md:71](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1105-unmapped-block-reason-signal/docs/runbooks/beta-launch-alerting.md:71)), despite declaring a non-email route mandatory.

   Consequence: the branch creates a Sentry issue but does not establish that an operator will be notified or know how to triage it. That falls short of the stated operator-signal outcome.

   Smallest correction: add a dedicated rule for `fault:unmapped_block_reason` at `error`, update the runbook’s now-false blind-spot statement, and verify delivery with a staging drill.

Low-confidence appendix: None.

VERDICT: REVISE