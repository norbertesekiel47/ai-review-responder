# Adversarial approach review — ticket #657

- Branch: `feat-657-email-adapter-webhook-lane`
- Fork point: `a6e38fe9`
- Diff reviewed: `git diff a6e38fe9..HEAD`
- Date: 2026-08-16
- Codex session id: unavailable — this execution environment does not expose a stable session/thread identifier.

## What I read

Read in full before forming findings:

- `.feature/intake.json`
- `docs/superpowers/plans/2026-08-16-657-email-adapter-webhook-lane.md`
- `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-deviations.md`, including the orchestrator verdict
- `CONTEXT.md` — “Solicitation (send-mode)” and “Solicitation suppression & unsubscribe”

Also read `.claude/CLAUDE.md`, including the applicable architecture invariants.

## Findings

| severity | area | finding | consequence | confidence |
|---|---|---|---|---|
| high | Unmatched suppression-event retry | The asserted 300-second retry bound is not real. `throwUnmatched` deliberately produces a 503 for a hard bounce, complaint, or provider-suppressed event ([`worker/ingress/resend/solicitation-lane.ts:106-122`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend/solicitation-lane.ts:106)); after the timestamp check rejects later attempts, the handler returns 401 ([`worker/ingress/resend.ts:51-59`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend.ts:51), [`worker/ingress/resend.ts:130-133`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend.ts:130)). Resend retries any non-200 response on its documented schedule through two 10-hour attempts ([Retries and Replays](https://resend.com/docs/webhooks/retries-and-replays)). | If #630 never persists the provider message id (or an event genuinely cannot be attributed), the event remains `inbound_events.status='failed'` after the first failed claim ([`worker/ingress/shared.ts:42-50`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/shared.ts:42), [`worker/ingress/resend.ts:156-172`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend.ts:156)) while Resend continues sending non-success attempts for roughly 27 hours and may disable a continually failing endpoint. This is not a re-litigation of accepted deviation F1’s decision to retry the commit window; it finds that F1’s accepted rationale (“bounded for free” by a 300-second stale timestamp) is false under Resend’s retry contract. | 92% |

### Angle conclusions

1. Tag routing is a reasoned trade-off: Resend documents that sent-email tags are included in webhook events, and the code handles both documented object-map and historical array forms ([`worker/ingress/resend/solicitation-lane.ts:22-37`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend/solicitation-lane.ts:22)). A missing tag would lose solicitation attribution to the unchanged sibling path, but the rejected table-fallback design would make an unknown notification id indistinguishable from a routing fault; no qualifying alternative defect found.
2. The one-method adapter is speculative but sufficiently narrow, explicitly documented, and patterned after the existing publisher selector ([`src/lib/messaging/messaging-adapter.ts:19-68`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/src/lib/messaging/messaging-adapter.ts:19)). No qualifying premature-abstraction defect found.
3. The unmatched suppression-event retry correctly protects the #630 response-to-commit window and avoids duplicate suppression writes through the shared inbound-event claim plus first-write-wins ledger. Its claimed replay-window bound is defective as described above.
4. Global scope for bounce and complaint matches the locked shared-domain recipient/ecosystem signal rule. `provider_suppressed` is knowingly less trustworthy, but the documented correction path and loud divergence signal make that a deliberate, visible trade-off rather than a new qualifying defect ([`worker/ingress/resend/solicitation-lane.ts:287-324`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend/solicitation-lane.ts:287)).
5. Omitting delivered-at and lifecycle-status writes is a reasoned ownership boundary: #630 owns the send lifecycle and the lane intentionally observes sent/delivered without mutation ([`worker/ingress/resend/solicitation-lane.ts:139-145`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/worker/ingress/resend/solicitation-lane.ts:139)). This does constrain delivery analytics until #630 lands, but it is an explicit non-goal that avoids violating migration 091’s status ownership.
6. The two identities share timeout/idempotency plumbing only; they use separate lazy clients and the solicitation client fails closed, so a solicitation key/configuration failure does not select or mutate the transactional client ([`src/lib/notifications/email/client.ts:18-38`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/src/lib/notifications/email/client.ts:18), [`src/lib/notifications/email/send-email.ts:32-62`](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane/src/lib/notifications/email/send-email.ts:32)). No qualifying coupling defect found.

## Low-confidence appendix

- **Sub-80% — tag-loss fallback.** If Resend ever omitted tags for an event type, the hard-bounce/complaint fact would be handled by the notification sibling and silently miss the solicitation ledger. Current Resend documentation promises tag inclusion, and the plan explicitly rejects the ambiguous database-fallback alternative, so this is not a qualifying finding.
- **Sub-80% — delivery observability.** The deliberately absent delivery facts may delay recognition of a never-delivered campaign before #630 supplies lifecycle ownership. The intake expressly excludes these writes and the lane’s comment identifies the status-race reason, so this is not reported as a defect.
