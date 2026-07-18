# Runbook — Beta-Launch Alerting Gate

**Created:** 2026-06-19 · **Owner:** @norbertesekiel
**Applies to:** the 10–50 business paid beta. See ADR 0005 for the posture and
`docs/superpowers/specs/2026-06-19-beta-launch-gate-design.md` for the design.

The *code* half of the gate (the `HealthAlertPoller`, the `SENTRY_DSN` boot
assertion, the timeouts, the cost-cap alert) ships in branch
`harden/beta-launch-gate`. This runbook is the *operational* half — the
dashboard wiring and drills that turn those signals into a page. **Do not take
the first paying customer until every box here is checked.**

---

## 0. Owner-approval-only (content-safety control)

- [ ] **`AUTO_APPROVAL_ENABLED=false`** in production (Railway). This is the
  default, but confirm it explicitly — it is the control that keeps a human in
  the loop before anything posts to a customer's public Google profile. Turning
  auto-approval on is a separate, later gate (ADR 0005, §Decision 1).

## 1. Non-email paging route (mandatory)

`SENTRY_DSN` is now a hard production boot gate (`assertAlertSinkEnv`) — the
worker will refuse to start without it. Alerts must reach a **non-email** channel
because admin email shares the Resend provider with the product.

- [ ] **`SENTRY_DSN` set** in the Railway worker env.
- [ ] **Install the Sentry → Discord integration** — Sentry → Settings →
  Integrations → Discord → Add Installation → authorize → pick your server. Make
  sure the Sentry bot can **View Channel + Send Messages** in the alert channel
  (e.g. `#repworth-alerts`); copy the channel ID (Discord Developer Mode →
  right-click the channel → Copy Channel ID — the Discord action targets a channel
  by ID). _Native Discord integration needs a paid Sentry plan (Team+); on the
  free tier, route via a Discord channel webhook instead._
- [ ] **Sentry alert rule → Discord** for issues tagged `subsystem:health_alert`
  at level `error` (P0/P1) and `warning` (P1/P2): _Then_ action → **Send a
  notification to the Discord integration** → your server + channel. The
  HealthAlertPoller emits `captureMessage` with `tags.subsystem=health_alert` and
  `tags.finding=<key>`; the publisher failed-hook and crash net already
  `captureException` with tags.
- [ ] **Cost-cap alert routed to Discord** — issues tagged
  `cost_event:limit_exceeded` (emitted from `generate-draft.ts`) page the same
  Discord channel.

## 1a. Billing-reconcile drift routing (CONFIG-1)

> **CONFIG-1 (billing reconcile drift routing) — verified 2026-06-24.**
> Audited `repworth-nv/repworth-staging` issue alert rules: the only rule is the
> default "Send a notification for high priority issues" (ID 3608329) → action is
> **email to issue owners**; trigger is "high priority issue" (not level/tag-based).
> No Discord route is configured yet, and a `warning`-level `captureMessage` tagged
> `feature:stripe_reconciliation` (emitted by `drift-alert.ts`) does not reliably
> classify as high-priority → reconcile drift would be captured-but-not-paged.
>
> **Action taken (CONFIG-1 option b):** `drift-alert.ts` now emits **revenue-affecting**
> drift types (`quantity_mismatch`, `price_mismatch`, `upcoming_invoice_mismatch`,
> `missing_subscription`, `duplicate_subscription`, `status_mismatch`) at `level:'error'`.
> Only `locations_paid_mirror` stays at `warning` — it is a denormalized mirror column
> that is never billed (RECONCILE-F1, pure observability). `status_mismatch` was
> reclassified to `error` because `reconcile-account.ts` only pushes it AFTER the
> expected-status-window filter (`isExpectedStatusWindow`) rejects the combination, so
> any status_mismatch reaching `emitDriftAlert` is a genuine entitlement anomaly (e.g.
> DB `active` while Stripe `canceled` — serving a non-paying customer, or cutting off
> a paying one). The self-healing DB-`trialing`↔Stripe-`trialing` case is handled by
> an early-return in `reconcile-account.ts` and never reaches the alert sink.
>
> **Residual ops gap (launch checklist, not code):** configure the Sentry → Discord
> rule to ALSO route `feature:stripe_reconciliation` (the §1 Discord rules for
> `subsystem:health_alert` / cost-cap are still unchecked). Until then, billing-reconcile
> drift pages only via the high-priority → email path.

## 2. External liveness — the probe cannot watch its own death

