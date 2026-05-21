# Spec 07 — Observability, Logging & Monitoring

> **Goal:** Structured logs with `account_id` on every line, Sentry SLO with P0/P1/P2 cadence, PostHog product analytics with documented event taxonomy, Bull Board for queue visibility, synthetic checks on critical paths, real-time ops dashboard.

---

## 1. Why this matters

You cannot diagnose what you cannot see. RepWorth has Sentry and structured worker logs already; the gaps are alert SLOs, a centralized log destination, a Bull Board, and a real-time ops dashboard the founder bookmarks.

## 2. Current state (RepWorth)

- Sentry initialized in `worker/sentry.ts` (scrubber delegated per PR #26) and `src/instrumentation.ts`.
- Structured logging in worker (per `worker/index.ts`).
- Architecture invariant: subscription guard pattern means many worker decisions are observable as no-op log lines.
- No Bull Board visible.
- No PostHog events documented in a taxonomy file.
- No `docs/observability/alert-runbook.md`.
- No status page or synthetic checks.

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
1. BullMQ queue depth (`response-generation`, `notifications`, `publisher`, `zernio-ingest`).
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

1. Add Better Stack drain to worker + Next.js. Pipe Sentry breadcrumbs + structured logs.
2. AsyncLocalStorage middleware in both runtimes. Verify every log line in staging has `account_id`.
3. Define alert routes in Sentry: P0 → PagerDuty, P1 → Slack `#oncall-p1`, P2 → daily digest email.
4. Build `docs/analytics/events.md` event taxonomy. Wire 10 launch events. Add CI check that any new `posthog.capture` call without a corresponding doc entry fails the build (script in `scripts/ci/posthog-events-audit.ts`).
5. Mount Bull Board at `/admin/queues` (Next.js route → reverse proxy to Railway, or direct iframe with admin auth). Behind 2FA + audit log.
6. Configure 5 synthetic checks in BetterStack. Test failure path manually.
7. Build the four-panel ops dashboard. Bookmark.
8. Write `docs/runbooks/oncall-3am.md` and `docs/runbooks/alert-tuning.md`. Quarterly: count alerts received, target ≤ 5 false / week.
9. Add `worker/jobs/__instrumentation/job-context-middleware.ts` if not present — ensures every BullMQ handler runs inside an AsyncLocalStorage context.

## 5. Acceptance criteria

- [ ] Every log line in Better Stack has `account_id`, `request_id`, `service` fields (worker or web).
- [ ] Bull Board accessible at `/admin/queues`; read-only confirmed; retry gated.
- [ ] All five synthetic checks green in staging + prod.
- [ ] Real-time dashboard bookmarked and shows live data on all four panels.
- [ ] PostHog event taxonomy doc exists; every event in the doc is firing in prod.
- [ ] CI fails if a new `posthog.capture(...)` is missing from `docs/analytics/events.md`.
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
- Code anchors: `worker/sentry.ts`, `worker/index.ts`, `src/instrumentation.ts`, `src/instrumentation-client.ts`
