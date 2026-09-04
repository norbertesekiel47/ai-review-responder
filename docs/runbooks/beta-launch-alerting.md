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
  `subsystem:refusal_ledger` at level `warning`. Emitted by **three** callers —
  the two insert helpers `writeRefusalEvent` and the set-based
  `writeRefusalEvents`, plus `noteRefusalLedgerDark` — all through the shared
  private `warnLedgerDisabled()` (`src/lib/refusals/write.ts`), once per
  **disabled episode**.

  **The trigger is "a row would have been written", NOT "a write was
  attempted".** #1079 changed this; the row said the latter until then. On the
  two insert helpers the two coincide. On the `policy_gate_held` lane they no
  longer do — the kill switch now returns BEFORE the vocabulary resolve, so no
  write is attempted there at all, and that lane raises the line through
  `noteRefusalLedgerDark` only when every block reason maps to a real category,
  which is the condition under which a row would genuinely have been recorded. A
  decision every one of whose reasons maps to `null` records nothing either way
  and correctly stays silent.

  **This is the only signal that the ledger has a GAP** — the ledger
  structurally cannot show its own absence, since an absent row and a decision
  that never happened look identical at read time. The Restraint tab's
  `ledgerRecording` disclaimer is what tells an operator the ledger is off at
  all.

  **#1079's blind spot is CLOSED (#1105), and the sentence recording it is
  corrected here rather than deleted.** It read: an UNMAPPED block reason (the
  #1080 fault class) "raises nothing on this lane while the switch is off,
  because it would have thrown rather than written". The reason clause is still
  true, and is why such a code raises no *ledger-dark* line — it costs no row, so
  there is no gap to claim. The conclusion is false at HEAD: that lane now raises
  a SEPARATE signal, its own checklist item below. Do not merge the two rules.

  **It is CONFIG-1's shape exactly** (see the audit note
  below): a `warning`-level `captureMessage` does not reliably classify as high
  priority, so today it is captured-but-not-paged. CONFIG-1's option (b) —
  raising the level — is **wrong here**: a flipped kill switch is a deliberate
  operator state, not an error, so this one needs the tag-based rule rather than
  a level change. The structured log line (`refusals:write`) is the durable
  second transport meanwhile. Added by #1009 (red-team RT-1).
