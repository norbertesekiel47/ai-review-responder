# Beta Production Stand-up — orchestrating runbook

> **Created:** 2026-08-10 · **Revised:** 2026-08-10 (adversarial-review triage —
> first-deploy ordering, 077/078 protection, beta activation path, env audit)
> · **Owner:** @norbertesekiel
>
> **Purpose:** stand up the production backend (Railway worker + queue Redis +
> webhooks + alerting) and bring prod to the **beta posture** decided in
> `docs/launch-checklist.md` → "Beta cohort decisions (2026-08-09)".
>
> **This runbook orchestrates; it does not duplicate.** Mechanics live in
> `docs/runbooks/deployment-guide.md` and `docs/runbooks/ws8-tier-cutover.md`.
> Where this file conflicts with either, **this file wins** — each supersession
> is called out explicitly and dated.

---

## §0. Verified current state (live reads, 2026-08-10)

| Piece | State | Evidence |
|---|---|---|
| Vercel UI (`rep-worth` → repworth.net) | **Live** | serving prod since 2026-05 |
| Prod Supabase `udeyaqnvpojbwgoaxwdg` | **Live, healthy** | full introspection audit 2026-08-14: 106 of 107 migrations applied — **only 078** is outstanding (below). 005/105/107 landed 2026-08-14; 077 was already applied |
| Staging (full stack) | **Live, proven** | §II.2.8 gate + staging runbook evidence |
| Railway prod worker (`repworth-worker`, project `ad641d0e-dc01-4250-b71c-db1beedb9c8c`) | **Never successfully deployed** | deployment-guide "Current cloud state (2026-07-28)" |
| Railway prod queue Redis | **Not provisioned** | same |
| Prod Sentry project | **Does not exist** (only `repworth-staging`) | same |
| Prod Stripe webhook endpoint | **Does not exist** | §5.2 dependency table |
| Prod worker env vars | 35 set; stale vs the current boot-gate set (below) | §5.2 callout + `startup-assert.ts` read 2026-08-10 |

**Doc corrections established by this runbook (fix at the cited spots):**

1. **The prod boot-gate set is wider than deployment-guide §5.2 says.**
   `assertWorkerStartupEnv` (`worker/config/startup-assert.ts`) hard-requires,
   outside mock mode: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, **all six**
   `STRIPE_PRICE_*` vars (`assertStripeWorkerEnv`), **both**
   `DAILY_COST_LIMIT_CENTS_COPILOT`/`_AUTOPILOT`
   (`assertTierDailyCostLimitsConfigured`), plus `SENTRY_DSN` and
   `ADMIN_NOTIFICATION_EMAIL`. §5.2's "only two of the four are hard boot
   gates" note predates this. **Consequence: the first prod worker deploy is
   only possible AFTER live Prices + webhook secret + cost limits exist — i.e.
   inside the WS8 sequence (Phase D below), not before it.**
2. **BOTH migrations 077 AND 078 are WS8-only.** 077 is the "quiesced
   normalization" expand step; 078 is the strict contract, "apply only after
   077, the strict code…" (`migrations-log.md` →  077/078 entries). Neither may
   be applied as an ordinary missing migration. CLAUDE.md's standing exception
   names both as of this revision.
3. The 2026-08-09 `ZERNIO_PUBLISHING_ENABLED` "discrepancy" is dissolved: both
   prior readings described a worker that had never run. The flag is set
   deliberately in Phase B; correct env-vars.md's stale "ON (prod,
   2026-04-28)" row in Phase G.

---

## Step 0 — Land the plan of record (before ANY provider write)

- [ ] Commit this runbook, `docs/launch-checklist.md`,
      `docs/runbooks/beta-onboarding-cofounder-guide.md`, and the doc
      corrections above to `main` **via PR** (repo rule — no direct pushes).
- [ ] Record here the `main` SHA you will deploy: `____`. CI green on it.
- [ ] **Staging WS8 evidence must exist for that same SHA** (or be re-run) —
      the full ws8-tier-cutover §§1–7 pass on staging, with evidence record.
      A cutover proven on an old SHA does not transfer.
