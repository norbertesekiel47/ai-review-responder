# F1 Owner-Unreachable Escalation — Step 6 Adversarial Review (Codex)

**Date:** 2026-07-21 · **Reviewer:** Codex (`/codex:adversarial-review`) · **Target:** branch `f1-owner-unreachable-escalation` (22 files, ~1971 insertions) · **Verdict:** needs-attention (1 high, 2 medium).

Triaged with `superpowers:receiving-code-review` — each finding verified against the code, not accepted/rejected on face. Owner made the two scope calls.

## Findings table + verdicts

| # | Sev | Finding (file:line) | Verdict | Disposition |
|---|---|---|---|---|
| 1 | high | Subscription/flag-skip retry clears the owner_unreachable marker → draft "silently stuck" (`NotificationWorker.ts:82-84`) | **Premise partly wrong + explicitly scoped out** | ACCEPT AS SCOPED — follow-up ticket |
| 2 | medium | Candidate SELECT doesn't exclude in-flight rows → 200-row batch starvation (`NotificationFailoverPoller.ts:172-191`) | **Real; genuine divergence from the all-failed/stale precedent** | FIXED (commit `96fe61cd`) |
| 3 | medium | Marker archived at 7d if failover stops before first refresh (`checks.ts:185-201`) | **Already owner-decided (R3-A, ADR 0010)** | ACCEPT AS SCOPED — follow-up note + ticket |

## Verification notes

**#1 — rejected the "no-ship" framing.** A subscription-skip retry writes `completion_reason = NULL`, and the de-conflated `checkZeroDeliveryNotifications` filter is `jo.completion_reason IS DISTINCT FROM 'owner_unreachable'` — `NULL IS DISTINCT FROM 'owner_unreachable'` is TRUE, so the draft is **still counted** by that check. It is observed, not silent. What is genuinely lost (durable 4h-floor signal + auto-retry loop) is the **intake's explicit designed behavior** — invariant: *"Owner-unreachable is CURRENT-state, not sticky: a later non-owner_unreachable completion (e.g. subscription-skip retry) supersedes a stale marker and stops the retry/escalation"* — and the non-goal *"No event-driven re-notify hook into the channel-enrollment-verification flow."* Not a regression: pre-F1 there was no retry loop at all, so a subscription-skip-transitioned draft lands exactly where it would have (the same windowed check, no auto-re-notify). **Fixing it (auto-re-notify on subscription/flag recovery) is the explicit non-goal → out of F1 scope.**

**#2 — fixed.** The existing all-failed (`NotificationFailoverPoller.ts:327`) and stale (`:439`) arms exclude in-flight `send_notification` rows in their candidate SELECT; the owner-unreachable candidate did not (kept them to satisfy R3-B: admin email fires even while a retry is in-flight). Owner chose to align with precedent: added `AND NOT EXISTS (send_notification IN pending/dispatching/dispatched)` to the candidate. Trade-off accepted: an in-flight draft's admin email now waits ~1 retry cycle (~2h) instead of firing immediately; the durable Sentry `checkOwnerUnreachable` COUNT (unbounded, not batch-limited) covers it meanwhile. The advisory-locked re-check is unchanged — its `in_flight` flag now guards the concurrency race (a second poller that enqueued between candidate-select and lock), and R3-B's email-on-`unreachable` still holds at the lock level.

**#3 — already decided.** This is the durability⨯archival coupling raised in Codex plan-review round 3 (R3-A) and owner-decided *accept + document* (ADR 0010, plan Self-Review). Codex's new nuance — failover *disabled* before its first retry-refresh → the original marker is archived at 7d with no pending/dispatched row for `checkStaleDispatching`/`checkOldestPendingOutbox` to catch — strengthens the case for the documented follow-up but doesn't change the accept decision. The poller runs under `createGuardedPoll`; explicit failover-poller liveness monitoring is a reasonable follow-up.

## Follow-up tickets (to file)

- **F1-followup-A (from #1):** Re-notify pending_approval drafts when subscription/channel eligibility recovers (past_due→active, channel flag re-enabled). Contradicts F1's "no event-driven re-notify" non-goal → deliberately deferred. Today such drafts are observed only by the windowed `checkZeroDeliveryNotifications` with no auto-re-notify.
- **F1-followup-B (from #1, pre-existing):** `checkZeroDeliveryNotifications` still fires on subscription-skip / all-flag-disabled zero-delivery completions (they lack their own markers) — already recorded in the plan residual-risks + ADR 0010.
- **F1-followup-C (from #3):** Independent failover-poller liveness monitoring, so a fully-disabled/failed failover arm (which would let owner_unreachable markers archive at 7d without refresh) is itself alerted on.
