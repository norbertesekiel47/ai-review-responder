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

`SENTRY_DSN` is a hard boot gate (`assertAlertSinkEnv`) — the worker will refuse
to start without it. Alerts must reach a **non-email** channel because admin
email shares the Resend provider with the product.

> **The gate keys off the deployment lane, not `NODE_ENV` (#611).** It fires on
> any deployed Railway lane (`RAILWAY_ENVIRONMENT_NAME` present) **or** any
> `NODE_ENV=production` run — `requiresProductionConfig()` in
> `src/lib/config/deployment-lane.ts`. This is an operational correction, not a
> restatement: production Railway leaves `NODE_ENV` **unset**, so while the gate
> keyed off `NODE_ENV` it returned early and was **inert in production** — the
> one environment whose paging it exists to protect. The same correction applies
> to `assertAdminNotificationEmail` (§3). Reasoning: ADR 0013.

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
- [ ] **Import consent analytics drift routed to Discord** — issues tagged
  `subsystem:import_consent_analytics` at level `warning`. Emitted by
  `emitConsentEvent` (`src/lib/reviews/import-consent.ts`) when an **Import
  offer** / **Import decision** analytics emission fails inside its savepoint and
  is swallowed; `tags.event_name` says which of the two was lost.
  **This one fires from BOTH lanes** — the Vercel Next server (Zernio connect,
  the dashboard Import offer route) and the Railway worker (the Stripe activation
  resume) — so route it on the tag, not on a project or a service.
  **It is a P2, not a page**: the caller committed and only a metric was lost, so
  the actionable pattern is *repetition*, not a single event. The overwhelmingly
  likely cause is migration 102 not applied to that Supabase project (`23514` on
  `analytics_events_event_name_check`); the fix is to apply it, never to silence
  the rule. A single event during a database blip is expected noise — postgres.js
  connection errors carry a `code` and land under the same tag by design (#697).
  **Use an event-FREQUENCY condition, not "a new issue is created."** The capture
  title is a constant, so every occurrence — both event names, every business,
  both lanes — groups into ONE Sentry issue. A new-issue rule would therefore
  fire exactly once, ever, and then stay silent through the very repetition that
  is the actionable signal. Suggested: _The issue is seen more than 3 times in
  one hour_.

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

## 1a-do. The Sentry click-path — every unconfigured rule, in one sitting

> **§1 and §1a above are authoritative** for *which* signals must route and *why*.
> This section adds only the **click-path and the exact field values**, in the
> order to do them, so the whole set can be configured in one session. If the two
> ever disagree, §1/§1a win — do not add a new signal here without adding it
> there first.
>
> Org `repworth-nv`. Do staging first, then repeat for the production project.
> Tick the matching box in §1/§1a as you complete each one.

**Step 0 — the integration (blocks every rule below).**
Sentry → Settings → Integrations → Discord → Add Installation → authorise → pick
the server. Confirm the Sentry bot has **View Channel + Send Messages** in
`#repworth-alerts`. Copy the channel ID (Discord Developer Mode → right-click the
channel → Copy Channel ID). On the Sentry free tier the native integration is not
available — create a Discord channel **webhook** instead and use it everywhere
below. → ticks the §1 "Install the Sentry → Discord integration" box.

Each rule below: Sentry → Alerts → Create Alert → **Issues** → set _When_,
_If_ (filter), _Then_ (action) → name it → Save.

| # | Rule name | _If_ filter | _When_ trigger | Level |
|---|---|---|---|---|
| 1 | `health-alert → discord` | `subsystem` equals `health_alert` | issue is **first seen** | `error` + `warning` |
| 2 | `cost-cap → discord` | `cost_event` equals `limit_exceeded` | issue is **first seen** | any |
| 3 | `stripe-reconcile-drift → discord` | `feature` equals `stripe_reconciliation` | issue is **first seen** | `error` + `warning` |
| 4 | `import-consent-analytics-drift → discord` | `subsystem` equals `import_consent_analytics` | **seen more than 3 times in one hour** | `warning` |

_Then_ action for all four: **Send a notification to the Discord integration** →
your server → the `#repworth-alerts` channel ID from step 0.

**Rule 4 is the odd one, and the difference is not cosmetic.** Rules 1–3 fire on
a new issue. Rule 4 must not. Its capture title is a **constant string**, so every
occurrence — both **Import offer** event names, every location, the Vercel lane
and the Railway lane alike — groups into ONE Sentry issue. A first-seen trigger
would fire once, ever, and then stay silent through exactly the repetition that
is the signal. See #697 and `.claude/reference/lab-notes.md` (2026-08-08).

**Step 5 — the dead-man switch.** The cron monitor is NOT an alert rule; it is
configured in §4 of this runbook (slug `health-alert-poller`, auto-created on
first check-in). Do §4 after the four rules above.

**Verify, do not assume.** Each rule is unproven until you have seen it deliver.
§4's acceptance drills are how — do not tick a §1 box on the strength of a saved
rule alone.

## 1b. Poller-resume — restoring the 5-minute `HealthAlertPoller` cadence (post-#505)

`HEALTH_ALERT_POLL_INTERVAL_MS` was overridden on staging to `86400000` (24h)
during #500/#502 as a mitigation: while the wedge was unmitigated, slowing the
poller's own health-check queries reduced how often it could trigger or
observe the wedge. Ticket #505 shipped the **boot-readiness cure**
(`worker/background/boot-stagger.ts`, ADR 0008 — spreads the boot-window
concurrency that is the leading, still-unproven, candidate for wedge
formation) and **kept** the #502 client-side bulkhead (dedicated health
client, `max:2`, recycle-on-timeout) as defense-in-depth. Together they make
the designed 5-minute cadence safe again — this is the procedure to restore it.

**Precondition:** the cure must be validated first — OP2 (repeated staging
treatment runs of `scripts/wedge-repro.ts`, zero wedge) and ideally OP3
(clean staging soak at the normal cadence, see below) before touching prod.

**Procedure — staging first, then prod at promotion:**

1. Confirm OP2 passed (T1 harness treatment run: zero wedge across repeated
   fresh boots) and the branch is deployed to staging with the cure enabled
   (`BOOT_STAGGER_ENABLED` unset/default — do not set it to `false`).
2. Railway → `repworth-staging` → worker service → Variables → **remove**
   `HEALTH_ALERT_POLL_INTERVAL_MS` entirely (don't set it to `300000`
   explicitly — per the "Poller cadence" glossary rule in `CONTEXT.md`, the
   code default is the authoritative value; the env var is only a per-env
   override, and removing it is how you hand ownership back to the default).
3. Redeploy/restart the staging worker so the env change takes effect.
4. Watch for several consecutive 5-minute cycles: the Sentry Cron check-in
   (`health-alert-poller` slug) should land every cycle with no missed
   check-ins, and `pg_stat_activity` should show no backend parked
   `active/ClientRead` and no bulkhead recycle log lines
   (`recycleHealthSql`). This clean-cycle observation **is** OP3 in the
   #505 plan.
5. Once OP3 is clean, repeat step 2 on the Railway **production** worker
   service at the same PR-to-`main` promotion that ships #505 — this is one
   of the two prod env removals the promotion requires (the other being any
   leftover `POOL_WEDGE_REAPER_*` variables from before T3 deleted the
   reaper's code path; the vars themselves may still be set in Railway even
   though nothing reads them anymore).
6. **Rollback:** if a wedge or a bulkhead recycle recurs at the 5-minute
   cadence on either environment, immediately re-set
   `HEALTH_ALERT_POLL_INTERVAL_MS=86400000` on the affected environment and
   treat it as a cure regression — re-open the escalation levers in ADR 0008
   rather than re-tuning the interval as a permanent fix.

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

## 2a. Post-deploy — clean up the cron monitor's stale `production` environment (#610)

**Run this once, after the #610/#611 deployment-lane change reaches an
environment.** Until that change, `worker/sentry.ts` derived Sentry's
`environment` from `NODE_ENV`, and staging runs with `NODE_ENV=production` — so
every staging `health-alert-poller` check-in was filed under a **`production`
environment that no production process ever wrote**. After the change the poller
reports its real lane.

- [ ] **Wait for the first correct check-in.** Sentry → Crons →
  `health-alert-poller` — a new `staging` environment appears on the monitor
  within one poll interval (default 5 min, `HEALTH_ALERT_POLL_INTERVAL_MS`).
- [ ] **Delete the stale `production` environment** on that monitor in the Sentry
  UI. It cannot be removed from code; it is monitor state, not an env var. Leaving
  it in place means the monitor keeps a `production` environment that will never
  check in again and will therefore page forever on missed check-ins.
- [ ] **Expect a CONTINUOUS stream of missed check-ins until you delete it — not
  one.** An earlier draft of this runbook said "exactly one transient missed
  check-in"; that was wrong, and the live deploy on 2026-07-28 disproved it. The
  stale `production` environment does not decay: nothing will *ever* check in
  under that label again, so the monitor records a fresh **missed** check-in every
  poll interval, indefinitely. Measured on the staging deploy: the `production`
  environment flipped to `error` and logged **8 missed check-ins in the first
  hour**, still climbing, while `staging` sat at `ok` throughout.

  So the missed check-ins are an artifact of the relabelling and **not** a
  worker-death signal — but they will keep firing until the environment is
  deleted, and they will drown a real dead-man-switch alert while they do. Delete
  promptly rather than waiting it out. If missed check-ins continue on the
  **`staging`** environment after the deletion, that IS real: work §2's
  dead-man-switch path.

> **Production needs no cleanup — as of 2026-07-28 there is nothing there to
> clean.** This monitor lives in the `repworth-staging` Sentry project, which is
> the only project in the org; there is no production Sentry project, and the
> production worker has never successfully deployed. The stale `production`
> *environment* on this monitor was written entirely by the **staging** worker
> mislabelling itself (#610) — no production process ever wrote it. When
> production is genuinely stood up (see `deployment-guide.md` §5.2, which is a
> provisioning job before it is a config job), it gets its own project and its own
> monitor, and this step does not repeat. Confirm rather than assume.

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
- [ ] **Backlog depth over threshold (the drill's over-threshold arm)** — via
  `scripts/burst-drill-load.ts inject --events ~1600 --available-in-min <K≥15>`,
  hold `job_outbox` pending `> HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` (default
  1500) across a poller tick; expect `backlog_depth:job_outbox` (`warning`) to
  fire, then run `release --drill-tag <tag>` and confirm it clears (pending
  drops below 1500 **and** a subsequent poller cycle completes a clean
  check-in emitting no such finding). Proves outbox dispatch-drain +
  `backlog_depth` observability under a held burst — **not** full
  ingest→draft→notification pipeline throughput. Full step-by-step procedure
  (Part B, over-threshold arm): `docs/runbooks/pool-wedge-burst-drill.md`.
- [ ] **#474 capacity burst (headroom, ticket #480)** — via
  `scripts/burst-drill-load.ts inject --events 1000 --duration-min 10`
  (immediately-claimable, the drill's headroom arm). Watch
  `GET /internal/queue-health` `backlog.job_outbox` climb then drain to
  baseline **within 30 min**, and confirm **no** `backlog_depth` warning fires
  (drain rate outpaces injection). Validates outbox dispatch-drain +
  observability without tripping the alert — same honest scope caveat as
  above (dispatch-drain, not full pipeline throughput). Full step-by-step
  procedure (Part B, headroom arm): `docs/runbooks/pool-wedge-burst-drill.md`.
  Run after §1b's poller-resume so the `HealthAlertPoller` is back on its
  designed 5-minute cadence for the drill.

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
| `HEALTH_ALERT_WEDGED_CLIENT_READ_AGE_S` | `10` | Age above which `state='active' AND wait_event='ClientRead'` is the #773 connection wedge (`db_connection_wedged`, error). **Age, never presence** — transient sub-100ms ClientRead is normal protocol traffic; 10s is above that noise and below the shortest observed wedge (16.6s). |
| `HEALTH_ALERT_WEDGED_CLIENT_READ_THRESHOLD` | `0` | Wedged sessions tolerated (0 → any pages). |
| `HEALTH_ALERT_MONITOR_SLUG` | `health-alert-poller` | Sentry Cron monitor slug. |
| `EMAIL_SEND_TIMEOUT_MS` | `10000` | Per-send Resend timeout (chokepoint). |

## Known limitation (deferred)

The "no `send_notification` outbox ever existed" secondary signal is **not**
implemented — it requires excluding by-design suppression (high-severity
moderation holds, Zernio backfill) to avoid false pages. The implemented
"completed-with-zero-deliveries" signal covers the common "owner never told"
case without that risk. Tracked in the worker-scaling backlog.