- [ ] **Refusal vocabulary hole routed to Discord** — issues tagged
  **`fault:unmapped_block_reason`** at level `error`. Emitted by
  `noteUnmappedBlockReasons` (`src/lib/refusals/write.ts`) from guard 4's
  off-arm in `worker/jobs/response-generation/persist.ts`. Added by #1105.

  **UNCHECKED FOR TWO REASONS, NOT ONE — and neither is "nobody got to it".**
  The rule does not exist in either Sentry project (read back 2026-09-04), AND
  §4's acceptance drill for it is BLOCKED because the fault it tests cannot be
  produced by any reachable input. Building the rule alone does not earn the
  tick: §4's own standard is that a rule is unproven until it has been seen to
  deliver. Both entries carry the detail.

  **RULE ON THE `fault` TAG, NEVER ON `subsystem:refusal_ledger AND
  level:error`.** An earlier draft of this item called it "the only one above
  `warning`" and that was false when written: `withLedgerAttribution`
  (`worker/jobs/response-generation/persist.ts`) has raised `error`-level
  `subsystem:refusal_ledger` issues since #1079, and the overflow marker below
  adds a third. A level-plus-subsystem rule selects all of them and pages on
  three different faults.

  **It is a DIFFERENT fault from the item above, which is why it gets its own
  rule and its own level.** The ledger being off is a deliberate operator act
  and warns. A block reason with no entry in
  `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is a defect, and it means autonomy
  decisions are being taken against a broken map. A rule written against
  `subsystem:refusal_ledger` at `warning` alone does NOT catch it.

  **What an operator does with it.** The event carries the offending codes in
  `extra.codes`, in the gate's own evaluation order, DE-DUPLICATED — the ones NOT
  ALREADY REPORTED by this worker process, since the latch is per code (see
  below). **A code you expected and cannot find is in one of three states**: it
  was reported in an earlier event; it is a repeat within the same decision; or
  it arrived once the cap was full, in which case it is named NOWHERE and only
  the overflow marker records that it existed. Find each code in
  `POLICY_GATE_HELD_REFUSAL_CATEGORIES` (`src/lib/refusals/vocabulary.ts`). It
  will not be there — that is the point — so the question is which producer
  emitted a value outside the compiled `AutoApprovalBlockReason` union, since
  the map is total over that union at `pnpm typecheck`. Expect an unsafe cast,
  a deserialized payload, or a mutated object.

  **The message is a CONSTANT** (`auto_approval_unmapped_block_reason`) so every
  occurrence groups into one Sentry issue and per-issue throttling applies to
  the fault rather than to each distinct code set.

  **_When_ cadence for both new rules: `Every event`, NEVER "a new issue is
  created".** An earlier version of this item said first-seen, reasoning that a
  repeat trigger would delay a page for a fault that fires at most once per code.
  That reasoning had the failure backwards, and §1a-do's own rule-4/5/6 paragraph
  states why: **the capture title is a CONSTANT**, so every occurrence groups into
  ONE Sentry issue, and a first-seen trigger fires once ever and then stays silent
  through exactly the repetition that IS the signal. Here the repetition is a
  SECOND DISTINCT unmapped code — the precise event the per-code latch exists to
  make visible. First-seen would have made the whole per-code design unobservable
  to an operator. Volume is not a concern: the latch and the cap already bound
  these to at most `UNMAPPED_SIGNAL_CAP` + 1 events per worker process.

  **A second event, `auto_approval_unmapped_block_reason_cap_reached`, tagged
  `fault:unmapped_block_reason_overflow`,** means more than
  `UNMAPPED_SIGNAL_CAP` distinct codes escaped in one worker process. Read it as
  "a producer is generating varied garbage", not as "one map entry is missing".
  It names no code deliberately, and it fires once per process. **It also
  carries `subsystem:refusal_ledger` at `error`** — the second reason the rule
  must key on the `fault` tag.

  **Latching:** per CODE, per PROCESS, BOUNDED. Each distinct code reports once
  and never re-arms — unlike the ledger-dark line above, which re-arms per
  disabled episode. A worker restart clears it. So a repeat of the SAME code is
  silence by design.

  **A new code is reported UNTIL the cap, and silent after it.** An earlier
  draft of this item said "a new code is always reported", which contradicted
  the cap paragraph four lines above it. Past `UNMAPPED_SIGNAL_CAP` distinct
  codes the process emits the overflow marker once and then nothing at all —
  including for codes it has never seen. **That is the state to restart the
  worker out of**, and it is why the marker is worth a rule of its own rather
  than being folded into the item above.
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
| 7 | `refusal-vocabulary-hole → discord` | `fault` equals `unmapped_block_reason` | **every event** | `error` |
| 8 | `refusal-vocabulary-overflow → discord` | `fault` equals `unmapped_block_reason_overflow` | **every event** | `error` |

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
> | **IF** | logic **`all`** · `Issue occurrences` = N **AND** `Tagged event <key> eq <value>` |
> | **THEN** | Discord → the environment's channel ID |
> | Throttle | 60 minutes |
>
> **Delete the four default state-change triggers.** A new rule ships with *A new issue is
> created / resolved / escalates / regresses* pre-populated, and leaving `First seen event` in
> place makes the rule fire on occurrence **one** — defeating the frequency filter entirely and
> making §4.6 unpassable no matter what the filter says.
>
> **⚠️ WHAT `Issue occurrences: N` ACTUALLY MEANS (G.3 D-11/D-13, 2026-09-01 — MEASURED, and it
> contradicts the sentence that stood here).** This block previously read *"at least N means
> more than N−1: for 'more than 3 in one hour', set 4"*. Both halves are wrong.
>
> 1. **There is no interval.** The filter carries a bare `value` and no `interval` parameter —
>    it is `IssueOccurrencesFilter` over the group's **cumulative** count, not
>    `EventFrequencyCondition`. "In one hour" is not expressible this way. The count **never
>    resets**, so such a rule ratchets permanently from silent to page-on-every-event.
> 2. **It is off by one from its own label.** Rule `3927243` with `value: 4` against a group
>    standing at 2 occurrences stayed silent at 3 **and at 4**, and fired once at 5/6
>    (`lastTriggered 2026-09-01T06:07:44.526Z`). Configured `N` pages on occurrence **N+1**.
>
> **Consequences when building or reading any rule here:** budget a drill from the group's
> **current** occurrence count, never from zero — read it first. And understand what the value
> buys in production: with `N`, the first `N` occurrences page nobody, and from `N+1` every
> occurrence pages, bounded only by the throttle.
>
> **DEFAULT TO NO OCCURRENCE FILTER (owner decision 2026-09-01).** For a detector whose events
> are rare by construction, the filter guarantees `N` silent occurrences of the exact condition
> you are hunting, and it cannot express a rate at all — a cumulative counter treats `N` events
> spread over a year the same as `N` in a minute, and never resets. Use the `Every event`
> trigger plus the tag filter, and let the **60-minute Action Throttle** cap the volume: that
> damps a noisy detector without ever making it blind. **If a genuine rate condition is needed,
> build a Sentry METRIC alert** on `count()` over the interval — that is the alert type that
> expresses "N in an hour". Do not reach back for the occurrence filter.
>
> **Rule 5 is SUPERSEDED, by owner decision 2026-08-31T22:33Z** — on its own merits, NOT because
> Sentry cannot express it. Its whole purpose was
> the *repeat* page on an open breaker. D-2's fix supplies that on every rule via the
> `Every event` trigger, and the breaker finding carries `subsystem:health_alert`, which
> both surviving rules filter on. Building rule 5 now would deliver a **second** Discord
> message for every breaker tick and buy nothing. Proven by G.3 §4.5, which exercised
> exactly that route.
>
> **Rule 6 is not the only one still owed — #1105 added rules 7 and 8, and this
> paragraph said otherwise for one commit.** A fresh red-team pass caught it
> against the register further down this section (cited by name, not by line
> offset — the first version said "eleven lines below" and was already wrong),
> which is the same
> stale-count-after-an-edit failure this section keeps recording. Rule 6 remains
> the one owed in PRODUCTION SPECIFICALLY, and that is what the rest of this
> paragraph is about.
>
> **Rule 6 is owed in PRODUCTION.**
> `reportUnattributedSuppression` emits `level:'warning'` tagged `feature:solicitation_lane`.
> That matches none of `3925256`'s four filters, and CONFIG-1 already established that a
> `warning` `captureMessage` does not reliably classify as high priority, so `3920752`
> does not catch it either. **The capture reaches Sentry and pages nobody** — verbatim
> the failure this section predicts. Not yet harmful, because solicitation sending is off
> in production; harmful the moment it is on.
>
> **Four §1 signals have no DEDICATED rule in either project** and are named here so the
> absence is not rediscovered: `subsystem:refusal_ledger` (the ledger's only gap detector),
> `subsystem:autonomy_governor` (a `captureException`, so today it reaches issue owners by
> **email** — which §1's own premise rules out as an acceptable route), and — added by
> #1105 — `fault:unmapped_block_reason` and `fault:unmapped_block_reason_overflow`,
> rules 7 and 8 above. **The count was "two" and the two new signals were not listed
> when they shipped**; red team caught the omission, which is the same class of defect
> this whole register exists to prevent.
>
> **"No dedicated rule" is NOT "pages nobody", and the two must not be conflated for the
> #1105 pair.** The premise that makes this register alarming — CONFIG-1's finding that a
> `warning` `captureMessage` does not reliably classify as high priority — applies to
> `subsystem:refusal_ledger`, which IS `warning`. **It does NOT apply to
> `subsystem:autonomy_governor`**, and an earlier version of this paragraph said it did:
> that signal is a `captureException` with no level override, so it defaults to `error`,
> exactly as this file already states twice elsewhere. Its problem is the ROUTE (email),
> not the level.
>
> **READ BACK FROM THE SENTRY API 2026-09-04, and the answer SPLITS BY PROJECT.** The
> previous version of this paragraph said the question was unverified. It is now
> answered, and the two projects differ:
>
> - **`repworth-staging` — NO PATH.** `3608329`'s action filter is four `Tagged event`
>   equalities (`health_alert`, `limit_exceeded`, `stripe_reconciliation`,
>   `import_consent_analytics`) plus `Issue category = 10`, under `any-short` logic. None
>   matches `fault:unmapped_block_reason` or `subsystem:refusal_ledger`. **On staging the
>   two new signals page nobody**, whatever their level. Its name says "high priority
>   issues" and its filter says otherwise — read the filter, never the name.
> - **`repworth-production` — CANDIDATE PATH, STILL UNPROVEN.** `3920752` carries NO
>   action-filter conditions at all; it triggers on New/Existing **high priority issue**
>   and routes to Email + Discord. An `error`-level capture is Sentry's default high
>   priority, so rules 7 and 8 are probably already routed there. **`lastTriggered` is
>   `null` on all three production rules** — no production rule has ever fired, so the
>   classification remains observed by nobody.
>
> So the two signals stay owed, but for a sharper reason than "unverified": staging has a
> demonstrable gap, and production has an unproven inference.

_Then_ action for all eight: **Send a notification to the Discord integration** →
your server → the `#repworth-alerts` channel ID from step 0.

