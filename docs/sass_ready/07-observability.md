# Spec 07 — Observability, Logging & Monitoring

> **Goal:** Structured logs with `account_id` on every line, Sentry SLO with P0/P1/P2 cadence, PostHog product analytics with documented event taxonomy, Bull Board for queue visibility, synthetic checks on critical paths, real-time ops dashboard.

---

## 1. Why this matters

You cannot diagnose what you cannot see. RepWorth has Sentry and structured worker logs already; the gaps are alert SLOs, a centralized log destination, a Bull Board, and a real-time ops dashboard the founder bookmarks.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Sentry initialized in `worker/sentry.ts`, `src/instrumentation.ts`, and `src/instrumentation-client.ts`; scrubber in `src/lib/shared/sentry-scrub.ts` (redacts key/secret/token/password/authorization).
- ⚠️ **Logging is NOT structured.** `src/lib/shared/logger.ts` emits plain text (`[Worker] [corr-id] message`) via `console.*` — **no JSON, no `account_id`**. ~166 raw `console.*` calls in `src/`. The "account_id on every line" goal is greenfield.
- ⚠️ **No AsyncLocalStorage** anywhere — there is no request/job context propagation to build on.
- **No Bull Board** (`@bull-board` not installed). 18 BullMQ queues defined in `src/lib/shared/queue-names.ts`.
- **No PostHog yet** (decided Step 0, install pending — see [Spec 01](./01-product-market-fit.md) §2a). No event taxonomy file.
- **Health checks:** the **worker** exposes `/api/health` via Fastify (port 3001); **Next.js has no `/api/health`** — a gap for synthetic monitoring.
- No log drain (Better Stack/Axiom/Datadog), no `docs/observability/alert-runbook.md`, no status page, no synthetic checks.
- ⚠️ **No CI at all** — there is no `.github/workflows/` directory. Every "fail the build" / "CI check" task here is **blocked on first standing up GitHub Actions CI** (see [Spec 24](./24-devops-deployment.md)).

## 3. Target state

### Sentry SLO
| Severity | Trigger | Channel | Ack | Resolve target |
|---|---|---|---|---|
| **P0** | Auth down, billing breach, data loss, cross-tenant alert, Stripe webhook signature invalid | Page (PagerDuty / BetterStack) within 5 min | < 15 min | < 4 hr |
| **P1** | Worker error rate > 5%, ingestion lag > 15 min, dunning email failure | Slack within 15 min | < 1 hr | < 24 hr |
| **P2** | UI errors, single-account anomalies | Daily digest | Next business day | Backlog |

Tune to < 5 false alerts/week or trust dies.

### Logging
- JSON structured logs everywhere (no `console.log` strings).
- AsyncLocalStorage middleware injects `account_id`, `business_id`, `request_id`, `user_id`, `worker_job_id` on every line.
- Centralize in **Better Stack** (formerly Logtail) — cheapest tier that meets retention. Alternatives: Axiom (cheaper at volume), Datadog (overkill).
- 30-day hot retention, 12-month cold (S3) retention.

### Product analytics — PostHog
- Free tier through 1M events/mo covers RepWorth for 12+ months.
- Standard events (single source of truth `docs/analytics/events.md`):
  - `signup_started`, `email_verified`, `gbp_pre_check`, `gbp_connected`
  - `first_review_ingested`, `first_response_drafted`, `first_response_approved`, `first_response_published` (= `activation_completed`)
  - `trial_started`, `trial_ended`, `subscription_started`, `subscription_canceled`
  - `csv_import_started`, `csv_import_completed`, `csv_import_failed_row`
  - `bullboard_admin_access`, `impersonation_started`, `impersonation_ended`
- Naming convention: `noun_verb_past_tense`.
- Properties typed and documented; every new event = PR with doc update.

### Bull Board
- Mount at `/admin/queues` behind admin auth + 2FA.
- Read-only by default; retry/remove gated by separate admin flag.
- Use `@bull-board/express` integrated with the worker's Fastify instance.

### Synthetic monitoring
Better Stack or Checkly hits every 5 minutes:
- `/api/health` (Next.js)
- `/api/worker-health` (Railway, exposed via worker Fastify)
- `/login` HTML render check
- `/signup` HTML render check
- Synthetic webhook (Stripe test event POST to `/webhooks/stripe`) — assert 200 + idempotency replay returns 200.

Page on **3 consecutive failures**.

### Real-time ops dashboard
**One dashboard, four panels** (BetterStack or Grafana Cloud):
1. BullMQ queue depth (actual names in `queue-names.ts`: `generate_response`, `send_notification`, `publish_response`, `ingest_zernio_review`).
2. Worker lag (job age p95 by queue).
3. Sentry error rate (last 24h, sliced by severity).
4. Stripe webhook lag (time between Stripe event timestamp and our `processed_at`).

Bookmark in browser bookmark bar.

### On-call rotation (solo founder)
| Wake at 3 AM? | Yes |
|---|---|
| Auth down | yes |
| Stripe webhook signature invalid (security) | yes |
| Cross-tenant alert (`row.account_id != session.account_id`) | yes |
| Data-integrity alert | yes |
| Any P0 | yes |

