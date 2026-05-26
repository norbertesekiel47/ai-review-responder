# Observability Runbook

How RepWorth is observed and how to triage the common failure shapes. RepWorth
is a solo-founder operation: this runbook optimizes for "what do I look at, in
what order" — not for a team rotation.

## Severity ladder

| Severity | Definition | Response |
|---|---|---|
| P0 | Customer data loss risk, billing incorrectness, auth/tenant-isolation breach, or total outage (web or worker down). | Drop everything, page-worthy at any hour. |
| P1 | Core flow degraded: review ingest stalled, responses not generating, notifications not sending, Stripe webhooks backing up. | Same-day; out-of-hours if trending worse. |
| P2 | Non-blocking: elevated LLM fallback rate, moderation spike, single queue lag within SLA, cosmetic errors. | Next business morning. |

## Signals

- **Structured logs** — every worker log line is one JSON object with
  `timestamp/level/service/logger/message` plus context IDs
  (`request_id`, `correlation_id`, `account_id`, `business_id`, `review_id`,
  `response_id`, `worker_job_id`, `outbox_id`). Filter by any ID to follow one
  unit of work.
- **Sentry** — exceptions + breadcrumbs (worker job lifecycle).
- **Health endpoints** — web `GET /api/health`, worker `GET /api/health`.
- **Admin queue view** — `/admin/jobs`: outbox summary + per-queue
  waiting/active/delayed/failed/completed/paused.

## Synthetic check list (configure as external gates)

- Web `GET /api/health` → 200, `service: "web"`.
- Worker `GET /api/health` → 200, `service: "worker"`.
- Login path.
- Signup path.
- One representative webhook path (Stripe ingress).

## Triage playbooks

### Queue lag
1. `/admin/jobs` — which queue has rising `waiting` / `delayed`?
2. Confirm worker is up (worker `/api/health`).
3. Check Sentry for repeated failures on that queue's handler.
4. Filter logs by `worker_job_id` / `correlation_id` for a stuck unit.

### LLM fallback-rate spike
1. Confirm OpenAI is the failing provider (logs on `ResponseGeneratorWorker`).
2. Check provider status; the Anthropic fallback should be carrying traffic.
3. If both degraded, expect generation backlog — comms, do not force-post.

### Moderation spike (Wave 3 later PR)
1. `/admin/flagged` volume + reasons.
2. Distinguish a real bad-output pattern from a false-positive rule.
3. Tune thresholds via the alert-tuning runbook; never auto-approve.

### Stripe webhook lag
1. `/admin/jobs` outbox + Stripe ingress errors in Sentry.
2. Verify signature/secret config; check reconcile pollers are running.
