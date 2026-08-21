=== FINDINGS TABLE ===
severity | artifact:location | one-line finding
critical | Task 4 Step 2 / Task 6 Step 4 | Missing failing test: `resumes a sending Outreach row after a process-boundary retry with the original working unsubscribe URL and without persisting the raw token`
high | Task 6 Step 3 | Missing failing test: `terminalizes a terminal_other provider error without retrying or leaving the Outreach row sending`
high | Task 7 Step 1 / Task 0 test 23 | Missing failing test: `does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt`
high | Task 4 Step 3 / Task 0 test 13 | Missing failing test: `substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder`
high | Locked decision 1 / Task 1 Step 1 / amendment B10 | Missing failing test: `does not expose solicitation_send in QUEUE_NAMES before its producer ships enqueueSolicitationSend`

=== DETAIL ===

`mintUnsubscribeRawToken()` only yields raw material on the first insert, while the plan explicitly says a conflicting token row cannot reveal it. A crash after `tx1` commits but before the provider responds leaves `sending` plus only a hash. Task 6 nevertheless requires rebuilding an `OutboundMessage` on retry. Test 12 becomes green before the resume path exists, and neither it nor the six additions models this process boundary. The implementation must otherwise either fail recovery, send a broken/new URL, or persist raw token material.

`classifySendFailure()` has three results, but Task 6 specifies terminal handling only for `terminal_bounce` and retry handling only for `retryable`. `terminal_other` has no terminal transaction, child outcome, outbox completion, or settlement rule. The classification property can pass while such rows are retried incorrectly or remain `sending`.

The failed-hook test exercises only terminal exhaustion. Without the negative case, an implementation can terminalize on an earlier BullMQ `'failed'` event, close the batch, and let a later retry operate against an already failed Outreach row. That is exactly the predicate distinction the plan calls out, but does not enforce.

B4 requires both deterministic placeholders to be substituted in memory. The promised tests cover the unsubscribe URL and raw-token storage, but none verifies that the review-link placeholder is replaced before the adapter is called. A real recipient could receive an unresolved placeholder while every listed test still passes.

B10 says the queue constant and typed helper ship together with the producer’s first raw insert. Task 1 deliberately installs `QUEUE_NAMES.SOLICITATION_SEND` in the consumer PR while deferring `enqueueSolicitationSend` to #900, and incorrectly cites B10 as support. The amendment wins, so this is both a locked-decision conflict and an ordering error.

=== LOW CONFIDENCE ===

No unexpected missing current repository artifact was found among the cited paths, symbols, migrations, and constants; migrations 091, 097, and 110 exist. The absent cited paths are the plan’s explicitly designated new production/test files.

VERDICT: REVISE
hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Blocked
codex
This was a document-only adversarial review; your hard constraints explicitly prohibited running `scripts/verify-gate.sh`. The findings and `VERDICT: REVISE` are complete.
hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Completed
tokens used
78,734
This was a document-only adversarial review; your hard constraints explicitly prohibited running `scripts/verify-gate.sh`. The findings and `VERDICT: REVISE` are complete.

---

# Orchestrator triage

- **C1 resume/token** — ACCEPT. Serious. Undercuts locked decision 4. Escalated to the owner.
- **C2 `terminal_other`** — ACCEPT. Plan gains the third arm: `failed`/`send_failed`, no
  `bounced_at`, child `failed`, `closeBatchIfSettled` still called.
  New test: `terminalizes a terminal_other provider error without retrying or leaving the Outreach row sending`
- **C3 failed-hook negative case** — ACCEPT.
  New test: `does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt`
- **C4 review-link placeholder** — ACCEPT.
  New test: `substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder`
- **C5 B10 / QUEUE_NAMES** — **REJECT.** B10 assigns the constant and the helper to "#630",
  written before #630 was decomposed into #899 (consumer) and #900 (producer). A BullMQ
  worker cannot be registered without its queue name, and this ticket's scope §1 requires
  the worker to be registered here — so the constant must land in this PR by mechanics, not
  preference. B10's stated ARGUMENT ("a helper with no caller turns any later raw insert red
  outside the PR that introduced it") is about the HELPER only, and we defer that exactly as
  B10 asks. The proposed test is also not writable: it would assert the absence of the
  constant the worker registration requires. Recorded as amendment B15 in Task 8.
