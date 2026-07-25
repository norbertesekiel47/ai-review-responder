# Restart plan review — #543

## Verdict

**VERDICT: REVISE**

The amended intake, plan, and postmortem correctly preserve the whole-pool
5,000-contact window, send-only simulated contact history, issue #546's
out-of-flight boundary, and local-only migration posture during remediation.
The health-alert and independent-history-reduction findings are minimally
locked with named surfaces and verbatim regression tests.

## Blocking revisions

1. **Lock the referenced composite key explicitly.** T1 requires composite
   foreign keys but never names the required referenced uniqueness on
   `agent_runs`. State the full contract:
   `UNIQUE (account_id, business_id, id)`, child columns
   `(account_id, business_id, parent_run_id|agent_run_id)`, and
   `ON DELETE SET NULL (parent_run_id|agent_run_id)` so tenant columns remain
   non-null. Keep both cross-account and cross-Business rejection cases in the
   DB-backed migration test.
2. **Lock the offboarding race protocol, not only the predicate.** “Call the
   shared processing gate inside preparation” leaves the known READ COMMITTED
   race open unless the transaction first locks the account row and performs a
   later offboarding-state read. Name the existing
   `lockAccountBeforeOffboardingProjection` → `getOffboardingState` →
   `isProcessingBlocked` sequence (or an exactly equivalent shared helper) and
   require the race test to synchronize an in-flight `delete_data` writer,
   proving no candidate-history read or ask/child-run creation occurs.

No staging or production migration is authorized by the remediation tracer;
the plan correctly reserves staging apply for the later high-risk ship lane
and production apply for explicit promotion.

## Round 2

**VERDICT: APPROVED**

Both blockers are now closed:

1. The intake and T1 explicitly require
   `UNIQUE (account_id, business_id, id)`, tenant-composite parent/ask run
   foreign keys, and column-specific
   `ON DELETE SET NULL (parent_run_id|agent_run_id)`, with separate
   cross-account and cross-Business DB rejection cases.
2. Preparation explicitly requires
   `lockAccountBeforeOffboardingProjection` followed by a later
   `getOffboardingState` SQL command and `isProcessingBlocked` under READ
   COMMITTED. The synchronized `delete_data` race must prove the lock/read
   ordering and the absence of contact-history reads, asks, and child runs.

The revised contract is sufficient and minimal for remediation execution.
