# Codex Adversarial Review

Target: branch diff against a7dd67eeb2785bb354418c7639bc4f998f8915f9
Verdict: needs-attention

Do not ship: authorization can become stale before the wire send, the veto anchor can authorize after a known failed delivery, Judge availability fails open, and finale-time gating can capture pre-enable batches.

Findings:
- [high] Authorization expires before the irreversible send boundary (src/lib/solicitation/release.ts:2047-2084)
  The auto-policy conditions and Judge health are checked while moving an outreach to queued and creating an outbox job. The actual provider call happens later, after that transaction and potentially after a crash or queue backlog. Dispatch rechecks only the master send flag, not the auto-approval flag, entitlement, policy, suspension, approval method, or Judge health. Consequently, an already-queued email still leaves after the owner removes the policy, Governor suspends autonomy, entitlement lapses, or Judge becomes unavailable, violating the contract's no-email-leaves invariant.
  Recommendation: Make the queued-to-sending transaction the final authorization boundary. Under batch-then-account locking, reread approval_method and all auto-policy conditions plus Judge liveness immediately before committing sending, or introduce a revocable authorization epoch that dispatch validates.
- [high] Provider acceptance can authorize a known-undelivered veto notice (src/lib/solicitation/auto-approval.ts:617-633)
  The immutable deadline is anchored to MIN(sent_at), which records provider acceptance rather than owner delivery. Email can be accepted, set sent_at, then hard-bounce; the webhook records failed_at but neither clears nor blocks the already-derived deadline. An email-only owner can therefore receive no veto notice while the batch releases after the window. This reverses the governing design's stated delivered-notice safety property for the owner's only chance to stop irreversible sends.
  Recommendation: Separate accepted_at from delivered_at and anchor receipt-capable channels on confirmed delivery. At release, reject acceptance-only anchors that later hard-bounced and require another delivered enrolled channel; define an explicitly conservative fallback for channels without delivery receipts.
- [high] The Judge availability gate reports a dead Judge as healthy (src/lib/solicitation/release.ts:1479-1489)
  Release treats isJudgeHealthy as its fail-closed Judge prerequisite, but that probe explicitly cannot detect a dead sweep that never enqueues work. With no stale Judge outbox row and no error verdict density, it returns healthy indefinitely even though the Judge pipeline is not operating. Because this lane has no per-solicitation Judge decision, releases can continue while the claimed autonomy safety dependency is completely dead.
  Recommendation: Gate on a durable sweep/worker heartbeat or renewable liveness lease that becomes unhealthy when no Judge work cycle completes within the threshold. Validate that signal again at the actual send boundary.
- [medium] Finale-time evaluation can auto-approve batches created before enablement (src/lib/solicitation/auto-approval.ts:426-449)
  The finale reads only current flags and policy state; no durable value records whether the batch was eligible when constructed or generation began. Thus a batch built while auto approval was disabled can become auto_policy if its finale is delayed or retried after enablement. The integration test explicitly demonstrates this transition on a previously built batch, contradicting the locked non-retroactivity assumption and exposing already-visible content to a newly enabled autonomous send path.
  Recommendation: Snapshot auto-lane eligibility or a flag/policy epoch when the batch or generation job is created and require that snapshot at finale. Add an interleaving test for enablement during generation and revise the misleading non-retroactivity test.

Next steps:
- Redesign the final authorization boundary and veto-anchor semantics before merge.
- Add crash/backlog, hard-bounce-before-release, dead-Judge, and flag-flip-during-generation interleaving tests.

[exited with code 0]

## Orchestrator triage (2026-08-24, receiving-code-review)

- A1 (send-boundary re-auth) — REJECTED. The queued→sent boundary is the
  Dispatch gate, LOCKED at seven items by amendment B6/B14; dispatch.ts's
  module header states verbatim that account-level facts (subscription, caps,
  breaker — and by the same seam, the auto conditions) are "the release
  poller's to decide (#900), never an item here". #631 checks every auto
  condition at release (arm-level + in-tx row guard). Residual exposure =
  queued-not-yet-sent rows at revocation time, bounded by
  RELEASE_PER_TICK_BUDGET=2/60s + queue latency; the owner's mid-drip
  recourse is the Halt latch, which dispatch's current-state item honors.
  Re-opening B6 is a map-level question, recorded here and in the PR for the
  owner's step-8 read — both positions preserved.
- A2 (bounce-then-anchor) — ACCEPTED narrowly: the anchor's scan EXISTS and
  CAS MIN subquery gain `failed_at IS NULL` (first provider-accepted send
  not known failed at anchor time). A bounce AFTER anchoring does not move
  an anchored deadline; multi-channel dispatch + owner_email_bounced
  classification bound the residue. Refines, does not reverse, the owner's
  sent_at re-lock.
- A3 (judge-health liveness blind spot) — REJECTED for #631, FILED as #949:
  pre-existing platform probe shared by the Reply lane; #631 must not grow
  Judge machinery. Real observation, wrong ticket.
- A4 (pre-enable batches) — REJECTED. The locked non-goal bans a retroactive
  SWEEP; a finale that runs after the flip decides with current state — that
  IS the locked decision-at-finale hook (plan decision 1). The
  non-retroactivity test's comment is tightened to say so (F-A4).
