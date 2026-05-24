# Spec 12 — Performance & Scalability

> **Goal:** Documented load-test breakpoints, latency budgets on every critical path, Lighthouse ≥ 90 on key surfaces, a known-bad scenario test (500-location account) walked before customer hits it.

---

## 1. Why this matters

Performance regressions are silent until a customer hits the cliff. RepWorth's worker scales horizontally cleanly, but the **largest-customer scenario** (chains with hundreds of locations) is the actual scaling test that matters — not concurrent users.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- BullMQ + Upstash queue separate from cache (architecture).
- Postgres.js verified (`src/lib/db/server.ts`): `statement_timeout: 30_000`, `prepare: false`, PgBouncer pooled `DATABASE_POOL_URL`.
- `@tanstack/react-query` installed; **no `web-vitals` / Vercel Speed Insights / Vercel Analytics** yet.
- **No load tests** (`tests/load/` absent), **no seed scripts** (`scripts/seed/` absent), no latency budgets published.
- Pagination partially exists (admin `PAGE_SIZE = 20`, server-paginated past-replies) but not enforced by a lint rule.
- ⚠️ Cache keys are **businessId / flow-state based** (`connect_pending:${businessId}`, `rch:channels:${accountId}:${locationId}`), **not** the spec's `acct:{account_id}:kpi` — align with the [Spec 03](./03-multitenancy-isolation.md) cache-key decision.
- ✅ **Base CI now exists** — the first secret-free GitHub Actions gate runs `lint`, `typecheck`, `test`, and `build`. Lighthouse-CI / perf gates still need a specialized follow-up workflow ([Spec 24](./24-devops-deployment.md)).
- Multi-location supports hundreds-of-locations per account but is not stress-tested.

## 3. Target state

### Load-test ceiling
- **k6 or Artillery** scripts in `tests/load/*.js`.
- Scenarios:
  - Webhook ingestion: ramp 1 → 1000 webhooks/sec, find breakpoint.
  - Dashboard load: 100 concurrent owners on dashboard home.
  - CSV import: simulate 5 concurrent 500-row CSV imports.
- Document results in `docs/runbooks/load-test-YYYY-MM.md`.
- Re-run after every significant architecture change.

### DB connection pool
- Supabase Pro: 15 direct + 200 transaction-pooled.
- Worker uses transaction-pooled (port 6543, set in Postgres.js client).
- Monitor `pg_stat_activity` via Supabase dashboard.
- Alert when > 80% of ceiling.

### BullMQ scaling
- Railway autoscaling: min 1, max 5 replicas (year 1).
- Triggers: CPU > 70% sustained 5 min OR memory > 80% OR queue lag p95 > 60s.
- Per-worker concurrency = `CPU_CORES * 2` for I/O-bound jobs (LLM calls, HTTP).
- Per-worker concurrency = `CPU_CORES` for CPU-bound jobs (CSV parsing, sentiment classification batch).

### Largest-account scenario
- Seed a test account at **500 locations / 10k reviews/month**.
- Walk every UI page; flag N+1 queries, unbounded lists, missing pagination.
- Profile dashboard home query under load; ensure `< 1.5s p95`.
- Worker handles 10k/mo trivially; the 500-location UI is the real risk.

