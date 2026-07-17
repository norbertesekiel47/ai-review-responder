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