- [ ] **Sentry Cron Monitor** with slug `health-alert-poller` (must equal
  `HEALTH_ALERT_MONITOR_SLUG`), schedule `*/5 * * * *` UTC, grace ~3–5 min. The
  poller `captureCheckIn`s every cycle (default 5 min,
  `HEALTH_ALERT_POLL_INTERVAL_MS`); route **missed/error** check-ins to the
  **Discord** integration so a missed check-in pages (dead-man switch for the
  probe / worker death).
- [ ] **External synthetic check** (Better Stack / Checkly) hitting the deep
  `/ready` endpoint on **both** runtimes (worker `WORKER_PUBLIC_URL/ready`,
  Next.js `/api/health/ready`), paging after 3 consecutive failures **to the same
  Discord channel** (Better Stack has a native Discord integration, or paste a
  Discord channel webhook URL: Discord → channel → Edit → Integrations → Webhooks
  → New Webhook → Copy URL). Railway's own healthcheck only hits the
  dependency-light `/api/health`.

## 3. Monitored admin inbox

- [ ] **`ADMIN_NOTIFICATION_EMAIL`** (already a boot assertion) points to an
  inbox a human actually watches — it is the *secondary* route for
  admin-exception / failover / engagement alerts.

## 4. Acceptance drills (run on staging before launch)

Each must produce a page on the **Discord** route (the non-email sink) within one
poll interval (the cost-cap drill fires immediately at the throw site):

- [ ] **Stuck outbox** — insert a `job_outbox` row `status='pending',
  available_at = NOW() - INTERVAL '20 minutes'`; expect `outbox_pending_age`.
- [ ] **Failed publish** — force a `publish_response` row to `status='failed'`;
  expect `outbox_failed:publish_response`.
- [ ] **Zero-delivery** — a `send_notification` row `status='completed'` with a
  `payload.response_id` that has no `notification_deliveries` row; expect
  `zero_delivery_notifications`.
- [ ] **Cost-cap hit** — set `GLOBAL_DAILY_COST_LIMIT_CENTS=1`, trigger a draft;
  expect a `cost_event:limit_exceeded` Sentry message.
- [ ] **Killed worker** — stop the worker process; expect the external `/ready`
  check to page.
- [ ] **Probe stopped** — stop just the poll loop (or block check-in emission);
  expect the Sentry Cron monitor to page on the missed check-in.
- [ ] **Backlog depth over threshold** — insert `> HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD`
  (default 1500) `job_outbox` rows `status='pending'`; expect
  `backlog_depth:job_outbox` (`warning`).
- [ ] **#474 capacity burst (headroom, ticket #480)** — inject 1000 ingest events
  in 10 min. Watch `GET /internal/queue-health` `backlog.job_outbox` climb toward
  ~1000 then drain to baseline **within 30 min**, and confirm **no** `backlog_depth`
  warning fires (1000 < 1500 headroom). Validates the observability + drain path
  without tripping the alert. *(HealthAlertPoller is paused on staging per #500;
  run this drill once it resumes — the check is already wired.)*

## 5. Tunable thresholds (env, all optional — defaults shown)

| Var | Default | Meaning |
|---|---|---|
| `HEALTH_ALERT_POLL_INTERVAL_MS` | `300000` | Probe cadence (5 min). |
| `HEALTH_ALERT_PENDING_AGE_S` | `900` | Oldest claimable outbox age before warning. |
| `HEALTH_ALERT_STALE_DISPATCHING_S` | `600` | `dispatching` age before error (watchdog-down signal). |
| `HEALTH_ALERT_FAILED_WINDOW_S` | `3600` | Window for terminal `failed` outbox rows. |
| `HEALTH_ALERT_FAILED_THRESHOLD` | `0` | Failed public-path jobs tolerated (0 → any pages). |
| `HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD` | `5` | Open `flagged_responses` before warning. |
| `HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S` | `3600` | Window for completed-but-undelivered notifications. |
| `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` | `1500` | Per-table pending backlog depth (`job_outbox`, `analytics_events`) before warning (`backlog_depth:<table>`). Sized to the #474 capacity target. |
| `HEALTH_ALERT_MONITOR_SLUG` | `health-alert-poller` | Sentry Cron monitor slug. |
| `EMAIL_SEND_TIMEOUT_MS` | `10000` | Per-send Resend timeout (chokepoint). |

## Known limitation (deferred)

The "no `send_notification` outbox ever existed" secondary signal is **not**
implemented — it requires excluding by-design suppression (high-severity
moderation holds, Zernio backfill) to avoid false pages. The implemented
"completed-with-zero-deliveries" signal covers the common "owner never told"
case without that risk. Tracked in the worker-scaling backlog.
