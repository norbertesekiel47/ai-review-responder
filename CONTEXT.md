# RepWorth Domain Glossary (seed)

- **Review source**: a provider adapter (Zernio today) that ingests reviews and normalizes them to the `NormalizedReview` DTO; no source-specific fields leak past it. *(draft — to be sharpened in grilling sessions)*
- **Response / draft**: the LLM-generated reply to a review; it is only a draft until an approval method is recorded. *(draft — to be sharpened in grilling sessions)*
- **Approval method**: how a response earned the right to be posted — `owner` (explicit owner action) or `auto_policy` (server-only gated runtime, disabled by default). *(draft — to be sharpened in grilling sessions)*
- **Moderation hold**: a `high`-severity moderation flag writes a `flagged_responses` row and suppresses owner notification; only admin `approved_for_owner_review` releases it. *(draft — to be sharpened in grilling sessions)*
- **Account**: the billing parent (subscription, quotas, stored tier prices). **Business**: one Google Business Profile location under an account. *(draft — to be sharpened in grilling sessions)*
- **Outbox job**: follow-up work recorded in `job_outbox` in the same transaction as the state change; OutboxPoller dispatches it to BullMQ. *(draft — to be sharpened in grilling sessions)*
- **Full access**: subscription statuses (`active`, `trialing`) that `subscriptionGrantsFullAccess` treats as entitled; workers gate on it, never on a raw status literal. *(draft — to be sharpened in grilling sessions)*
- **Poller cadence**: a background loop's tick interval — owned by the code default (`DEFAULT_INTERVAL_MS`), overridable per-env via its `*_INTERVAL_MS` env var. Changing cost posture means changing the code default (rides PR + staging); the env var is a per-env operational override, never the authoritative value. *(coined in the cost-optimization wayfinder effort)*
- **Watchdog**: the recovery queries inside a dispatch poller (OutboxPoller's recover/terminate/stale-dispatching UPDATEs, AnalyticsDispatchPoller's stale-reclaim) that reclaim rows orphaned by crashes — distinct from dispatch itself, and allowed to run on a slower cadence than dispatch. *(coined in the cost-optimization wayfinder effort)*

## Capacity & scale (locked 2026-07-16 — wayfinder map #472)

- **Capacity target**: the load production is deliberately sized for — 250 locations at 6 months, ~125 reviews/day steady, a 1000-event/10-minute ingest burst drained within 30 minutes, peak 10 concurrent dashboard renders. Owned by ticket #474's resolution; ADR 0005 addendum mirrors it. Sizing beyond it requires re-opening the ticket, not silently raising numbers.
- **Design burst**: the worst-case ingest spike the pipeline must absorb without data loss — a multi-day Zernio webhook replay plus ~6 simultaneous onboardings (backfill capped ~50 historical reviews/location).
- **Summed LLM concurrency cap**: the de facto global LLM concurrency limit on a single-replica worker — the sum of BullMQ `concurrency` across all LLM-calling queues (≤8). Exceeding ~10 is a named trigger that forces building a global Redis semaphore first (ADR 0005 addendum).