- [ ] Name the roles for Phase D: cutover owner `____`, observer `____`,
      incident owner `____`, evidence record path `____`.

## Day-of read-only preflight (run before writes, present results)

- [ ] `main` SHA + CI state + staging WS8 evidence pointer (Step 0).
- [ ] Live identities: Railway project/env, Vercel project, Supabase project
      ref, **Stripe live-mode account**, Sentry org/projects.
- [ ] Operator access works: Railway/Vercel/Supabase MCC/CLI auth, Stripe
      dashboard + (if used) Stripe MCP OAuth. Maintenance window agreed.
- [ ] Prod migration head via **direct schema checks + migrations-log.md §2a**
      (the Supabase migration-history table is incomplete — earlier migrations
      were applied via psql).
- [ ] Redacted **name-only** env inventories for Railway prod and Vercel prod
      (for the Phase B/C diffs). Never print secret values.

---

## Secrets & values policy

- **Every secret is prod-only and freshly created** — generated secrets per
  deployment-guide §1.8; provider creds provisioned in **live mode**; webhook
  signing secrets minted per endpoint. Walk §II.3 (must-differ matrix) for both
  platforms. Never copy a staging value. Never print a secret value into a
  transcript or evidence record.
- **Exception — secrets/values that must MATCH across Railway and Vercel
  *within* production:** `WORKER_INTERNAL_SECRET` (same value both platforms —
  env-vars.md), `REDIS_CACHE_URL` (both point at the one prod Upstash). Check
  each shared var's env-vars.md row (e.g. `SESSION_COOKIE_SECRET`) for whether
  it must match across surfaces before independently regenerating per platform.
- **Flags are NOT cloned from staging** (staging runs nearly everything ON).
  Prod beta posture is the Phase B table. **Do not blanket-disable default-ON
  resilience flags** — `BOOT_STAGGER_ENABLED` and `LLM_CIRCUIT_BREAKER_ENABLED`
  stay at their default ON; leave them unset.
- LLM keys may be shared per the topology table; separate prod keys recommended
  (spend attribution, revocation blast-radius).

---

## Order of operations

⏱ = lead time, start early. Human-approval checkpoints: every Railway **and**
Vercel production env mutation (and the redeploy it triggers), every Stripe
live-mode object, each WS8 gate in Phase D, and the §9.6 first post (human
clicks it).

### Phase A — Provision what doesn't exist (deployment-guide §5.2 dep table + §1)

- [ ] **A1.** Sentry **production** project (`repworth-production`) → DSN. Never
      reuse `repworth-staging`'s.
- [ ] **A2.** Railway Redis in the `production` environment. Private-net only:
      delete any auto-created TCP proxy; queue URL keeps **`?family=0`**.
- [ ] **A3.** Prod Upstash cache; verify the existing `REDIS_CACHE_URL` value
      is NOT staging's instance.
- [ ] **A4.** Decide `ADMIN_NOTIFICATION_EMAIL`.
- [ ] **A5.** ⏱ DNS `worker.repworth.net` → Railway (or defer to the
      `*.up.railway.app` domain).
- [ ] **A6.** ⏱ Live provider access: live Zernio key; prod Resend (domain
      already verified); **Stripe live mode activated**; OpenAI/Anthropic
      billing + **hard provider-side spend caps**.

### Phase B — Railway `production` env vars (deployment-guide §5.2, superseded as follows)