**Rules 7 and 8 filter on the `fault` tag, NOT on `subsystem` plus level (#1105).**
Three different faults now carry `subsystem:refusal_ledger` at `error` —
`withLedgerAttribution`'s ledger-failure attribution (since #1079) and both of
these — so a subsystem-and-level filter pages on all three and tells an operator
nothing about which. **Their trigger is `Every event`, the SAME as rules 4-6**,
and an earlier version of this paragraph said the opposite. The reasoning it gave
— that the per-code latch and the cap already bound the volume, so a repeat
trigger would only delay the page — had the failure backwards. Both titles are
CONSTANTS, so every occurrence groups into one issue and a first-seen rule fires
once ever, then stays silent through exactly the repetition that IS the signal
here: a SECOND DISTINCT unmapped code, which the per-code latch exists to make
visible. The bound is what makes `Every event` safe, not what makes first-seen
sufficient.

**Rules 4-8 are the odd ones, and the difference is not cosmetic.** Rules 1-3
fire on a new issue. Rules 4, 5, 6, 7 and 8 must not. Each capture title is a
**constant string**, so every occurrence groups into ONE Sentry issue — for rule
4, both **Import offer** event names across every location and both lanes; for
rule 5, every re-page of one open breaker trip; for rule 6, every unattributed
suppression across every account, event type and source; for rules 7 and 8,
every unmapped block reason and every cap-reached marker across every worker
process. A first-seen trigger fires once, ever, and then stays silent through
exactly the repetition that is the signal. See #697 and
`.claude/reference/lab-notes.md` (2026-08-08).

**Rule 6 is a REPLACEMENT, not an addition (#967).** The other rules add
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

**Step 7 — the dead-man switch.** (**Its number is a STEP number and it now
collides with a rule number — the old "must not collide" rule is retired, not
satisfied.** It was numbered 7 when #967 made rule 6 the last one; #1105 then
added rules 7 and 8, so the collision the parenthetical existed to avoid has
happened and renumbering the step would only chase the next rule. Read "Step 7"
as a step throughout this section.) The cron monitor is NOT an alert rule; it is
configured in §4 of this runbook (slug `health-alert-poller`, auto-created on
first check-in). Do §4 after the **eight** rules above.

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
- [x] **Unattributed suppression (#967, rule 6)** — ✅ **PASS 2026-09-01** (G.3
  session 3). POST **four** svix-signed
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
  ⚠️ **Sign with the DECODED secret bytes, not the secret string (G.3 D-10).**
  `worker/ingress/resend.ts` keys the HMAC with
  `Buffer.from(secret.replace(/^whsec_/, ''), 'base64')`. Keying it with the
  printable `whsec_…` string returns `401 invalid_signature` on every POST — and
  a `401` produces the *expected* "no page" for the sub-threshold POSTs, so the
  defect only shows on the last one and reads as a broken rule.
  ⚠️ **"More than 3 in one hour" is NOT what rule 6 implements (G.3 D-11/D-13).**
  The filter is `Issue occurrences`, a **cumulative** count with **no interval**;
  and configured with value `N` it fires on occurrence **N+1**, not `N`. Measured:
  a group at 2 occurrences stayed silent at 3 and at 4, and fired once at 5/6.
  So **budget the drill from the group's CURRENT occurrence count, not from
  zero** — read it first — and expect the page on the POST that takes the group
  past the configured value. In production this means the first `N` unattributed
  suppressions page nobody and every one after that pages, hourly, forever.
- [ ] **Killed worker — and the stuck-outbox drill rides on it (G.3 D-1).** Stop the
  worker process; expect the external `/ready` check to page. **While it is stopped,
  insert the stuck-outbox fixture** (`job_outbox` row `status='pending',
  available_at = NOW() - INTERVAL '20 minutes'`), then restart and confirm
  `outbox_pending_age` fires on the first clean cycle — the row survives to be seen
  only because dispatch was actually stopped. Folding the two also spends **one**
  worker interruption instead of two.
- [ ] **Probe stopped** — stop just the poll loop (or block check-in emission);
  expect the Sentry Cron monitor to page on the missed check-in.
  ⚠️ **RE-RUN 2026-09-01T20:15–20:32Z. STILL A QUALIFIED FAIL, and the cause is now isolated to
  Sentry.** Three consecutive `missed` check-ins (20:20:16Z, 20:25:18Z, 20:30:22Z), environment
  `ok` → `error`, against nine preceding hours at `ok=12, missed=0` — and **no issue created, and
  no regression of the resolved one** (`monitor.slug:health-alert-poller`, no `is:` term, 24 h and
  90 d). Every alternative explanation was closed *before* the stop: threshold is 1 and counts
  missed check-ins (D-16), the routing rule exists and was API-verified (D-14 fix), its triggers
  hold both `First seen` and `Regression`, and the query form demonstrably surfaces resolved
  issues. **Do not re-run this drill again for the same question — the next step is a Sentry
  support ticket.** ⚠️ **The restore is `railway deployment redeploy --from-source …` (D-18).**
  The bare form redeploys a stale snapshot after `railway down`; verify the new deployment's
  COMMIT HASH against `origin/staging`, not merely that a deployment exists.
  ⚠️ **This FAILED on 2026-09-01 (G.3, D-9) and the drill needs a precondition.** The monitor
  **detects** correctly — two missed check-ins, environment `ok` → `error`, against nine
  consecutive clean hours — but **no Sentry issue is created**, so no alert rule can fire and
  nobody is paged. The monitor's own panel states **"Detect: One failed check-in"**, so one miss
  should have been enough. **Before running this drill, open the monitor in the UI and confirm
  it has a notification target and an issue-creating failure threshold**; the API does not
  expose either field. Verify an absence with `detector:<id>` and **no** `is:` term —
  `search_issues` defaults to `is:unresolved` and will hide a resolved issue, which is how the
  first run mis-reported this.
  ⚠️ **DO NOT "SET THE FAILURE THRESHOLD" — IT IS ALREADY 1 (G.3 D-16, 2026-09-01).** The
  value is not on the monitor endpoint, which is why two sessions called it UI-only, but it
  **is** embedded in any cron issue the monitor has produced: `REPWORTH-STAGING-8` carries
  `monitor.config: {"failure_issue_threshold": 1, "recovery_threshold": 1, "checkin_margin": 5,
  "max_runtime": 5, …}`, agreeing with the panel's *"Detect: One failed check-in"*. That same
  issue also settles two other assumptions: the monitor **can** create issues (225 occurrences
  on 2026-06-26, failure reason *"A missed check-in was detected"*, so a **missed** check-in
  does count), and its complete tag set is `environment`, `interface_type`, `level`,
  `monitor.id`, `monitor.incident`, `monitor.slug`. **Verify the threshold; do not change it.**
  The gap to close is the monitor's **notification target / owner** — a field
  `recordProbeCheckIn`'s `monitorConfig` upsert cannot set (it passes only `schedule`,
  `checkinMargin`, `timezone`), which is why `find_monitors` reports `owner: null` on both
  monitors. Best lead on the underlying cause: the only cron issue this monitor ever produced
  is tagged `environment: **production**` on a staging project — the stale environment §2a
  exists to clean up — and the `staging` environment has never produced one.
  ⚠️ **THERE IS A SECOND BREAK, DOWNSTREAM OF THE FIRST (G.3 D-14, 2026-09-01). Fixing the
  monitor alone cannot make this drill pass.** A Sentry cron-monitor issue is generated by
  Sentry, not by our SDK, so it carries **none** of `subsystem`, `cost_event` or `feature`.
  Staging's `3608329` and production's `3925256` both filter on four `Tagged event`
  equalities over exactly those keys, under `any-short` logic — so neither can route a cron
  issue. On staging `3608329` is the only Discord rule, so there is **no path at all**;
  production additionally has the unfiltered `3920752` (New/Existing **high priority**
  issue → Discord), which is a candidate path but is contingent on Sentry classifying the
  cron issue high priority, and that is unverified. The scoping that created the staging gap
  landed at 2026-09-01T05:35Z, *after* the drill ran, so nothing re-tested the path.
  **Before re-running, do BOTH:** (a) give the monitor an issue-creating failure threshold
  and a notification target in the UI, and (b) give each project a rule that can route the
  resulting issue — prefer a **dedicated cron rule** over widening `3608329`/`3925256`, which
  keeps their deliberate scoping intact.
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
- [x] **#474 capacity burst (headroom, ticket #480)** — ✅ **PASS 2026-09-01**
  (G.3 session 3: peak pending **50** against the 1500 threshold, drained in
  **13 min** against a 30-min target, zero `failed`, no `backlog_depth` finding,
  three clean poller check-ins spanning the drill). Via
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
- [ ] **Refusal vocabulary hole (rules 7 and 8, #1105)** — the drill this
  section's own rule demands: *each rule is unproven until you have seen it
  deliver*, and rules 7 and 8 shipped without one. Added when red team asked why
  §4 had no entry for them.

  **The precondition above is the whole point of this drill.** Both capture
  titles are CONSTANTS, so a first-seen rule pages on occurrence 1 and is silent
  for every later distinct code — which is exactly the event the per-code latch
  exists to surface. **A single page does not pass this drill. Two do.**

  **BLOCKED 2026-09-04 — THIS DRILL CANNOT BE RUN AS WRITTEN, and the fault is
  in the drill.** It was written without checking that its own step 1 is
  performable. Two independent blockers, both verified:

  1. **Step 1 is unreachable.** Every member of `blockReasons` is a compiled
     string literal in `worker/jobs/response-generation/auto-approval.ts`, and
     `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is total over
     `AutoApprovalBlockReason` by `satisfies`. No env var, config value or
     database row can introduce a code outside that union, so
     `unmappedBlockReasons` returns empty for every reachable input. Producing an
     unmapped code needs deliberately-instrumented code deployed to staging.
  2. **There is nothing to page.** Rules 7 and 8 are unchecked §1 boxes and exist
     in neither Sentry project, and the register above records that staging's
     `3608329` would not match them even if an event arrived.

  Closing this needs one of two decisions, and both are new work: give the lane a
  test-only injection seam, or rescope the drill to prove the ROUTE with a
  synthetic tagged event and drop the claim that it exercises the lane. **Do not
  tick this box on the strength of a rule merely existing** — that is the
  substitution this section's own "Verify, do not assume" rule forbids.

  The steps below are kept as the specification of what a runnable drill must
  cover, not as instructions anyone can follow today.

  On staging, with `REFUSAL_LEDGER_ENABLED=false` and the worker freshly
  restarted (the latch is per PROCESS, so a restart is part of the setup):

  1. Drive a `policy_gate_held` decision carrying a block reason that is not in
     `POLICY_GATE_HELD_REFUSAL_CATEGORIES`. Expect ONE Discord page,
     `auto_approval_unmapped_block_reason`, level `error`, with the code in
     `extra.codes`.
  2. Drive a second decision carrying a DIFFERENT unmapped code. **Expect a
     SECOND page.** No second page means the rule is on first-seen and rules 7
     and 8 are inert past their first fire — the defect this drill exists to
     catch.
  3. Repeat the FIRST code. Expect NO page: the per-code latch suppresses it.
  4. Optional, and the only way to prove rule 8 delivers: drive more than
     `UNMAPPED_SIGNAL_CAP` distinct codes and confirm one
     `auto_approval_unmapped_block_reason_cap_reached` page, then silence.

  **The route half is already answered, by API read-back rather than by this
  drill (2026-09-04).** Staging's `3608329` filters to four unrelated tags, so it
  routes these signals NOWHERE; production's `3920752` has no filter and would
  catch them if Sentry classifies an `error` `captureMessage` as high priority,
  which no fired event has yet demonstrated. §1a-do's register carries the
  detail. What remains for a drill is the LANE half — that the signal fires at
  all, once per distinct code, and stops at the cap.

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