### Latency budgets
| Endpoint / op | p50 | p95 | p99 |
|---|---|---|---|
| Auth (signup/verify-otp — ⚠️ there is no `/api/auth/login`; login is Supabase-client-side) | 200ms | 500ms | 1.0s |
| Dashboard home (GET /dashboard) | 600ms | 1.5s | 3.0s |
| Response generation (LLM call) | 4s | 8s | 15s |
| Webhook ingestion (POST /webhooks/*) | 80ms | 200ms | 500ms |
| Approval link click → published | 1s | 3s | 5s |
| CSV import (100 rows — `MAX_ROWS` cap, Step-0 decision) | 2s | 5s | 10s |

Tracked in PostHog or Vercel Analytics. Alert on 2× budget sustained 5 min.

### Frontend Core Web Vitals
Targets on marketing site **and** dashboard home:
| Metric | Target |
|---|---|
| LCP | < 2.5s |
| INP | < 200ms |
| CLS | < 0.1 |
| Lighthouse Performance | ≥ 90 |
| Lighthouse Accessibility | ≥ 95 |
| Lighthouse Best Practices | = 100 |
| Lighthouse SEO | ≥ 90 |

Use Vercel Speed Insights + Lighthouse-CI in GitHub Actions on PR previews.

### Caching strategy
- Read-heavy queries (KPI dashboard, location list): `@tanstack/react-query` 5-min cache + Upstash cache key `acct:{account_id}:kpi:{date}`.
- LLM response cache: do NOT cache (every review is unique, cache hit rate < 1%).
- Static assets: Vercel CDN defaults.

## 4. Implementation tasks

1. Add `tests/load/` directory with k6 scripts for the three scenarios above.
2. Wire load tests to a Railway-or-staging environment toggle (never against prod).
3. Build seed script `scripts/seed/big-account.ts` that creates a 500-location / 10k-review test account.
4. Walk the UI on the big account; document N+1 hits and unbounded queries in `docs/runbooks/big-account-walkthrough-YYYY-MM.md`.
5. Add pagination to any unbounded location/review list (admin already uses `PAGE_SIZE = 20`; extend the pattern). A lint rule is optional and low-value given there's no repository layer to target.
6. Add Lighthouse-CI to GitHub Actions on every PR preview — **requires a specialized Lighthouse-CI job on top of the base CI** ([Spec 24](./24-devops-deployment.md)).
7. Add Vercel Speed Insights / web-vitals reporting.
8. Document latency budgets in `docs/perf/budgets.md`; alert in BetterStack on 2× budget.
9. Add `pg_stat_activity` watcher synthetic check (every 5 min) — alert at 80% of pool ceiling.
10. Set Railway autoscaling rules per §3.

## 5. Acceptance criteria

- [ ] Load test runbook exists; first run documented.
- [ ] 500-location test account walked; pagination/N+1 fixes shipped.
- [ ] Latency budget doc published; Sentry/BetterStack alerts wired.
- [ ] Lighthouse-CI passes on marketing site + dashboard home with the targets above.
- [ ] Connection pool utilization monitored; alert on 80%.
- [ ] Worker autoscaling verified by injecting a 100-job spike and watching replica count.

## 6. Metrics

| Metric | Target |
|---|---|
| Webhook ingestion breakpoint | ≥ 500 webhooks/sec |
| Dashboard home p95 | < 1.5s |
| Connection pool peak utilization | < 80% |
| Worker queue lag p95 | < 60s |
| Lighthouse Performance | ≥ 90 |
| Largest tested account size | ≥ 500 locations / 10k reviews/mo |

## 7. Risks & mitigations

- **Risk:** Load test against staging causes Supabase shared-cluster impact. **Mitigation:** use dedicated staging project + Upstash dev; cap RPS in script.
- **Risk:** Caching introduces stale data on dashboard. **Mitigation:** 5-min TTL with explicit invalidation on response publish.
- **Risk:** Worker autoscaling cost spike. **Mitigation:** budget alert in Railway billing; max-replicas cap.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (per-account scoping under load)
- [Spec 07 — Observability](./07-observability.md) (latency dashboards)
- [Spec 23 — Testing & QA](./23-testing-qa.md) (CI integration of perf checks)
- Code anchors: `worker/queues.ts`, `src/lib/db/server.ts` (Postgres.js pooled config), `src/app/admin/overview` (existing pagination), BullMQ workers in `worker/jobs/*`

## 9. Implementation in the current repo

- **The DB tuning the spec depends on already exists** (`server.ts`: 30s timeout, `prepare:false`, pooled URL). Net-new work is load tests, the big-account seed, web-vitals, and Lighthouse-CI.
- **Seed + load** go in new `scripts/seed/big-account.ts` and `tests/load/*` (neither dir exists). Run only against staging/dedicated Supabase + Upstash dev, capped RPS.
- **The real risk is the 500-location UI**, not throughput — walk it against the seed, fix N+1s and unbounded lists by extending the existing `PAGE_SIZE` pagination (admin/overview, past-replies).
- **web-vitals + Lighthouse-CI** both need adding (`web-vitals` not installed; base CI exists, but the specialized Lighthouse-CI gate is still pending). Lighthouse-CI is gated on [Spec 24](./24-devops-deployment.md).
- **KPI cache** should adopt whatever key convention [Spec 03](./03-multitenancy-isolation.md) settles (currently businessId/flow-state keyed, not `acct:`).

---
_Verified 2026-05-23 against migration head 042. Confirmed Postgres.js tuning; corrected the non-existent `/api/auth/login`, the missing web-vitals/Lighthouse-CI (+ pending specialized CI gate), the cache-key mismatch, and that load/seed infra is absent._