> Boot-gated set (must ALL exist before Phase D's deploy): `DATABASE_URL`/
> `DATABASE_POOL_URL`/`SUPABASE_*`, `REDIS_CACHE_URL`, `REDIS_QUEUE_URL`,
> `SERPAPI_API_KEY` (eager import), `SENTRY_DSN`, `ADMIN_NOTIFICATION_EMAIL`,
> `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, six `STRIPE_PRICE_*`,
> `DAILY_COST_LIMIT_CENTS_COPILOT`, `DAILY_COST_LIMIT_CENTS_AUTOPILOT`.
> The Stripe trio and price vars are produced in Phase D (endpoint + WS8 §1) —
> set every other one now.

| Topic | Do | Source |
|---|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | **`false`** (supersedes §5.2's `true` and Part III Phase 7's flip step) | beta decision |
| Stripe prices | Six vars: `STRIPE_PRICE_COPILOT_LIST/COPILOT_FOUNDING/AUTOPILOT_LIST/AUTOPILOT_FOUNDING/COPILOT_OVERAGE/AUTOPILOT_OVERAGE` — live IDs from WS8 §1 (Phase D). **Also retain the seven legacy `STRIPE_PRICE_*` vars on BOTH platforms through the WS8 rollback window** (`RETAINED_STRIPE_PRICE_HISTORY`, env-vars.md) | env-vars.md Stripe table |
| Cost ceilings | `DAILY_COST_LIMIT_CENTS_COPILOT` + `_AUTOPILOT` — **required, no default, boot-gated**; size per the #672 C4 note (live-lane spend + ~$9 on-demand headroom) | env-vars.md |
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | real prod ceiling (staging runs low) | §II.3 |
| `FOUNDING_DEADLINE` | `2027-01-01T00:00:00Z` — strict UTC; missing/malformed fails closed to list pricing + alerts | env-vars.md |
| `DB_POOL_MAX` | **`20`** on the Railway worker (drill-blessed starting value, ADR 0009 — never raise blind) | env-vars.md |
| Autonomy + trial | `AUTO_APPROVAL_ENABLED`, `AUTOPILOT_PURCHASABLE`, `TRIAGE_ENABLED`, `ESCALATION_ENABLED`, `JUDGE_ENABLED`, `GOVERNOR_ENABLED`, `TRIAL_ENABLED` — all unset/false | ADR 0005 |
| Zernio | `ZERNIO_PUBLISHING_ENABLED=true`, live `ZERNIO_API_KEY`, fresh `ZERNIO_WEBHOOK_SECRET` | §5.2 |
| Retired vars | Remove `PAST_REPLIES_VIEW_ENABLED` if present (retired #678 — read nowhere) | env-vars.md |
| Full flag audit | Enumerate **every** default-off flag from env-vars.md on BOTH surfaces and record its intended prod value — including `AUTO_APPROVAL_PROVIDER_MODERATION_READY`, offboarding, solicitation, `STRIPE_TAX_ENABLED`, channels, `EDIT_REPLIES_ENABLED`, `EXTERNAL_REPLY_IMPORT_ENABLED`, `ONBOARDING_DEMO_ENABLED` | env-vars.md |
| Everything else | B2 audit: diff Railway prod var NAMES vs staging's + `.env.example`; resolve every gap deliberately; fresh `SESSION_COOKIE_SECRET`/`CSRF_SECRET`/`IMPERSONATION_COOKIE_SECRET` (≥32 chars); `NODE_ENV=production` (confirm vs ADR 0013); `MOCK_EXTERNAL_APIS=false` | §5.2, §II.3 |

### Phase C — Vercel Production env vars (deployment-guide §4.2)

- [ ] `WORKER_PUBLIC_URL` (A5, no trailing slash), prod Supabase values, prod
      `REDIS_CACHE_URL`, `WORKER_INTERNAL_SECRET` (same value as Railway's),
      **`DB_POOL_MAX=3`**, same flag posture as Phase B, fresh Vercel-side
      secrets per their env-vars.md rows.
- [ ] Walk the §II.3 matrix column-by-column; remove `PAST_REPLIES_VIEW_ENABLED`
      here too.

### Phase D — WS8 production cutover, zero-state branch (`ws8-tier-cutover.md` §§1–7)

**This phase contains the first prod worker deploy.** Run the WS8 runbook
start-to-finish with a named owner + observer + evidence record. Where WS8
assumes an existing running worker/queues/webhook (it was written for staging's
live stack), substitute the **zero-state proof** below and record the
substitution in the evidence record. Separate human checkpoints at: zero-state
proof, endpoint creation, 077, first deploy, smoke, 078, resume/open.

- [ ] **D1. Zero-state proof** (replaces WS8 §2–§3 quiesce/drain): present
      evidence that prod has NO running worker, NO queues/consumers, NO
      producers, NO webhook endpoints delivering, NO in-flight outbox work —
      Railway deploy history, empty/absent queue Redis, provider dashboards
      showing no prod endpoints.
- [ ] **D2. WS8 §1** — create the six immutable live Prices; stage
      configuration (six price vars + retained legacy seven, cost limits,
      `FOUNDING_DEADLINE`) on both platforms.
- [ ] **D3. Create the live Stripe webhook endpoint DISABLED** → capture the
      signing secret into `STRIPE_WEBHOOK_SECRET` (Railway). Endpoint API
      version in lockstep with the pinned `apiVersion` in
      `src/lib/payments/stripe-client.ts`. Subscribed events: the full set
      `worker/ingress/stripe.ts` handles — **including
      `invoice.payment_action_required`** (handler exists; do not omit the
      subscription).
- [ ] **D4. WS8 §4** — provider-wide blocker per the runbook.
- [ ] **D5. WS8 §5** — apply **migration 077**, verify expansion/normalization.
- [ ] **D6. WS8 §6** — **first strict worker deploy** (all boot gates now
      satisfiable; watch `assertWorkerStartupEnv` pass naming the production
      lane), enable the Stripe endpoint for **controlled smoke**, run the §6
      smoke.
- [ ] **D7. WS8 §7** — apply **migration 078**, then resume/open per the
      runbook (in zero-state: "resume" = leave the now-verified stack running).
- [ ] **D8.** Any other migrations prod is behind on (non-WS8) were applied in
      lockstep already — verify head per the day-of preflight; if any ordinary
      migration IS missing, apply it in numeric order BEFORE D5, never between
      077 and 078.

### Phase E — Remaining live webhooks (deployment-guide §6)

- [ ] **E1. Resend** → prod worker `/ingress/resend`. The signing secret is
      **provider-issued** (Svix `whsec_…`, shown when the endpoint is created)
      — paste Resend's value into `RESEND_WEBHOOK_SECRET`. *(Supersedes §1.2's
      "generate a 64-hex secret" — you cannot choose this one.)*
- [ ] **E2. Zernio** → prod worker; live key; verify per §6.2.
- [ ] Staging endpoints stay pointed at staging; never re-point.

### Phase F — Beta activation path

> **Status changed 2026-08-14 — F1 is DONE.** The activation path exists in code
> and rides the owner's own Stripe Checkout (branch `admin-invite-funnel`, plan
> `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md`). What remains is
> **provider + environment work**, not code: create the coupon, set the env var,
> and run the staging smoke below. The consolidated ops list also lives in
> `docs/runbooks/beta-onboarding-cofounder-guide.md` → Part 12.

- [x] **F1.** ~~Implement a server-selected fixed coupon~~ — **shipped
      2026-08-14.** Eligibility (`onboarded_by IS NOT NULL` on the account's
      **primary** Business, plus `BETA_COMP_COUPON_ID` set) is resolved once
      inside `applyTierSnapshot`'s transaction, under the activation lock, and
      snapshotted onto the **Checkout attempt**
      (`accounts.checkout_attempt_coupon_id`, migration **105**).
      `buildCheckoutSessionParams` emits it as `discounts: [{ coupon }]` plus an
      explicit `payment_method_collection: 'always'` from that snapshot alone —
      never a live env read, because every Session parameter is built under a
      per-attempt idempotency key. On that path `allow_promotion_codes` is
      **omitted, not sent as `false`** — Stripe rejects it beside `discounts`
      **by parameter presence, not by value**, so `false` fails the whole
      request; a full-price session still sends it. Asserting the two can
      coexist is what 500'd the first real staging checkout (**D-16**). The
      decision is logged and emitted as the
      durable `checkout_coupon_decision` analytics event (migration **106**).
      The dead `pending_payment_admin_handoff` screen is deleted; owners now
      self-activate through the funnel.
- [ ] **F2.** Create the coupon (100% off, `duration: repeating`,
      `duration_in_months: 3`) in **BOTH Stripe modes** — test mode for staging,
      live mode for prod. **The two IDs differ**; a test-mode ID deployed to live
      fails every invited tester's checkout identically (it raises
      `CheckoutCouponConfigurationError` + a Sentry report rather than a generic
      500, so the failure is legible — but it is still a failed checkout in front
      of a customer). **Verify `repeating` behaves as expected against the pinned
      Stripe apiVersion first** (deprecation risk flagged in review 2026-08-10;
      record a fallback plan — e.g. three cycle-scoped 100% promotions — in this
      box if it fails: `____`). Record both coupon IDs in `launch-checklist.md`.
- [ ] **F2b.** Set `BETA_COMP_COUPON_ID` on **Vercel, staging first**, and
      redeploy. Server-only, no `NEXT_PUBLIC_` companion (invariant #13), and
      deliberately **not** a Railway/worker variable — no worker path reaches
      `applyTierSnapshot`. Empty/whitespace reads as unset. **Unsetting is the
      kill switch and affects NEW attempts only**: an attempt that already
      snapshotted the coupon keeps it, which is the idempotency contract, not a
      bug. Hold the production value until F4 below.
- [ ] **F3. Staging smoke — the invited-owner loop end to end.** Run it as an
      operator, in this order, against staging. Every box is a thing you can
      actually see.
      1. **Migrations.** 105 and 106 are applied to the staging Supabase project.
         (Verify against the schema, not the migration ledger — see the lab note
         at the top of `.claude/reference/migrations-log.md`.)
      2. **Create the invite.** `/admin/businesses/new` (admin + AAL2) with three
         fields: owner email, owner name, business name. Submit → invite email
         arrives at the owner address.
      3. **Accept it.** Open the invite link, set a password → you are returned
         to `/login`. Sign in with the password you just set.
      4. **Land on the funnel.** With `ONBOARDING_DEMO_ENABLED=true` (it is
         **off by default** — set it on staging before this run, or the next
         assertion is wrong) you arrive at `/onboarding/start` with no place
         captured, **not** at `/onboarding/pay` and **not** on a dashboard dead
         end. Capture a location, let the AI demo run. With the demo off the
         correct landing is `/onboarding/pay` and the wizard captures the
         location instead — verify whichever posture that environment is
         actually in, and record which you tested.
      5. **Checkout says $0.** On the Stripe page: **Total due today = $0.00**,
         with the 3-month 100%-off discount shown. ❌ If it shows the full price,
         **stop** — the coupon did not attach; check `BETA_COMP_COUPON_ID` on the
         staging Vercel env and re-read the `checkout_coupon_decision` event
         (`reason: env_unset` vs `not_invited`) before retrying.
      6. **A card IS collected.** The card field is present and required. This is
         the `payment_method_collection: 'always'` assertion — a 100%-off
         subscription session would otherwise skip card collection and month 4
         would fail. Complete the checkout with a Stripe test card.
      7. **Subscription becomes active, carrying the discount.** In the Stripe
         dashboard: the Subscription is `active`, a **discount is attached** with
         3 months remaining, and the first invoice is **$0**. In the app: the
         account is out of `pending_payment` and the owner is in the wizard.
      8. **Month 4 is full price.** On the Subscription's upcoming-invoice /
         schedule view, confirm the **4th** billing cycle renders at the full
         founding rate, not $0. This is the single assertion that proves
         `duration_in_months: 3` behaved as intended against the pinned
         apiVersion — do not skip it, it is the whole point of F2's deprecation
         check.
      9. **Analytics.** One `checkout_coupon_decision` row exists for the attempt
         with `decision: applied`. A retry of the same attempt emits nothing
         further (no new decision was taken) — that is correct, not a gap.
      10. **Resend invite.** While a *second* test owner has not yet signed in,
          `POST /api/admin/businesses/[id]/resend-invite` re-sends. Then accept
          that invite and try again: the resend must be refused cleanly, not
          duplicated. ⚠️ **This is also the step that validates the provider
          error mapping in `src/lib/onboarding/resend-invite.ts`, which shipped
          deliberately staging-unverified** — record the actual Supabase error
          code/status you observe for the already-accepted case, and reconcile
          the mapping against it before prod.
- [ ] **F4. Production is gated on the WS8 cutover — do not run F2b in prod
      early.** The gate is now **code and Stripe, not schema**: as of 2026-08-14
      migrations 077, 105 and 106 are all applied in production, and **078** is
      the only one still outstanding (it applies in Phase D,
      `ws8-tier-cutover.md` §7). Order for prod: Phase D cutover (resume at §6 —
      §5/§8 are verify-only there) → set `BETA_COMP_COUPON_ID` (live-mode ID)
      → re-run the F3 smoke against production with a real card and an immediate
      cancel, or against a staff account. Until Phase D completes the
      invited-owner checkout path is **staging-only**, and
      `beta-onboarding-cofounder-guide.md` says so at the top.

### Phase G — Alerting + posture verification

- [ ] **G1.** Choose **ONE named non-email alert sink** (the docs currently
      disagree — Discord in `drift-alert.ts`'s comment, Slack/PagerDuty in
      `beta-launch-alerting.md`): `____`. Route to it: `subsystem:health_alert`,
      `cost_event:limit_exceeded`, `subsystem:import_consent_analytics`
      (frequency-conditioned), **and `feature:stripe_reconciliation`** (known
      unrouted — see the comment in
      `worker/background/pollers/billing-reconciliation/drift-alert.ts`).
- [ ] **G2.** Sentry Cron monitor `health-alert-poller` (environment
      `production`) + external `/ready` synthetic checks (worker + Next.js).
- [ ] **G3.** **Mutating acceptance drills run on STAGING only**
      (beta-launch-alerting §4). Production gets routing verification via safe
      synthetic canaries — never failure injection, worker stops, or cost-cap
      exhaustion against the live stack.
- [ ] **G4.** Provider moderation gate: the implementation is **binary**
      (`result.flagged`, `src/lib/moderation/moderate.ts`) — there is no
      threshold to "tune". Run the corpus validation in
      `docs/runbooks/auto-approval-provider-moderation-validation.md` against
      representative prod-like samples with recorded false-positive/negative
      acceptance criteria, then flip `OPENAI_MODERATION_ENABLED=true`.
      (`AUTO_APPROVAL_PROVIDER_MODERATION_READY` stays false — it is the
      later, auto-approval-gate marker.)
- [ ] **G5.** Walk `launch-flag-readiness.md`; append a fresh dated snapshot —
      Railway AND Vercel reads, including every Phase B audited flag.
- [ ] **G6.** Doc hygiene: correct env-vars.md's stale `ZERNIO_PUBLISHING_ENABLED`
      prod row; tick resolved launch-checklist items (only genuinely done ones).

### Phase H — Prove it (deployment-guide §9–§10)

- [ ] §9.1 sanity → §9.2 read-only backfill vs a friendly/test GBP → §9.3 cost
      sanity → §9.4 approval email → §9.5 approval page (**no approve click**).
- [ ] §9.6 — one deliberate first post, **clicked by a human**, kill switch
      (`ZERNIO_PUBLISHING_ENABLED=false`) ready. Then §11 day-2 monitoring.
- [ ] Only then: first beta business per
      `docs/runbooks/beta-onboarding-cofounder-guide.md`.

---

## Sign-off

- [ ] Step 0 complete: docs committed, SHA recorded, staging WS8 evidence at SHA
- [ ] Prod worker Online; `assertWorkerStartupEnv` green on the production lane
- [ ] WS8 §§1–7 evidence record complete (owner + observer signed), 077 AND 078
      applied in-sequence, legacy price vars retained for the rollback window
- [ ] All three live webhooks delivering (provider dashboards 2xx);
      `invoice.payment_action_required` subscribed
- [ ] Beta activation path staging-proven; coupon ID + apiVersion verification
      recorded
- [ ] Flag snapshot appended (Railway + Vercel); alerting routes verified via
      canary to the ONE named sink; staging drills passed
- [ ] §9.6 first deliberate post succeeded and verified on Google
- [ ] 🔴 hard blockers (PITR drill, legal review, insurance): each either
      **completed** or covered by a **dated, owner-approved policy change
      recorded in `launch-checklist.md`**. Never tick an incomplete box.
