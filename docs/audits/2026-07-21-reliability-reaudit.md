# Reliability Re-Audit — 2026-07-21

Re-run of the pre-production reliability audit after all 10 findings of the
2026-07-16 audit (8/10) were fixed and merged: PR #508 (P1/P2/P3/P5/P6/P7/P10),
PR #514 (P8), PR #515 (P9), PR #516 (P4). Method: four parallel read-only
dimension audits (worker resilience, external call boundaries, ingress/API/
dashboard, observability/recovery) against `main` @ `98b34249`, ≥80%-confidence
findings only, each dimension also regression-verifying the landed fixes.

## Overall RELIABILITY: 8.5 / 10  (was 8 / 10)

Sub-scores: worker resilience 7/10 · external boundaries 8/10 ·
ingress/API/dashboard 7.5/10 · observability/recovery 7.5/10.

**All 10 previous findings verified fixed and holding** (14 regression checks
across the four dimensions, all PASS): P1 CAS-first coupled tx; P2 bounded/
unbounded Supabase client split; P3 guardrail transient retry; P4
owner-unreachable marker + health finding; P5 emitter listeners + throttle;
P6 Fastify bounds; P7 outbox/inbound-event checks; P8 8s/0-retry under-lock
Stripe bounds; P9 breaker semantics + summed LLM slot cap (9) boot-enforced;
P10 per-widget degradation in both dashboard paths.

What keeps the score off 9+: one new HIGH (an alive-but-broken self-heal gap
on the cache Redis), and a cluster of capacity/paging posture items that are
individually medium and mostly documented-accepted.

---

## Prioritized fixes

**P1 — Cache-Redis dead-client has no self-heal; liveness check can't see it (HIGH)**
`src/lib/db/redis-cache.ts:32,58-65`. `retryStrategy` returns `null` after 3
failed reconnects (~1.2s outage), which puts ioredis in terminal `"end"` state;
`getCacheRedis()` caches that dead client forever (verified against ioredis
internals: commands then reject `Connection is closed`; auto-reconnect only
happens from `"wait"`). Railway's healthcheck is liveness-only (`/api/health`
returns ok unconditionally; railway.toml:22), so nothing restarts the worker.
Result: after any Upstash blip >~1.2s, `reserveCost`/`acquireConcurrencySlot`/
`checkIdempotentCache` throw retryable `CostInfraUnavailableError` forever —
every LLM job retries and fails platform-wide until a manual restart. The
crash-net governor never sees it (caught Redis rejection, not an un-awaited DB
one). Fix: never-terminal retryStrategy (or recreate the client on `"end"`),
attach `attachEmitterErrorLogger` to the cache client (it's the one Redis
client without it — redis-cache.ts:62), and add a health check or readiness
probe that exercises the cache client so the outage pages.

**P2 — Dashboard read waves run on the 3-slot write pool with no stampede guard (MEDIUM)**
`src/app/api/dashboard/route.ts:284,344,383` +
`src/lib/dashboard/service.ts:117-144` / `aggregate-service.ts:95-118`.
The ~14–19-query allSettled waves use `sql` (write pool, max 3, 30s timeout)
instead of the #510 `sqlRead` bulkhead (max 8, 8s) the KPI route uses, and the
45s cache has no single-flight — at TTL expiry concurrent renders all recompute
simultaneously. A cold-cache burst can hold all 3 write slots up to 30s,
starving approvals/outbox dispatch. Fix: route dashboard reads through
`sqlRead` and single-flight the cache recompute.

**P3 — Upstash remains an un-breakered SPOF for all paid generation (MEDIUM, known)**
`src/lib/db/redis-cache.ts:60` → `costs/tracker.ts`, `concurrency-guard.ts`.
Cost reserve, concurrency slots, and idempotency all gate on one Upstash
instance with no degraded path. Long-documented in CLAUDE.md; P1's fix removes
the *permanent* failure mode, but a sustained Upstash outage still halts
generation (by design: spend-safety first). Revisit only with a deliberate
design (e.g. bounded fail-closed queue-pause + alert), not a quick fix.