| Wait until morning? |
|---|
| Queue lag |
| Model fallback rate spike |
| Dunning email failures |
| Any P1, P2 |

Document trigger conditions in `docs/runbooks/oncall-3am.md` so future-you doesn't second-guess.

## 4. Implementation tasks

0. **Prerequisite:** convert `src/lib/shared/logger.ts` to JSON output and stand up GitHub Actions CI ([Spec 24](./24-devops-deployment.md)) — tasks 2/4 depend on both.
1. Add Better Stack drain to worker + Next.js. Pipe Sentry breadcrumbs + structured (JSON) logs.
2. AsyncLocalStorage middleware in both runtimes (net-new — none exists today). Verify every log line in staging has `account_id`.
3. Define alert routes in Sentry: P0 → PagerDuty, P1 → Slack `#oncall-p1`, P2 → daily digest email.
4. Build `docs/analytics/events.md` event taxonomy. Wire 10 launch events in PostHog (the [Spec 01 §2a](./01-product-market-fit.md) decision). Add a CI check that a new analytics `capture(...)` without a doc entry fails the build (`scripts/ci/analytics-events-audit.ts`) — **requires CI (task 0)**.
5. Install `@bull-board` and mount at `/admin/queues` (Next.js route or worker-Fastify mount with admin auth). Behind 2FA + audit log. (Not currently installed.)
6. **Build a Next.js `/api/health` route first** (only the worker has one), then configure 5 synthetic checks in BetterStack. Test the failure path manually.
7. Build the four-panel ops dashboard. Bookmark.
8. Write `docs/runbooks/oncall-3am.md` and `docs/runbooks/alert-tuning.md`. Quarterly: count alerts received, target ≤ 5 false / week.
9. Add `worker/jobs/__instrumentation/job-context-middleware.ts` if not present — ensures every BullMQ handler runs inside an AsyncLocalStorage context.

## 5. Acceptance criteria

- [ ] Logger emits JSON; every log line in Better Stack has `account_id`, `request_id`, `service` fields (worker or web).
- [ ] Next.js `/api/health` route exists (worker already has one).
- [ ] Bull Board installed + accessible at `/admin/queues`; read-only confirmed; retry gated.
- [ ] All five synthetic checks green in staging + prod.
- [ ] Real-time dashboard bookmarked and shows live data on all four panels.
- [ ] Event taxonomy doc exists; every event in the doc is firing in prod.
- [ ] GitHub Actions CI exists, and it fails if a new analytics `capture(...)` is missing from `docs/analytics/events.md`.
- [ ] Alert tuning review: false-alert rate ≤ 5/week.

## 6. Metrics & alerts

| Metric | Target |
|---|---|
| P0 page-to-ack latency | < 15 min |
| P1 Slack-to-ack | < 1 hr |
| False-alert rate | < 5/week |
| Log search p95 | < 3s |
| Bull Board uptime | 99.9% |
| Synthetic check coverage | 5/5 green |

## 7. Risks & mitigations

- **Risk:** Log volume spikes cost. **Mitigation:** drop debug logs at INFO+ in prod; sampling on noisy job classes.
- **Risk:** Alert fatigue. **Mitigation:** weekly tuning; auto-mute alerts at > 5/week until root-cause fixed.
- **Risk:** Bull Board accidentally exposed. **Mitigation:** 2FA + audit + IP allowlist if practical.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (cross-tenant alert)
- [Spec 08 — Reliability & Incident Response](./08-reliability-sre.md) (status page, runbooks)
- [Spec 11 — Data, Analytics & BI](./11-data-analytics-bi.md) (event taxonomy)
- [Spec 22 — AI/LLM Ops](./22-ai-llm-ops.md) (model fallback rate alert)
- Code anchors: `worker/sentry.ts`, `worker/index.ts` (Fastify `/api/health`), `src/instrumentation.ts`, `src/instrumentation-client.ts`, `src/lib/shared/{logger,sentry-scrub,queue-names}.ts`

## 9. Implementation in the current repo

- **The two cheap, high-leverage moves** are (a) make `logger.ts` emit JSON and (b) stand up GitHub Actions CI. Almost everything else (account_id-on-every-line, the analytics audit) builds on those two.
- **AsyncLocalStorage** is net-new in both runtimes. On the worker, wrap each BullMQ handler in `worker/index.ts` so `job.id` → `account_id` is bound; in Next.js, bind in `middleware.ts`. Then the logger reads from the store.
- **Bull Board** can mount directly on the worker's existing Fastify instance (it already serves `/api/health` on 3001) — simpler than a Next.js reverse proxy — behind admin auth + the IP allowlist.
- **Sentry** is already wired with a scrubber; the remaining work is severity tagging + alert routing, not init.
- **Health/synthetics:** add a trivial Next.js `/api/health` route group; point BetterStack at both it and the worker's `:3001/api/health`.

---
_Verified 2026-05-23 against migration head 042. Corrected logging (plain-text, not structured; no account_id), no AsyncLocalStorage, no Bull Board, no PostHog, no Next.js health route, and — critically — no CI to "fail the build" against. Fixed queue-name anchors._
