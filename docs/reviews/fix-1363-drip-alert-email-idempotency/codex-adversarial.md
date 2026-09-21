# Codex adversarial review — round 1

Target: branch diff against `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9`
Verdict: **needs-attention**

Do not ship yet: replay recovery permanently loses the provider-message
correlation needed for hard-bounce suppression and delivery tracking. The four
focused test suites could not execute because the read-only sandbox blocked
Vitest's temporary directory creation.

## Findings

**[medium] Synthetic replay IDs disable bounce handling for recovered sends**
`src/lib/notifications/email/templates/internal.ts:120-125`

When Resend accepts a nudge or drip and the worker crashes before recording
delivery, the retry can return this synthetic `messageId`. Both workers persist
it as `notification_deliveries.external_message_id` and complete the job,
leaving no row containing the original Resend ID. However,
`worker/ingress/resend.ts:200-245` correlates delivered, complained and bounced
events exclusively through that real ID. A subsequent hard-bounce webhook
therefore finds no delivery and returns before setting
`businesses.owner_email_bounced` or alerting the admin. Future owner emails
remain eligible despite the hard bounce, and the recovered delivery cannot
acquire `delivered_at` or failure information. This affects the exact
crash-recovery path the change introduces; no reconciliation or fallback lookup
exists.

*Recommendation:* preserve webhook correlation independently of the replay
sentinel. For example, create a durable delivery identity before sending, attach
its non-secret ID as provider metadata, and use it in the webhook to reconcile
the real Resend message ID. Store replay status separately from
`external_message_id`. Add a regression covering provider acceptance, failure
before delivery persistence, replay recovery, and a hard-bounce webhook that
must flag the owner and record the failure.

## Next steps (as issued)

- Repair replay-to-webhook correlation before merging.
- Run the crash/replay/bounce regression and the four focused suites in a
  writable environment.
- Confirm the branch's own required CI checks, including build, pass before
  shipping.

## Disposition (orchestrator)

**ACCEPTED.** Verified independently against `worker/ingress/resend.ts:229-246`,
and found independently by the async/operations and spec & correctness axes.

Resolved NOT by the recommended reconciliation route — that changes third-party
ingress and the webhook contract, which is out of scope for this ticket and now
a recorded non-goal — but by removing the precondition. Only a send whose body
can DIFFER between attempts reaches a 409, so the day_7 drip and the owner nudge
(both mint a fresh approval token per attempt) moved to mark-before-send and
carry no key at all. day_1, day_30 and the three partner alerts render from
stable inputs, so Resend replays the original response with the original message
ID and correlation is never at risk.

See deviations D8. The "four suites could not execute" note is a sandbox
limitation on the Codex side, not a branch defect; all four run green locally
and are covered by the gate's `test` row.