**P4 — Failover escalation paths have no independent watcher; Sentry is a single paging vendor (MEDIUM, partly accepted in ADR 0010)**
`NotificationFailoverPoller.ts:317-527`, `worker/index.ts:156-164`,
`health-alert/emit.ts:11-38`. If the failover poller dies or
`NOTIFICATION_FAILOVER_DISABLED` is misconfigured on, the "all deliveries
failed" and "stale >4h approval" escalations silently stop, with no health-check
equivalent; all health findings AND the dead-man cron check-in route only to
Sentry; the external `/ready` uptime check is documented but not yet wired in
prod. Fix bundle: a health check on failover-poller recency, an alert when the
kill-switch is on in production, wire the external uptime probe, and route
CRITICAL findings to the admin-email sink as a second vendor.

**P5 — Cumulative under-lock Stripe window is the residual, not per-call (LOW-MED)**
`src/lib/accounts/tier-change.ts:631,401,416`. Three sequential bounded calls
(retrieve + base update + overage mutation, each 8s + possible SDK-internal
ECONNRESET retry) can sum to ~24–32s under the advisory locks + FOR UPDATE.
Defense-in-depth: an aggregate under-lock budget, and/or
`idle_in_transaction_session_timeout` on the pools.

**P6 — `releaseConcurrencySlot` is non-atomic (LOW)**
`src/lib/costs/concurrency-guard.ts:65-72`. DECR + conditional SET '0' can be
interleaved by a concurrent Lua acquire, transiently over-admitting the
per-business cap (TTL-bounded). Fix: Lua-ify the release like the acquire.

**P7 — Degraded dashboard payloads are cached for the 45s TTL (LOW)**
`src/lib/dashboard/service.ts:130-143`. A transient blip during one widget's
query caches empty widgets and serves them after recovery; the aggregate path
documents this trade-off, the per-location path does it silently. Fix: skip
cache-write when any widget degraded (or document parity).

**P8 — Shutdown closes workers/queues with `Promise.all` (LOW)**
`worker/index.ts:724,727`. First close() rejection abandons the rest (watchdog
+ exit(0) backstop). Switch to `allSettled`.

**P9 — PostHog flush/shutdown awaited unbounded during drain (LOW)**
`src/lib/analytics/posthog.ts:58-72`. A hung ingestion endpoint delays
shutdown-drain; hot paths unaffected. Add a bounded race.

**P10 — Purge worker's Supabase param invites future unbounded injection (INFO)**
`worker/jobs/account-offboarding/purge-stages.ts:110`. Param named
`supabaseServer` with wide `SupabaseClient` type; composition root injects the
bounded client today, but nothing guards the next caller. Rename +
narrow/brand the type.

---

## Dimension notes

- **Worker resilience (7/10):** crash-net/governor/boot-stagger/shutdown/
  failed-hooks/emitter coverage "exceptionally hardened"; docked almost
  entirely for P1 above.
- **External boundaries (8/10):** every seam has explicit timeouts and bounded
  retries (Stripe 20s / 8s-under-lock, LLM 30s+0, Zernio 10s, channels 10s,
  SerpAPI 12s/2s, Supabase-bounded 10s, Sheets 5s, Redis cmd 3s).
- **Ingress/API/dashboard (7.5/10):** verify-first webhooks everywhere, solid
  dedup+reclaim, approval tokens fully locked down; weakness is the dashboard
  pool/stampede posture (P2).
- **Observability/recovery (7.5/10):** bulkheaded health client, sequential
  shared-fate bundle, dead-man cron check-in, hard boot gates; weakness is
  watcher-of-the-watcher coverage (P4).

Full per-dimension findings (including sub-80%-confidence appendices) are in
the four audit agents' inline reports, archived in the session transcript of
2026-07-21.
