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
- [ ] **Refusal ledger disabled routed to Discord** — issues tagged
  `subsystem:refusal_ledger` at level `warning`. Emitted by **both** insert
  helpers — `writeRefusalEvent` and the set-based `writeRefusalEvents`
  (`src/lib/refusals/write.ts`) — through the shared `warnLedgerDisabled()`, once
  per **disabled episode** whenever
  `REFUSAL_LEDGER_ENABLED=false` and a write is attempted. **This is the only
  signal that the ledger has a gap** — the ledger structurally cannot show its
  own absence, since an absent row and a decision that never happened look
  identical at read time. **It is CONFIG-1's shape exactly** (see the audit note
  below): a `warning`-level `captureMessage` does not reliably classify as high
  priority, so today it is captured-but-not-paged. CONFIG-1's option (b) —
  raising the level — is **wrong here**: a flipped kill switch is a deliberate
  operator state, not an error, so this one needs the tag-based rule rather than
  a level change. The structured log line (`refusals:write`) is the durable
  second transport meanwhile. Added by #1009 (red-team RT-1).
- [ ] **Autonomy Governor candidate failure routed to Discord** — issues tagged
  `subsystem:autonomy_governor`, emitted by `AutonomyGovernorScheduler`'s
  per-candidate `catch`. **Unlike the row above this one is a `captureException`,
  so it defaults to level `error`** and Sentry's default high-priority rule should
  mail the issue owners. That is better than silence — but **email is NOT an
  acceptable alert route by this section's own standard** (§1's premise: admin
  email shares the Resend provider with the product), so this row is still a
  **gap**, not merely an upgrade, until the Discord rule exists. Two further
  caveats: the default-rule claim is unaudited in **production** (CONFIG-1's
  evidence is a 2026-06-24 audit of `repworth-nv/repworth-staging`), and email
  reaches issue owners rather than a paging channel. It matters
  because that scheduler is **not** a BullMQ worker, so `attachJobFailureSink`
  never sees it: before #1009 a failed suspension there reached `logger.error`
  and nothing else, leaving an account un-suspended silently on every 15-minute
  cycle. Added by #1009.
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
- [ ] **Send breaker re-page rule (#898, corrected by #907)** — finding key
  `solicitation_send_breaker_tripped`, `level: 'error'`, emitted by
  `checkSolicitationSendBreaker`. **It needs a rule of its own — rule 5 in
  §1a-do — and the first bullet's `subsystem:health_alert` rule does not
  discharge it alone.** That rule fires on *first seen*, and this finding is
  level-triggered: `evaluateSendBreaker` probes for an open trip before it
  measures anything and returns a finding on **every** poller tick while one
  stands. The trip and the re-page each carry a **constant title** so Sentry
  collapses repeats into one issue, which is correct grouping and wrong routing —
  two constant titles under a first-seen rule give two notifications, then
  silence, however many days sending stays halted. An open breaker is a **state,
  not an event**; one dropped page must never equal a silent platform-wide halt.
  This is inventoried here because it is also the one finding whose **response is
  a written procedure** rather than a code fix — solicitation sending is halted
  platform-wide and never self-clears until an admin resets it. **Response
  procedure:** `docs/runbooks/solicitation-sending-domain.md` **§8** (read the
  window figures → roll the platform ceiling down a stage → then reset at
  `/admin/solicitation`). Detail is aggregate-only — counts, rates and
  thresholds, never a recipient address or message body. Trip latency is bounded
  by one `HEALTH_ALERT_POLL_INTERVAL_MS` (§5), and the re-page cadence by rule
  5's frequency window.
- [ ] **Unattributed solicitation suppression (#967)** — issues tagged
  `feature:solicitation_lane` at level `warning`, title
  `solicitation_suppression_without_attribution`, emitted by
  `reportUnattributedSuppression` (`worker/ingress/resend/solicitation-lane.ts`).
  **This rule is not optional garnish — it is the whole replacement for a pager
  that #967 removed.** Before #967 an unmatched suppression-bearing Resend event
  threw, leaving `inbound_events.status='failed'`, which
  `checkFailedInboundEvents` pages on. #967 made that path **ack**, which is
  correct for the opt-out and for payload retention, but it also takes the event
  out of that alert set. With no rule here the capture lands in Sentry and pages
  nobody — the exact defect #967's review caught in the first draft, reproduced
  one layer out.
  **Use an event-FREQUENCY condition, not "a new issue is created"** — same
  reasoning as the two bullets above, and it bites harder here. The capture
  title is a **constant string**, so every occurrence across every account,
  every event type and both suppression sources groups into ONE issue; a
  first-seen rule fires once, ever. The signal is **a sustained rate**, because
  attribution can only go missing three ways and the benign one is expected:
  the seconds-wide window where #630 has committed a send but not yet its
  `provider_message_id`. Isolated events are that race and are noise. Suggested:
  _The issue is seen more than 3 times in one hour_ — matching rules 4 and 5.
  **What repetition means:** Outreach rows are disappearing under live sends,
  which is **#965**, still open and still an unexplained staging data loss. This
  rule is that investigation's production detector. The other two causes are
  benign-by-design (an account purge, whose whole point is that the global
  opt-out still lands) or already-logged (a send whose terminal CAS lost).
  **Response:** do not silence it. Compare `solicitation_outreach` row counts
  against `solicitation_asks` for the affected businesses and take it to #965.
  Detail is aggregate-only — the capture carries `event`, `source` and
  `ledger_row_written`, and **never** the recipient address, by design.
  Keyed on `feature:solicitation_lane`, which is unique to this capture across
  the whole codebase, so the rule is narrow by construction like rule 5.

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
| 5 | ~~`solicitation-send-breaker → discord`~~ **SUPERSEDED — do not build** | `finding` equals `solicitation_send_breaker_tripped` | **seen more than 3 times in one hour** | `error` |
| 6 | `solicitation-unattributed-suppression → discord` | `feature` equals `solicitation_lane` | **seen more than 3 times in one hour** | `warning` |

> **What actually exists, read back from the Sentry API 2026-08-31T22:25Z (G.3 D-3).**
> This table is the design; these are the rules. Re-read them before assuming a signal
> routes.
>
> | Project | Rule | Filters |
> |---|---|---|
> | `repworth-staging` | `3608329` *"Send a notification for high priority issues"* | four `Tagged event` filters matching production, added 2026-08-31 |
> | `repworth-production` | `3925256` *"Prod — four ops signals to Discord"* | `subsystem=health_alert`, `cost_event=limit_exceeded`, `feature=stripe_reconciliation`, `subsystem=import_consent_analytics` |
> | `repworth-production` | `3920752` *"Send a notification for high priority issues"* | none; **New/Existing high priority issue** triggers only, throttle `0` |
>
> **Rules 1–3 are not separate rules.** Their three signals are three of the four
> `Tagged event` filters on the single rule each project carries. That is the named
> tradeoff G.1 recorded — one rule, not four — and it is why rule 4's
> `subsystem:import_consent_analytics`, specified as *frequency*-conditioned, currently
> shares a first-seen-plus-`Every event` rule. Split it if it proves noisy.
>
> **⚠️ CORRECTION 2026-09-01 (G.3 D-8) — the frequency condition EXISTS. Read this before
> concluding any rule here is unbuildable.** It is no longer a **trigger**; it is a **filter**.
> In the Alert Builder it appears as **"Issue frequency"** under *Filter by issue attributes*
> and stores as `Issue occurrences`. An earlier session looked only in the trigger dropdown,
> found five state-change options, and concluded the whole class had been removed — which would
> have written off rules 4, 5 and 6 as impossible. **Rules 4, 5 and 6 are all buildable.**
>
> **The shape that works**, proven by rules `3927243` (staging) and `3927261` (production):
>
> | Section | Value |
> |---|---|
> | **WHEN** | `An event or issue activity is captured` — **the only trigger** |
> | **IF** | logic **`all`** · `Issue occurrences ≥ N` **AND** `Tagged event <key> eq <value>` |
> | **THEN** | Discord → the environment's channel ID |
> | Throttle | 60 minutes |
>
> **Delete the four default state-change triggers.** A new rule ships with *A new issue is
> created / resolved / escalates / regresses* pre-populated, and leaving `First seen event` in
> place makes the rule fire on occurrence **one** — defeating the frequency filter entirely and
> making §4.6 unpassable no matter what the filter says. Note "at least N" means
> "more than N−1": for *"more than 3 in one hour"*, set **4**.
>
> **Rule 5 is SUPERSEDED, by owner decision 2026-08-31T22:33Z** — on its own merits, NOT because
> Sentry cannot express it. Its whole purpose was
> the *repeat* page on an open breaker. D-2's fix supplies that on every rule via the
> `Every event` trigger, and the breaker finding carries `subsystem:health_alert`, which
> both surviving rules filter on. Building rule 5 now would deliver a **second** Discord
> message for every breaker tick and buy nothing. Proven by G.3 §4.5, which exercised
> exactly that route.
>
> **Rule 6 is the one still genuinely owed, and it is owed in PRODUCTION.**
> `reportUnattributedSuppression` emits `level:'warning'` tagged `feature:solicitation_lane`.
> That matches none of `3925256`'s four filters, and CONFIG-1 already established that a
> `warning` `captureMessage` does not reliably classify as high priority, so `3920752`
> does not catch it either. **The capture reaches Sentry and pages nobody** — verbatim
> the failure this section predicts. Not yet harmful, because solicitation sending is off
> in production; harmful the moment it is on.
>
> **Two §1 signals have no rule in either project** and are named here so the absence is
> not rediscovered: `subsystem:refusal_ledger` (the ledger's only gap detector) and
> `subsystem:autonomy_governor` (a `captureException`, so today it reaches issue owners by
> **email** — which §1's own premise rules out as an acceptable route).

_Then_ action for all six: **Send a notification to the Discord integration** →
your server → the `#repworth-alerts` channel ID from step 0.

**Rules 4, 5 and 6 are the odd ones, and the difference is not cosmetic.** Rules
1–3 fire on a new issue. Rules 4, 5 and 6 must not. Each capture title is a
**constant string**, so every occurrence groups into ONE Sentry issue — for rule
4, both **Import offer** event names across every location and both lanes; for
rule 5, every re-page of one open breaker trip; for rule 6, every unattributed
suppression across every account, event type and source. A first-seen trigger
fires once, ever, and then stays silent through exactly the repetition that is
the signal. See #697 and `.claude/reference/lab-notes.md` (2026-08-08).

**Rule 6 is a REPLACEMENT, not an addition (#967).** The other five add
coverage; this one restores coverage that #967 deliberately removed. That ticket
made an unmatched suppression-bearing Resend event ack instead of throw — right
for the recipient's opt-out and right for payload retention, but it takes the
event out of `inbound_events.status='failed'`, which is what
`checkFailedInboundEvents` (rule 1) pages on. **Until rule 6 exists the capture
lands in Sentry and pages nobody.** Its benign cause — the seconds-wide window
before #630 commits `provider_message_id` — is why the trigger is frequency and
not first-seen; its alarming cause is #965, an unexplained loss of Outreach rows
that is still open. §1's bullet carries the response procedure.

**Rule 5 does not replace rule 1, and the overlap is intended (#907).**
> ⚠️ **Superseded 2026-08-31 — kept because the reasoning below is still the correct
> account of WHY the repeat matters; only the remedy changed.** The paragraph reasons
> from a rule set that triggers on first-seen only. Once `Every event` is on the rule
> (see §4's precondition), rule 1's own route already delivers the repeat, so rule 5
> would duplicate it. Read the analysis; do not build the rule.

The
breaker finding carries `subsystem:health_alert` like every other
`HealthAlertPoller` finding, so rule 1 still delivers the **first** page the
moment a trip opens — that latency matters and a frequency rule cannot give it.
What rule 1 cannot give is the **repeat**: `evaluateSendBreaker` is
level-triggered, so it returns a finding on every tick while the trip stands, and
the trip title and the re-page title are two constant strings — two Sentry
issues, two first-seen notifications, then nothing, however long sending stays
halted. Rule 5 keys on `tags.finding` rather than on `subsystem`, so it is narrow
by construction: it adds the repeat for this one condition and touches the
routing no other health finding can afford to lose. Expect one Discord message
when the trip opens and roughly one per hour after that — Sentry's default action
interval is 60 minutes per issue, so a 5-minute poll interval does not mean a
5-minute page.

**Step 7 — the dead-man switch.** (Numbered 7, not 6, since #967 added a sixth
rule — the step number and the rule number must not collide. It was 6 while
#907's rule 5 was the last one.) The cron monitor is NOT an alert rule; it is
configured in §4 of this runbook (slug `health-alert-poller`, auto-created on
first check-in). Do §4 after the six rules above.

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

> **Production needs no cleanup — as of 2026-07-28 there was nothing there to
> clean.** This monitor lives in the `repworth-staging` Sentry project.
>
> ⚠️ **The two claims that follow are STALE and are corrected here rather than
> deleted, because the relabelling analysis above still stands on its own.**
> `repworth-staging` is **no longer the only project in the org** and the production
> worker **has** deployed. As of 2026-08-31 (WS8 G.2) `repworth-production` exists and
> carries **three active monitors** — `health-alert-poller` (cron, environment
> `production`), `Prod worker /ready` (8341697) and `Prod app /api/health` (8341701) —
> after a **Sentry seat**, not a code fault, had been silently rejecting every
> production check-in. The sentence below about production "getting its own project and
> its own monitor" has therefore already happened; it is not future work. The stale `production`
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

Each must produce a page on the **Discord** route (the non-email sink). The
**first** page for a given finding lands within one poll interval; the cost-cap
drill fires immediately at the throw site. **A repeat page does NOT** — see the
precondition below.

> **PRECONDITION, added 2026-08-31 after G.3's D-2. Check this before running any
> drill in this section.**
>
> **The alert rule must carry the `Every event` trigger.** Sentry groups
> `captureMessage` by its text, and every health finding has a constant title, so
> occurrence 2 through ∞ joins an existing group. A rule triggering only on *First
> seen / Resolved / Reappeared / Regression* sees none of those states and is
> **silent for every repeat**. Health findings are the recurring kind by nature, so
> that default is the wrong one for them. In the Sentry UI the trigger is *"An
> event or issue activity is captured"*; there is **no** *"seen more than 0 times"*
> option. Pair it with an **Action Throttle** (60 minutes) so repeats page at most
> hourly per issue.
>
> **Without this, §4.5 and §4.6 cannot pass on any code, however correct** — both
> are written as *count* assertions, and a first-seen-only rule caps the count at
> one. Verify the trigger set by API readback, not by looking at the rule's name.
>
> **A repeat page arrives at the Action Throttle cadence, not the poll cadence.**
> Five-minute polling with a 60-minute throttle means one page per hour per issue.
> Budget drill durations from the throttle. Evidence:
> `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md`.

- [ ] **Stuck outbox — DO NOT RUN THIS IN ISOLATION. Merged into the killed-worker
  drill below (G.3 D-1, 2026-08-31).** The fixture the drill describes — a
  `job_outbox` row `status='pending', available_at = NOW() - INTERVAL '20 minutes'`
  — is **consumed by the system it is meant to observe**. `checkOldestPendingOutbox`
  and the `OutboxPoller` claim query use the *identical* predicate
  (`status = 'pending' AND available_at <= NOW()`), but the dispatcher runs every
  **5 s** against the health poller's **300 s**. The dispatcher claims the row ~60×
  faster than the alert can read it, so `outbox_pending_age` never fires. Raising
  `HEALTH_ALERT_PENDING_AGE_S` does not help — the predicates are identical, so the
  dispatcher wins at any threshold. The alert exists to catch *"dispatch backed up
  **or the OutboxPoller has stalled**"*, so the only honest fixture is one where
  dispatch is actually stopped: **stop the worker, insert the aged row, restart, and
  confirm `outbox_pending_age` on the first clean cycle.** Run it as part of the
  killed-worker drill.
- [ ] **Failed publish** — force a `publish_response` row to `status='failed'`;
  expect `outbox_failed:publish_response`.
- [ ] **Zero-delivery** — a `send_notification` row `status='completed'` with a
  `payload.response_id` that has no `notification_deliveries` row; expect
  `zero_delivery_notifications`.
- [ ] **Cost-cap hit** — set `GLOBAL_DAILY_COST_LIMIT_CENTS=1`, trigger a draft;
  expect a `cost_event:limit_exceeded` Sentry message.
- [ ] **Send breaker re-page (#907)** — insert an open `solicitation_send_breaker`
  row on staging (`reset_at IS NULL`, a breaching `metrics` snapshot), and confirm
  Discord receives **more than one** notification while the trip stands. Silence
  after the opening page is the exact failure this drill exists to close, so it
  fails on a count, not on an absence.
  **Budget from the Action Throttle, not the poll interval (G.3 D-4, 2026-08-31).**
  The text used to say *"at least three `HEALTH_ALERT_POLL_INTERVAL_MS` intervals"*
  (≈ 15 min) and *"more than the opening two"*. Those contradict each other and
  contradict §1's own rule-5 paragraph: with a **60-minute** throttle, 15 minutes
  can only ever yield **one** page. Allow **> 60 minutes** for the second page and
  time it from the first page, not from the insert.
  *"The opening two"* also does not survive a hand-inserted fixture: it counted the
  trip finding **and** the open-trip re-page finding as two constant titles, but
  inserting the row directly means `evaluateSendBreaker` never runs its breach arm,
  so only the **re-page** title is ever emitted.
  **Prove the level-triggered half separately and cheaply.** The Sentry issue's
  occurrence count must rise by one on **every** poll cycle while the page stays
  throttled. Rising occurrences with a static `lastTriggered` is correct here; it is
  the throttle holding the page, not the trigger set failing to see it.
  **Prefer a fixture whose Sentry group already exists** — then `First seen event`
  cannot fire, so a page proves the `Every event` trigger and nothing else could.
  Clear it through `/admin/solicitation` when done — the breaker never
  self-clears, and `resetSendBreaker` is the only sanctioned arm (a mandatory
  `reset_note` is enforced by migration 110's `reset_consistency` CHECK). **Do not
  clear it with SQL.**
- [ ] **Unattributed suppression (#967, rule 6)** — POST **four** svix-signed
  `email.complained` payloads to the staging worker's `/ingress/resend` within
  one hour, each carrying the `lane: solicitation` tag, an `email_id` that
  matches no `solicitation_outreach` row, and a `to` address. Expect **200** on
  each, and **one** Discord notification once the fourth crosses the
  "more than 3 in one hour" threshold. Fewer than four must produce **nothing**
  — a notification on the first is a first-seen rule wearing a frequency
  label, which is the failure rule 6 exists to avoid.
  **Reuse ONE fake recipient across all four.** Every request captures, but
  first-write-wins means only the first writes a ledger row, so the drill
  leaves a single row instead of four. That matters: the Suppression ledger has
  **no expiry and no ordinary delete path** by design, and the admin
  **Correction path** is a compliance surface, not a cleanup tool. Use an
  obviously fictional address and leave the row.
  The `email_id` must differ per request — a repeated `svix-id` is deduped by
  `claimInboundEvent` and a repeated `provider_message_id` is not what varies
  here. Working probe shape: `docs/reviews/fix-967-post-purge-global-optout/staging-smoke.md`.
- [ ] **Killed worker — and the stuck-outbox drill rides on it (G.3 D-1).** Stop the
  worker process; expect the external `/ready` check to page. **While it is stopped,
  insert the stuck-outbox fixture** (`job_outbox` row `status='pending',
  available_at = NOW() - INTERVAL '20 minutes'`), then restart and confirm
  `outbox_pending_age` fires on the first clean cycle — the row survives to be seen
  only because dispatch was actually stopped. Folding the two also spends **one**
  worker interruption instead of two.
- [ ] **Probe stopped** — stop just the poll loop (or block check-in emission);
  expect the Sentry Cron monitor to page on the missed check-in.
  ⚠️ **This FAILED on 2026-09-01 (G.3, D-9) and the drill needs a precondition.** The monitor
  **detects** correctly — two missed check-ins, environment `ok` → `error`, against nine
  consecutive clean hours — but **no Sentry issue is created**, so no alert rule can fire and
  nobody is paged. The monitor's own panel states **"Detect: One failed check-in"**, so one miss
  should have been enough. **Before running this drill, open the monitor in the UI and confirm
  it has a notification target and an issue-creating failure threshold**; the API does not
  expose either field. Verify an absence with `detector:<id>` and **no** `is:` term —
  `search_issues` defaults to `is:unresolved` and will hide a resolved issue, which is how the
  first run mis-reported this.
  **Why it outranks the other drills:** this monitor is the dead-man switch for the whole
  `HealthAlertPoller`. Every other §4 signal is emitted BY that poller, so if it dies they all
  stop silently and this is the only thing that would say so.
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
