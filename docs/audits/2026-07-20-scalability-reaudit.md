# Scalability Re-audit — 2026-07-20

Re-run of the 2026-07-16 seven-dimension scalability audit, against `main` @ `05c10430`
(post PR #511/#512), after the wayfinder remediation campaign (issues #472–#511,
PRs #490–#511). Scored against the agreed capacity target
([#474](https://github.com/RepWorth/ai-review-responder/issues/474)): 250 locations at
6 months, ~125 reviews/day steady, burst 1000 events/10 min drained ≤30 min (alert
~1500 pending), 10 concurrent dashboard renders, single worker replica (ADR 0005).

Method: seven parallel read-only auditor agents, one per dimension, each verifying
remediation claims in code (file:line evidence), not docs. The original Jul-16 audit's
numeric scores were delivered in-conversation and never persisted; its 12-item
bottleneck list and remediation trail live in
[#472](https://github.com/RepWorth/ai-review-responder/issues/472).

## Scorecard

| Dimension | Score | One-line verdict |
|---|---|---|
| Statelessness | 8/10 | Outbox + watchdog fully restart-safe; coordination state in Redis; two in-memory rotation cursors (Zernio, Autonomy governor) are the residual gap |
| Database bottlenecks | 8/10 | Split pools, N+1s eliminated, wedge cured, migrations 079–082 verified; one missing `responses(review_id)` index for the HANDLED semi-join on the KPI path |
| Horizontal scalability | 8/10 | Most of the fleet is already multi-replica-safe and honestly documented, but the single-replica posture is enforced only per-process — a second replica degrades silently |
| Queue/async patterns | 8/10 | Dispatcher robust and drift-safe, worker-slot cap 9 boot-enforced, backlog alerting proven; burst proof covers dispatch only, not the `generate_response` LLM drain |
| Rate limiting / backpressure | 8/10 | Cost reservation is a genuine atomic hard gate ordered before every LLM call; XFF-rotating floods still reach Postgres before rejection; Upstash SPOF stalls generation on outage |
| Data volume assumptions | 8/10 | ArchivalPoller retention real across 8 tables (incl. `job_outbox` — #506 reaper deletion was unrelated); admin overview still loads all business rows into app memory |
| Caching | 7/10 | Tenant-keyed 45s fail-open Upstash cache with correct failure semantics; no dogpile protection, dashboard fully force-dynamic with no CDN layer, TTL-only invalidation |

**Overall: 7.9/10** (unweighted mean; every dimension ≥7).

## What the re-audit confirmed shipped (in code, not just docs)

- Boot-enforced summed LLM worker-slot cap of 9 reading *effective* `worker.opts`
  (`worker/config/startup-assert.ts:115-172`, wired `worker/index.ts:291-298`) — PR #511.
- Migration 082 NotificationFailoverPoller partial indexes; 080 scheduler dedup
  indexes + set-based `INSERT…SELECT ON CONFLICT DO NOTHING`; 081 durable
  `poller_cursors` keyset cursor with `write_seq` CAS; 079 archival indexes.
- Split Postgres pools with clamped read bulkhead (`sqlRead` [8,8], 8s statement
  timeout) + single-flight pool-wait observability (`src/lib/db/server.ts`,
  `src/lib/shared/pool-wait.ts`) — PR #510 / ADR 0009.
- Supavisor pipelining-wedge cure: strictly sequential health bundle with an
  anti-`Promise.all` invariant comment + dedicated `max:2` health client with
  recycle-on-timeout (`worker/background/pollers/health-alert/`) — PR #506.
- Account-dashboard N+1 eliminated: fixed 8-statement `GROUP BY business_id` wave
  independent of location count (`src/lib/dashboard/aggregate-queries.ts:104-241`) — PR #496.
- Backlog-depth alerting at 1500 default per dispatch table, alert firing proven by
  the burst drill's over-threshold arm (`scripts/burst-drill-load.ts`) — PRs #501/#509.
- Retention across 8 tables via batched `LIMIT 5000` / `SKIP LOCKED` deletes incl.
  `job_outbox` completed@7d / failed@90d and the agent-run spine@180d
  (`worker/background/pollers/ArchivalPoller.ts`) — PR #497. The reaper deleted in
  #506 was the pool-wedge connection reaper, not retention: no coverage regression.
- Row-load caps enforced as real SQL LIMITs (past-replies, admin business detail,
  cost report clamps) — PR #491/#493.
- Spend-safe Redis-outage semantics: `CostInfraUnavailableError` retryable at all
  four pre-LLM touchpoints; budget decisions terminal; `onFinalizeError` keeps paid
  drafts — #255 posture intact.

## Residual gaps (ranked)

1. **Caching has no dogpile/stampede protection and no edge layer** — a cold key or
   Upstash outage converts every concurrent render into a full DB compute
   simultaneously; dashboard APIs are `force-dynamic` with no `s-maxage` (the open
   question from #472 remains unresolved in code). Cheapest big win: single-flight
   the cache fill; then decide the CDN/ISR question.
2. **The 1000-event burst target is proven for outbox dispatch only** — a real
   review burst funnels into `generate_response` at 5 slots; the LLM drain, the true
   limiter, is unmodeled. A drill (or arithmetic + drill) against the LLM lane would
   make the ≤30 min claim honest end-to-end.
3. **Single-replica posture is documented, not enforced** — an accidental second
   replica silently doubles the LLM envelope (~18), un-serializes
   `update_stripe_overage` (corruption-class vs. Stripe idempotency), and
   double-fires process-local single-flight pollers. A boot-time advisory-lock
   "singleton worker" claim would make this fail loudly.
4. **Missing `responses(review_id)` index for the HANDLED-status semi-join**
   (`src/lib/kpi/service.ts:182-188`) — the two partial unique indexes don't cover
   `awaiting_owner_connect`, so uncached KPI recomputes can degrade to status-filtered
   scans as `responses` grows. Mitigated today by the 45s cache + read bulkhead.
5. **Upstash SPOF** (cache + rate-limit + cost-reserve + regen-budget + idempotency)
   — outage is spend-safe but stalls all generation until retry/watchdog recovery.
   Accepted posture (ADR 0005); revisit at the documented escalation triggers.
6. **In-memory rotation cursors** (ZernioRecentReviewPoller, AutonomyGovernorScheduler)
   reset on restart — coverage (not correctness) can starve tail connections under a
   pathological restart cadence; migrate to the existing `poller_cursors` mechanism.
7. **Ingress amplification**: XFF-rotating hostile traffic drives HMAC + an
   `inbound_events` INSERT per request before rejection; the limiter is documented
   best-effort. Postgres write load is the real boundary for a flood.
8. **Admin overview loads all business rows into app memory** (O(accounts), conceded
   in-code) — fine at target, needs keyset pagination before ~10× growth.
9. **Dead-letter/replay is manual** and failed-topic alerting covers only
   `publish_response` + `send_notification`.

## Verdict

At the #474 capacity target this system is production-ready on every audited
dimension; nothing found is a launch blocker. The score is capped below 9 by
headroom items — all of them either explicitly accepted postures (single replica,
Upstash SPOF, TTL-only cache) with documented escalation triggers, or cheap
follow-ups (single-flight cache fill, the `responses(review_id)` index, durable
cursors, an LLM-lane burst drill).
