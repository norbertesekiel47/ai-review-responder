# ADR 0005: Beta-launch posture — owner-approval-only, single-replica worker, scale & auto-approval gated separately

## Status

Accepted — 2026-06-19

(ADR number 0004 is reserved for the in-flight accessible-teal-token-split ADR.)

## Context

RepWorth is ready to take its first paying customers. A 1000-business readiness
audit (2026-06-18) catalogued throughput, capacity, and observability gaps and —
under a 1000-business assumption — labelled six of them "blockers." A
grill-with-docs-codex review (4 rounds, APPROVED) reframed the question against
the *actual* near-term target: a **10–50 business paid beta**, not 1000.

Two facts shaped the posture:

1. **The product posts irreversibly to customers' public Google profiles.** A
   wrong/embarrassing reply, posted and undetected, damages a *reputation*
   product. But auto-policy posting enqueues the publish immediately, in the same
   transaction as the approval decision (`worker/jobs/response-generation/persist.ts`),
   so after-the-fact alerting cannot *prevent* a bad auto-post.
2. **Nothing in the audit corrupts data or money** at any scale — billing math,
   idempotency, and tenant isolation are sound (verified). The failure mode at
   10–50 businesses is *degradation and operational blindness*, not corruption.

The single Railway worker runs every BullMQ worker at `concurrency: 1` and is
pinned to one replica by the `update_stripe_overage` serialization invariant.

## Decision

Launch the beta with a deliberately small, correct gate and defer everything
scale-shaped to explicit growth triggers.

1. **Owner approval is the content-safety control.** `AUTO_APPROVAL_ENABLED=false`
   for the beta. Every public post is preceded by an explicit owner approval — a
   human in the loop — so the irreversible-content risk does not depend on
   alerting. Auto-approval go-live is a **separate gate** (prod moderation
   validation, one-account canary, kill-switch drill, auto-post-FYI paging).

2. **Alerting targets silent pipeline failure / dropped paid work**, which it
   *can* catch: a `HealthAlertPoller` (Sentry-routed, non-email) for stuck/failed
   outbox by topic, zero-delivery approval notifications, stale dispatching, and
   the held-flag backlog; cost-cap exhaustion surfaced at the throw site; a
   Sentry Cron check-in as the probe's dead-man switch; and an external `/ready`
   synthetic check for whole-worker death. `SENTRY_DSN` is now a hard production
   boot gate (`assertAlertSinkEnv`) so paging cannot be silently inert.

3. **Two cheap critical-path timeouts ship too** (Resend send path, Upstash
   `commandTimeout`) because at `concurrency: 1` they are single points of stall
   on the approval/generation path regardless of scale.

4. **Everything throughput/capacity defers to triggers** (worker concurrency,
   horizontal scale, circuit breakers, ArchivalPoller drain, poller keyset
   rewrites, Stripe-webhook decoupling, Upstash `KEYS`→`SCAN`, cost-cap
   non-terminal redesign) — tracked in
   `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`, the single
   action list.

5. **Beta billing is subscription-invoices-only** — an explicit operating
   constraint (recorded in `launch-checklist.md`) so the un-scoped
   `invoice.payment_failed` handler (backlog P4 #11) cannot wrongly flip a paying
   account to `past_due`. The `invoice.subscription` scoping fix lands later.

## Consequences

- **Positive:** the gate is small and correct; the worst irreversible risk
  (bad public content) is removed by keeping a human in the loop, not by alerting
  it can't deliver. Nothing 1000-scale is built for a 50-business reality.
- **Negative / accepted:** the auto-policy value prop is *not* exercised in beta
  (that's what the separate auto-approval gate is for); the worker remains a
  single-replica SPOF (acceptable at founder-watched 10–50 volume, recoverable
  via the outbox watchdog); operational coverage assumes someone watches the
  Sentry/Slack route and the monitored admin inbox.
- **Reversal trigger:** crossing into "hundreds" of businesses re-opens the
  backlog's P1 items (poller bounds, worker concurrency) and this posture should
  be revisited — the HealthAlertPoller's outbox-lag signal doubles as an early
  tripwire.

## Addendum (2026-07-16) — capacity target locked; SPOF + LLM-cap deferral sharpened

Resolved in the scalability-hardening wayfinder map
([map #472](https://github.com/RepWorth/ai-review-responder/issues/472),
tickets [#474](https://github.com/RepWorth/ai-review-responder/issues/474) and
[#475](https://github.com/RepWorth/ai-review-responder/issues/475)). This
refines the posture above — it does not reverse it.

**Capacity target (#474):** 50 businesses at launch → 250 locations at 6
months (~100–150 accounts); ~125 reviews/day fleet-wide steady state; design
burst 1000 ingest events in 10 minutes, drained within 30 minutes with a
queue-health alert at ~1500 pending outbox rows; peak 10 concurrent dashboard
renders. Single-replica worker posture stays.

**Global LLM concurrency cap (#475): deferral held, trigger sharpened.**
While the worker is single-replica, the de facto global LLM cap is the
*summed* BullMQ concurrency across the LLM-calling queues (draft generation,
weekly summary, monthly impact, review triage, judge, onboarding demo). That
sum stays **≤8**, documented where `workerOpts` are defined. The global Redis
semaphore (beside the per-business one in `src/lib/costs/concurrency-guard.ts`)
is built only when any of: a second worker replica ships; the sum needs to
exceed ~10; Sentry shows sustained provider 429s.

**Upstash SPOF (#475): pause-and-resume is the documented posture.** An
Upstash outage pauses generation spend-safely (cost reservation precedes every
LLM call and requires Redis; `CostInfraUnavailableError` → bounded retry +
outbox watchdog) and auto-resumes; dashboards degrade to direct DB reads; API
rate limits fail open. Tripwires: the outbox backlog-depth alert
([#480](https://github.com/RepWorth/ai-review-responder/issues/480)) and the
existing outbox-lag alert. No multi-region replica; no Railway-Redis fallback
(it would re-couple the deliberately split Redis roles). Revisit at
auto-approval go-live or >500 locations.

**Amendment (2026-07-20) — inventory corrected, cap enforced at boot.**
PR #490's LLM-queue inventory omitted `generate_demo`, which is a real
`runLlmTask` caller (DemoGenerationWorker → `src/lib/demos/generator.ts` →
`src/lib/responses/generator.ts`). The true non-flag-gated worker-slot sum is
**9** (generate_response 5 + generate_demo 1 + weekly_summary 1 +
send_monthly_impact 1 + onboarding_demo_response 1), now enforced at boot by
`assertSummedLlmWorkerSlots` (`worker/config/startup-assert.ts`) with cap 9;
`judge_verdict` stays flag-gated and separately capped at 1. The ~10
global-semaphore deferral trigger and all other posture above are unchanged.
