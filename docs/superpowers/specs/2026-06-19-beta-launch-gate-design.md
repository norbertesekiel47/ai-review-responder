# Beta-Launch Gate — Implementation Design

**Date:** 2026-06-19 · **Branch:** `harden/beta-launch-gate`
**Source plan:** locked via grill-with-docs-codex (4 rounds, APPROVED) — see `~/.claude/grill-codex/20260618-203737/PLAN.md`
**Audit it derives from:** `docs/future-plans/2026-06-18-1000-business-readiness-audit.md`

## Goal
Implement the small, correct set of hardening the locked plan gates a **10–50 business paid beta** on (RepWorth auto-drafts replies and, after **owner approval**, posts to customers' public Google profiles). Defer all 1000-scale throughput/capacity work to growth triggers. **Do not break existing functionality.**

Framing settled in the grill: the content-safety control is **human-in-the-loop owner approval** (auto-approval stays OFF for beta), so the alerting we build targets **silent pipeline failure / dropped paid work**, which alerting *can* catch — not "bad auto-posted content," which a post-hoc page cannot prevent.

## Scope — what ships in this branch

### Code
1. **`HealthAlertPoller`** (`worker/background/pollers/HealthAlertPoller.ts`) — new factory-function poller mirroring `OutboxPoller` (start/stop, `setInterval`, time-bounded single-flight guard, `createWorkerLogger`, `sql` from `src/lib/db/server`). Interval env `HEALTH_ALERT_POLL_INTERVAL_MS` (default 300000 = 5 min). Registered in `worker/index.ts` start list + shutdown stop list.
   - **Checks (each a small pure fn → `Finding | null`, composed in the tick):**
     - oldest `job_outbox` **pending** age > `HEALTH_ALERT_PENDING_AGE_S` (default 900).
     - stale `dispatching` rows older than threshold.
     - terminal **`failed` outbox count by topic** over a window (esp. `publish_response`, `send_notification`).
     - **zero-delivery (primary):** `responses` in `pending_approval` whose `send_notification` outbox row is **completed** but with **no `notification_deliveries` row** — owner never told.
     - **zero-delivery (secondary):** `pending_approval` older than X with **no `approval_request` delivery row and no in-flight `send_notification`**, **excluding** open `flagged_responses` and by-design suppression (high-severity moderation hold, Zernio backfill) to avoid false pages.
     - **`flagged_responses`** unreviewed count > threshold.
   - **Emit:** `worker/background/pollers/health-alert/emit.ts` → `Sentry.captureMessage(message, { level, tags, extra })`. Sentry is the mandatory non-email route (routes to Slack/PagerDuty via Sentry alert rules). No Resend dependency in the probe.
   - **Dead-man:** each tick calls `Sentry.captureCheckIn({ monitorSlug, status })` (Sentry Cron Monitor pages on a missed check-in). Guarded to no-op without DSN. Plus `notePollerActivity` / `maybeLogPollerHeartbeat` for the existing idle-heartbeat log.
2. **`sendEmail()` chokepoint** (`src/lib/notifications/email/send-email.ts`) — wraps `getResend().emails.send(payload)` in a `Promise.race` timeout (`EMAIL_SEND_TIMEOUT_MS` default 10000; SDK has no AbortSignal). Returns `{ data, error }` on completion, **throws** on timeout (consistent with existing throw-on-error → BullMQ retry). Migrate the ~11 `resend.emails.send(...)` call sites under `src/lib/notifications/email/` to `sendEmail(...)`. Single sanctioned send path (future token-bucket home).
3. **`assertAlertSinkEnv()`** (`worker/config/startup-assert.ts`) — production+non-mock requires `SENTRY_DSN`; remove `SENTRY_DSN` from `warnMissingProductionEnv`; add to `assertWorkerStartupEnv`.
4. **Cost-cap exhaustion alert** — at the `CostLimitExceededError` / `GlobalCostLimitExceededError` catch in `worker/jobs/response-generation/generate-draft.ts`, emit `Sentry.captureMessage(level:'warning', tags:{cost_event:'limit_exceeded', ...})` before the terminal return. Behavior otherwise unchanged (still terminal).
5. **Upstash `commandTimeout: 3_000`** in `src/lib/db/redis-cache.ts` `sharedOpts`. A slow-but-connected Upstash now fails fast → existing retryable/fail-open paths handle it.
6. **Ranking `getJson` timeout** — `SERPAPI_TIMEOUT_MS = 12_000` passed in params at `worker/jobs/RankingTrackingWorker.ts` (mirrors the other two SerpAPI call sites).

### Docs
7. **Runbook** `docs/runbooks/beta-launch-alerting.md` — Sentry alert routing (Slack/PagerDuty) for P0/P1; Sentry Cron Monitor slug for the probe; external `/ready` synthetic check (both runtimes); the A4 acceptance drills; confirm `ADMIN_NOTIFICATION_EMAIL` routes to a monitored inbox; confirm `AUTO_APPROVAL_ENABLED=false` for beta.
8. **Env docs** — add `GLOBAL_DAILY_COST_LIMIT_CENTS` + `DAILY_COST_LIMIT_CENTS_*` to `.claude/reference/env-vars.md`; note new `HEALTH_ALERT_*` + `EMAIL_SEND_TIMEOUT_MS` vars.
9. **Launch checklist** — add the "subscription-invoices-only" beta operating constraint + the alerting gate items to `docs/launch-checklist.md`.
10. **Doc consolidation (E):** fold the audit's unique deltas into `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` (Upstash KEYS→SCAN, cost-ceiling sizing, DB/Supabase capacity, ArchivalPoller drain-loop, circuit breakers, scale-alerting); correct the audit's stale/overstated items (double-send, billing) and slim `docs/future-plans/2026-06-18-1000-business-readiness-audit.md` to a verdict pointing at the backlog.
11. **ADR** `docs/adr/000N-beta-launch-posture.md` — owner-approval-only beta on single-replica worker; auto-approval + scale hardening gated separately.

## Out of scope (deferred to backlog triggers)
Worker concurrency raise, horizontal scale / multi-replica decoupling, OutboxPoller priority, circuit breakers, ArchivalPoller drain loop, poller keyset rewrites, Stripe-webhook async decoupling, Upstash KEYS→SCAN, cost-cap non-terminal redesign, the `invoice.subscription` scoping code fix (documented as a beta constraint instead), BullMQ queue-depth alerting (outbox-failed-by-topic covers the public path for beta).

## Testing
- **TDD** the new logic: `HealthAlertPoller` checks (SQL text + threshold → finding, mirroring `OutboxPoller.test.ts` hoisted-mock style), `sendEmail` (throws on timeout, passes through on success), `assertAlertSinkEnv` (prod requires DSN; dev/mock no-op), cost-cap alert emit in `generate-draft`.
- **Regression safety:** `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm ci:tenant-scope` (new poller queries are tenant-aggregate/admin — confirm allowlist) and `pnpm ci:static-policy`. The email call-site migration is mechanical and typecheck-guarded.

## Risk controls (don't-break-functionality)
- Email migration goes through one chokepoint with identical `{data,error}` return + throw-on-failure semantics → no behavior change except a 10s ceiling.
- `commandTimeout` 3s is ~60× normal Upstash latency; a spurious timeout degrades to the existing retryable/fail-open paths, never a crash.
- `assertAlertSinkEnv` is production-only (NODE_ENV==='production' && !mock) — dev/CI/test unaffected.
- New poller is read-only (no writes), single-flight guarded, and registered/stopped like every other poller.
