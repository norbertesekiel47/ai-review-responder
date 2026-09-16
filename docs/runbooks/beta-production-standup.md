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

## §0. Verified current state

> **Refreshed 2026-09-06 (live reads).** The 2026-08-10 baseline below described a
> production backend that did not exist yet. Phases B–H have since run. Four rows
> were inverted by that execution and are corrected in place; the **Was (2026-08-10)**
> column keeps the original reading so the later phase text still reads in order.
> Two rows are **not** re-verified — see the note under the table.

| Piece | State (2026-09-06) | Was (2026-08-10) | Evidence |
|---|---|---|---|
| Vercel UI (`rep-worth` → repworth.net) | **Live** | Live | serving prod since 2026-05; `https://repworth.net` → 200 |
| Prod Supabase `udeyaqnvpojbwgoaxwdg` | ⚠️ **not re-verified** — see note | Live, healthy; 106 of 107 applied, only 078 outstanding | — |
| Staging (full stack) | **Live, proven** | Live, proven | §II.2.8 gate + staging runbook evidence |
| Railway prod worker (`repworth-worker`, project `ad641d0e-dc01-4250-b71c-db1beedb9c8c`) | **Online** — 1/1 replica, 0 crashed | Never successfully deployed | deployment `eade6192-fcd7-4992-9846-61def9c6b816` SUCCESS 2026-09-06T20:39:23Z; boot log carries `deployment_lane: production` |
| Railway prod queue Redis | **Provisioned and online** — service `Redis`, volume attached | Not provisioned | service `f9573767-3694-4b5e-b7d4-d7fe6dc53da8`, env `production`, deployment `c4564c44-…` SUCCESS 2026-08-31T02:21:30Z |
| Prod Sentry project | **Exists** — `repworth-production` | Does not exist (only `repworth-staging`) | org `repworth-nv` lists `repworth-production` + `repworth-staging`. `SENTRY_DSN` is now a **hard prod boot gate** (`assertAlertSinkEnv`), so the worker being Online is itself proof the DSN is set |
| Prod Stripe webhook endpoint | **Exists, enabled** — 6 events → `https://worker.repworth.net/ingress/stripe` | Does not exist | `we_1UANVYIhPBLaM6xAfIMs3eMN`, `livemode: true`, `status: enabled`, created 2026-08-31T05:11:48Z, `api_version 2026-05-27.dahlia` |
| Prod worker env vars | **Current** — satisfies the full boot-gate set | 35 set; stale vs the current boot-gate set (below) | the worker boots clean, and `assertWorkerStartupEnv` aborts startup on any missing gate. Exact count ⚠️ not re-counted |

> **Two rows deliberately left unproven, 2026-09-06.**
>
> 1. **Prod Supabase migration state.** `supabase_migrations.schema_migrations` on
>    `udeyaqnvpojbwgoaxwdg` holds only 10 rows, so **the ledger is not the schema**
>    and no count may be read from it. CLAUDE.md is explicit: derive lockstep by
>    **introspection**, never from the ledger or from a prose sentence. What the
>    ledger *does* confirm is that **078 is applied** (`20260831070901`), which
>    retires this row's "only 078 is outstanding" claim. A full re-audit belongs in
>    its own pass.
> 2. **Prod worker env var count.** The set is current — the boot gates prove that —
>    but "35" was never re-counted, so no replacement number is asserted here.

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
   > **Superseded 2026-09-06.** Both are applied and the exception is gone.
   > 078 landed in prod at 2026-08-31T07:09Z (ledger version `20260831070901`);
   > 077 was already there. CLAUDE.md now reads *"There is no standing migration
   > exception — staging and prod are in full lockstep."* This item is history,
   > not an instruction.
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

> **The boot-gated set is owned by `docs/runbooks/infisical-production-manifest.md`
> §1. Read it there; do not restate it here.** That table was derived from code
> at `f6695494` and cites the function that throws for every row.
>
> The list this blockquote used to carry was wrong in five places (manifest §7).
> It is recorded here so nobody re-derives the same errors:
>
> - `SERPAPI_API_KEY` is **not** boot-gated. `src/lib/config/worker.ts:50` types
>   it `rawOptionalVar`, and its only asserting accessor has no production caller.
> - `DATABASE_URL` is **not** boot-gated. `CORE_INFRA_REQUIRED_ENV` is four names
>   and this is not one of them. No production code reads it; it is
>   ops-and-migrations config.
> - `REDIS_CACHE_URL` is **not** boot-gated. The client is lazy, so a missing
>   value throws at first use. It is required in practice, not at boot.
> - `SESSION_COOKIE_SECRET` **is** an unconditional gate, and was omitted.
> - `NEXT_PUBLIC_APP_URL` **is** an unconditional gate, and was omitted.
>
> Both omitted gates fire through `assertUnsubscribeIngressConfigured`
> (`worker/index.ts:596`) on every deployed lane. A boot gate you did not plan
> for is a crash loop that exhausts `restartPolicyMaxRetries = 10` and stays down.
>
> `STRIPE_WEBHOOK_SECRET` and the six live `STRIPE_PRICE_*` IDs are produced in
> Phase D (endpoint + WS8 §1). Set every other gate now.

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
| Everything else | B2 audit: diff Railway prod var NAMES vs staging's + `.env.example`; resolve every gap deliberately; fresh `SESSION_COOKIE_SECRET`/`CSRF_SECRET`/`IMPERSONATION_COOKIE_SECRET` (≥32 chars); **leave `NODE_ENV` unset** and **do not create `MOCK_EXTERNAL_APIS`** — manifest §8 | §5.2, §II.3, manifest §8 |

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

> **DONE 2026-08-31.** Both endpoints were created through the **provider APIs**, not the
> dashboards — neither provider needed a browser. Full record: evidence file → **Phase E**.

- [x] **E1. Resend** → prod worker `/ingress/resend`. The signing secret is
      **provider-issued** (Svix `whsec_…`, shown when the endpoint is created)
      — paste Resend's value into `RESEND_WEBHOOK_SECRET`. *(Supersedes §1.2's
      "generate a 64-hex secret" — you cannot choose this one.)*
      **`POST https://api.resend.com/webhooks` creates it and returns `signing_secret`
      once.** Endpoint `3de61a3d-b4d5-416c-a0db-5d581d730a02`, 4 events, `enabled`.
      Value written to Infisical `prod` from a mode-600 file; sync-to-Railway confirmed by
      SHA-256 fingerprint, never by reading it.
- [x] **E2. Zernio** → prod worker; live key; verify per §6.2.
      **`POST https://zernio.com/api/v1/webhooks/settings` creates it and takes a
      caller-supplied `secret`,** so the existing `ZERNIO_WEBHOOK_SECRET` was used
      verbatim. Subscription `6a95315320358f33c89599e5`, 4 events, active.
      `webhook.test` is **not subscribable** — fire it with `POST /v1/webhooks/test`.
- [x] **E3. Delivery proven, both providers.** `zernio/webhook.test` and
      `resend/email.delivered` both wrote `status='processed'` rows to production
      `inbound_events` — the first two rows that table has ever held.
- [x] Staging endpoints stay pointed at staging; never re-point. Verified after both
      creates: both still resolve to `repworth-worker-staging.up.railway.app`.

> **Owed out of Phase E — ✅ DONE 2026-09-01. All three production secrets rotated.**
> `infisical secrets` printed values **by default**, not masked, exposing `RESEND_API_KEY`,
> `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET` to a session transcript (**E-F1**). All three
> were replaced and the change is proven end to end — fingerprints changed in the running
> production worker, Vercel redeployed and confirmed aliased to `repworth.net`, the Zernio
> subscription's stored `secret` byte-identical to the vault value, and a real signed
> `webhook.test` verified and `processed` in 64 ms. Record:
> `docs/runbooks/evidence/2026-09-01-secret-rotation-evidence.md`.
>
> Three corrections that outlive the incident:
> - **`RESEND_WEBHOOK_SECRET` was NOT rotated** — it is provider-issued (Svix) and rotating it
>   means recreating the endpoint. Still live. Its own change.
> - **The update path is `PUT /v1/webhooks/settings` with `_id` in the BODY** — the RESTful
>   form `PUT …/settings/{id}` 404s (D-5).
> - **`secrets-rotation-api-keys.md` was never in scope**, despite E-F1 naming it. Its scope is
>   `ENCRYPTION_KEY` / `SESSION_COOKIE_SECRET` / `CSRF_SECRET`; rotating those logs every owner
>   out (D-2). Only the Zernio and email runbooks apply, and **both were rewritten** — they
>   still described the pre-vault "write to Railway" architecture (D-1).

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
- [x] **F2. DONE 2026-08-31.** Coupon id **`repworth-beta-comp-3mo`** — the **SAME
      id in both modes**, not two ids. Test mode pre-existed (2026-08-21); live mode
      created 2026-08-31. One id in both modes makes the "test id deployed to live"
      failure below structurally impossible. **The `repeating` deprecation check
      PASSES** under the pinned `Stripe-Version: 2026-05-27.dahlia`:
      `percent_off=100`, `duration=repeating`, `duration_in_months=3`, `valid=true`,
      `livemode=true`. **No fallback is needed** — the three cycle-scoped promotions
      are not required. ⚠️ **Read the id the environment already names BEFORE
      creating anything** — the first live create used a fresh id and had to be
      deleted. Evidence file → **F.2c**. Original text follows.
      Create the coupon (100% off, `duration: repeating`,
      `duration_in_months: 3`) in **BOTH Stripe modes** — test mode for staging,
      live mode for prod. ~~**The two IDs differ**~~ (they do not, here); a test-mode ID deployed to live
      fails every invited tester's checkout identically (it raises
      `CheckoutCouponConfigurationError` + a Sentry report rather than a generic
      500, so the failure is legible — but it is still a failed checkout in front
      of a customer). **Verify `repeating` behaves as expected against the pinned
      Stripe apiVersion first** (deprecation risk flagged in review 2026-08-10;
      record a fallback plan — e.g. three cycle-scoped 100% promotions — in this
      box if it fails: `____`). Record both coupon IDs in `launch-checklist.md`.
- [x] **F2b. Staging DONE — it was already set** on Vercel `staging`
      (`repworth-beta-comp-3mo`, 2026-08-21). Verified by readback, not assumed.
      **Production is HELD for F4, and it is held structurally:** the key is absent
      from Vercel `Production` **and** absent from the Infisical vault `prod`, so no
      Secret Sync can push it there by accident. Adding it to the vault IS the F4
      flip. Evidence file → **F.2d**. Original text follows.
      Set `BETA_COMP_COUPON_ID` on **Vercel, staging first**, and
      redeploy. Server-only, no `NEXT_PUBLIC_` companion (invariant #13), and
      deliberately **not** a Railway/worker variable — no worker path reaches
      `applyTierSnapshot`. Empty/whitespace reads as unset. **Unsetting is the
      kill switch and affects NEW attempts only**: an attempt that already
      snapshotted the coupon keeps it, which is the idempotency contract, not a
      bug. Hold the production value until F4 below.
- [x] **F3. DONE 2026-08-31 — ALL TEN STEPS PASS.** Run against
      `https://staging.repworth.net` at repo HEAD `37a3b49b`, with every API and
      database assertion verified independently rather than read off a screen.
      **Posture tested: `ONBOARDING_DEMO_ENABLED=true`**, so step 4 landed on
      `/onboarding/start`; `AUTOPILOT_PURCHASABLE=false`, so the run priced
      against Copilot founding, **$19.00/month**. Owner A
      `norbert.esekiel@repworth.net` walked steps 2–9; Owner B `nsunn@usc.edu`
      served step 10. Key artefacts: subscription `sub_1UAaO2IhPBLaM6xA5AI1YZrj`,
      **Checkout attempt** `aa86f64e-f026-449b-972d-ceebe3d3b890`, first invoice
      `in_1UAaO0IhPBLaM6xAxTgziJ1B` (**total $0.00** on a $19.00 subtotal), card
      `pm_1UAaO0IhPBLaM6xAv6XPwnke` (visa ·4242) captured on that $0 invoice, and
      `checkout_coupon_decision` = `applied` / `coupon_applied: true`.
      **Step 8 passed by boundary proof:** the discount's `end` is
      2026-11-30T18:56:52Z, the cycle-4 anchor to the second — a rendered 4th
      invoice needs a Stripe **test clock**, which a real Checkout cannot have.
      **Three findings (F3-F1…F3-F3)** — step 10 tests the eligibility gate and
      **cannot** reach the provider mapping; `resend-invite.ts` has not been
      staging-unverified since 2026-08-14; and migration 106's own header is the
      one stale copy of the coupon-event emission point (the owning
      `migrations-log.md` entry is already correct).
      Evidence file → **Phase F.3**. Original text follows.
      Run it as an
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
          duplicated. ⚠️ **CORRECTED 2026-08-31 (finding F3-F1) — this step tests
          the eligibility GATE, and it cannot reach the provider error mapping.**
          `resendOwnerInvite` throws `OWNER_ALREADY_SIGNED_IN` on
          `last_sign_in_at` **before** `inviteUserByEmail` is ever called, so the
          code you observe is always ours, never Supabase's. Observed:
          **409 Conflict**, `code: "OWNER_ALREADY_SIGNED_IN"`, and **no third
          email** (`invited_at` unmoved on re-read). Record those.
          ~~**This is also the step that validates the provider
          error mapping in `src/lib/onboarding/resend-invite.ts`, which shipped
          deliberately staging-unverified** — record the actual Supabase error
          code/status you observe for the already-accepted case, and reconcile
          the mapping against it before prod.~~ That mapping was **already
          verified on 2026-08-14** against this same staging project
          (`email_exists` / 422 → 409); `INVITE_ERROR_CODE_MAP`'s header says
          `CONTRACT VERIFIED` and cites
          `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md`
          → **D-13**. Reaching that table needs a different test, one that
          bypasses the gate.
- [x] **F4. DONE 2026-08-31 — THE D.6 DEBT IS CLOSED.** Production completed a
      live-mode Checkout, and it was the owner's. Session
      `cs_live_a1viDmqFYmwiSulmWEjXhfRmrlOTxoexml4WrBGnyOZhjNTnDjAPUs7MBQ`,
      subscription `sub_1UAbs7IhPBLaM6xASGkfGz2V`, invoice
      `in_1UAbs5IhPBLaM6xA0uqtVYAB` — **subtotal $19.00, total $0.00, `paid`**, card
      `pm_1UAbs5…` (visa ·6733) captured on that $0 invoice. `payment_method_collection`
      read back as **`"always"`** and `allow_promotion_codes` as **`null`** (omitted, not
      `false` — the D-16 fix holds live). 4th cycle full price by boundary proof: discount
      `end` = 2026-11-30T20:32:01Z, the cycle-4 anchor to the second. Subscription
      cancelled **immediately** afterwards; **the owner was charged $0.00**.
      **The live Stripe webhook is now proven** — `invoice.paid`,
      `checkout.session.completed` and `customer.subscription.deleted` all `processed`,
      zero errors, on an endpoint that had never been delivered to since D.3.
      ⚠️ **Two production COMMISSIONING gaps found on the way, either of which would have
      stopped beta tester one:** production had **no admin user at all** (F4-F1), and the
      Supabase Auth **Site URL was `http://localhost:3000`**, so the invite email pointed at
      a machine that is not ours (F4-F2). Both fixed in-session; `deployment-guide.md` gains
      the production URL-configuration step it never had. Four more findings F4-F3…F4-F6.
      Evidence file → **Phase F.4**. Original text follows.
      ~~Production is gated on the WS8 cutover — do not run F2b in prod
      early.~~ The gate is now **code and Stripe, not schema**: as of 2026-08-14
      migrations 077, 105 and 106 are all applied in production, and **078** is
      the only one still outstanding (it applies in Phase D,
      `ws8-tier-cutover.md` §7). Order for prod: Phase D cutover (resume at §6 —
      §5/§8 are verify-only there) → set `BETA_COMP_COUPON_ID` (live-mode ID)
      → re-run the F3 smoke against production with a real card and an immediate
      cancel, or against a staff account. Until Phase D completes the
      invited-owner checkout path is **staging-only**, and
      `beta-onboarding-cofounder-guide.md` says so at the top.

### Phase G — Alerting + posture verification

- [x] **G1. DONE 2026-08-31.** All four signals reach the owner's prod-only Discord
      channel. Two rules: Discord added to existing `3920752`, and new `3925256`
      "Prod — four ops signals to Discord" carrying all four `Tagged event` filters with
      `any` logic → Discord (integration `443670`, channel `1544045194264051842`,
      tags `repworth-prod`). **Verified by API readback and by a test notification the
      owner received in the channel.**
      ⚠️ **Named tradeoff:** one rule, not four. `subsystem:import_consent_analytics` is
      supposed to be *frequency-conditioned* but shares this rule's "notify on every
      trigger" throttle — **split it into its own rule if it proves noisy.** Both rules
      also keep the default "An issue is resolved" trigger, so a resolve posts to Discord.
      Evidence file → **Phase G.1**. Original scoping follows.
      ~~NOT DONE, precisely scoped 2026-08-31.~~ The sink is **Discord** and the
      integration already works (id `443670`; the staging rule fired 2026-08-31T01:00:46Z).
      **What is missing is every production rule.** `repworth-production` has exactly one
      alert rule (3920752) and its only action is **Email**; it has never triggered. None
      of the four signals is routed, in either project.
      **There is no "link a channel" step** — the *server* is linked once at org level, and
      a *channel* is named per action as a **channel ID or URL** (not a name). The Sentry
      bot must be able to see the channel; a private channel needs the bot added with
      *View Channel* + *Send Messages*. Verify with **Send Test Notification** on the rule.
      **UI work:** the Sentry MCP has no create/update tool for alert rules. Build them at
      `https://repworth-nv.sentry.io/monitors/alerts/`. Evidence file → **Phase G.1**.
      Original text follows.
      Choose **ONE named non-email alert sink** (the docs currently
      disagree — Discord in `drift-alert.ts`'s comment, Slack/PagerDuty in
      `beta-launch-alerting.md`): `____`. Route to it: `subsystem:health_alert`,
      `cost_event:limit_exceeded`, `subsystem:import_consent_analytics`
      (frequency-conditioned), **and `feature:stripe_reconciliation`** (known
      unrouted — see the comment in
      `worker/background/pollers/billing-reconciliation/drift-alert.ts`).
- [x] **G2. DONE 2026-08-31** — after the owner upgraded to a **Teams plan (20 monitors)**.
      All three production monitors are **active**: `health-alert-poller` (cron, environment
      `production` = `ok`, last check-in 18:00:53Z), `Prod worker /ready` (8341697, 300 s),
      `Prod app /api/health` (8341701, 300 s). **The cron monitor healed itself** — the SDK
      sends an upserting check-in, so the first beat after a seat freed up flipped it from
      `disabled` to `active` with no manual step. The production dead-man heartbeat is live.
      **Residual: routing, not monitoring — see G1.** Original diagnosis follows, kept
      because the signature is reusable.
      ~~BLOCKED on a Sentry billing seat — root cause proven 2026-08-31.~~
      The monitor and the code are both fine. The production `health-alert-poller`
      monitor exists and the worker **is** sending check-ins; Sentry rejects every one
      with `Monitor disabled`. Activating any monitor returns
      `"You don't have enough pay-as-you-go available to create a new seat"`, and
      `Settings → Subscription` reads **Developer plan, no payment method on file**.
      The two staging monitors hold the available seats. Two production uptime monitors
      are **created and staged disabled** — `Prod worker /ready` (8341697) and
      `Prod app /api/health` (8341701), both 300 s.
      **Two ways out, neither a button on the monitor page:** (a) free — disable the two
      staging monitors to release their seats, then enable the production ones;
      (b) paid — add a payment method + pay-as-you-go budget.
      **Until then, treat production as unmonitored by Sentry crons and uptime.**
      Monitors live at `https://repworth-nv.sentry.io/monitors/` — the
      `…/crons/<project>/<slug>/` path 404s. Evidence file → **Phase G.2**.
- [ ] **G3. IN PROGRESS — 8 of 10 drills PASS as of 2026-09-01T06:25Z.** Session 3 added
      **§4.6 PASS** and **§4.10 PASS**. §4.6: four svix-signed `email.complained` POSTs, all
      `200`, one permanent ledger row from four POSTs (first-write-wins), Sentry group 2 → 6,
      rule `3927243` `lastTriggered 06:07:44.526Z`. §4.10: peak pending **50** against the
      1500 threshold, drained in **13 min** against a 30-min target, zero `failed`, no
      `backlog_depth` finding, three clean poller check-ins spanning the drill; teardown
      verified back to 5 `job_outbox` rows.
      **Six deviations, and four of them correct standing claims.** **D-10** — the §4.6 probe
      session 2 recorded as "ready" would have returned `401` on every POST (it keyed the HMAC
      with the raw `whsec_…` string; the ingress uses the decoded bytes). **D-11/D-13** — rule
      6's `Issue occurrences: 4` is **cumulative with no interval** and fires on occurrence
      **5**, not 4; the runbook's "more than 3 in one hour" describes neither, and in
      production the first FOUR unattributed suppressions will page nobody. **D-12** — the
      recorded suppression baseline of 5 was stale; the table was empty. **D-14** — **§4.8 has
      a second break**: a Sentry cron issue carries no `subsystem`/`cost_event`/`feature` tag,
      so staging's newly-scoped `3608329` cannot route it and staging has no other Discord
      rule; fixing the monitor alone cannot make the drill pass. **D-15** — `release` cannot
      clean the §4.10 headroom arm (it is scoped `status='pending'`) and reports "inventory
      clean" anyway.
      **§4.6's Discord delivery is owner-confirmed** — exactly one message at 11:07 PM local
      (= 06:07Z), matching `lastTriggered`, and Discord's message grouping puts the group
      header at 11:07 PM, which confirms the silence at 11:05:59 PM and 11:06:38 PM. §4.6
      closes PASS on both halves.
      **D-16 corrects §4.8's remedy.** The monitor's `failure_issue_threshold` is **already 1**
      — read from the config snapshot embedded in `REPWORTH-STAGING-8`, the one cron issue this
      monitor has ever made (225 occurrences, 2026-06-26). So "set the threshold" was inert
      advice in two handoffs. That issue also proves missed check-ins DO count, and gives the
      cron issue's complete tag set — confirming D-14 by evidence and making `monitor.slug` a
      verified filter key. The real gap is the monitor's **notification target/owner**, which
      `recordProbeCheckIn`'s upsert cannot set.
      **Two owner decisions taken on best practice, 2026-09-01:** (a) **drop rule 6's
      occurrence filter** in both projects — a detector for an open blocker must not be silent
      on its first N occurrences, and a cumulative counter cannot express the intended rate;
      the 60-minute throttle is the correct volume control, and a metric alert is the correct
      instrument if a real rate condition is ever needed. (b) **a dedicated cron routing rule**
      per project rather than widening `3608329`/`3925256`, keeping last night's scoping intact.
      **Still open: §4.8** (needs the monitor's notification target, the cron routing rule, and
      then a re-run — both projects) and **§4.7** (BLOCKED — needs a custom domain for the
      staging worker).
      Previous 6-of-10 record follows.
      ~~**G3. IN PROGRESS — 6 of 10 drills PASS as of 2026-09-01T05:47Z.**~~ §4.2, §4.3, §4.5,
      §4.4, §4.1 and §4.9 all pass with owner-confirmed Discord delivery. **§4.8 is a QUALIFIED
      FAIL** — the cron dead-man switch detects a stopped worker (2 missed check-ins, `ok` →
      `error`) and **creates no issue, so pages nobody**; its panel says the threshold is one
      failed check-in, so this is a real gap and production runs the identical monitor. **§4.6
      is unblocked but not yet run** — rule 6 was created in BOTH projects on 2026-09-01
      (`3927243` staging, `3927261` production), closing D-3's live production gap before
      solicitation sending is ever enabled there; staging's catch-all `3608329` was scoped to
      the same four tag filters production carries. **§4.7 is BLOCKED infrastructurally (D-6)**
      — Sentry refuses `*.railway.app` (platform-wide cap of 1000 uptime monitors), so staging
      has no worker uptime monitor and cannot get one until the worker has a custom domain.
      **§4.10 unattempted.** Two of the five session-2 deviations are corrections to my own
      earlier claims (D-8 frequency-condition location, D-9 an invalid `is:unresolved` query),
      and D-7 corrects D-1: §4.1 was **not** unrunnable — it folds into §4.9, not §4.7, and now
      passes. Teardown complete, staging clean. Evidence:
      `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md`.
      Original 2 of 10 record follows.
      ~~**G3. IN PROGRESS 2026-08-31 — 2 of 10 drills PASS, after they found and fixed a
      PRODUCTION alerting defect.**~~ ⚠️ **A recurring ops finding pages nobody.** §4.2 and §4.3 both
      fired correctly and both reached Sentry; **neither produced a page**. Cause is issue
      GROUPING: `emitHealthFindings` uses `Sentry.captureMessage`, so a repeat finding joins
      its existing group, and **both** alert rules trigger only on *First seen / Resolved /
      Reappeared / Regression*. An ongoing group is none of those. **Production rule
      `3925256` — created in G.1 — has the identical trigger set**, so its four ops signals
      page on a signal's FIRST occurrence and are silent thereafter. G.1 verified routing
      with a **test notification**, which is by construction a first-seen event, so its
      "four signals reach Discord" holds for the first occurrence only.
      ✅ **FIXED AND PROVEN, same session.** Both rules gained the **`Every event`** trigger
      (the UI's *"An event or issue activity is captured"* — there is no *"seen more than 0
      times"* option) plus a **60-minute Action Throttle**, so repeats page at most hourly per
      issue while a new issue still pages at once. Staging updated 21:30:58Z, production
      21:34:53Z; **nothing removed from either rule**, verified by API readback.
      **Controlled re-run proves it:** identical fixtures against the **same pre-existing
      Sentry groups** — before, `lastTriggered` did not move across two cycles; after, it read
      **21:37:05Z**, 15 s after the poller cycle. §4.2 and §4.3 now **PASS**. Also **D-1: §4.1 is unrunnable as written** — the OutboxPoller
      claims the fixture (5 s) 60× faster than the health check reads it (300 s), so it must
      fold into the §4.7 worker-stop drill. Teardown complete, staging clean, production
      untouched. Evidence:
      `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md`.
      Original text follows.
      **Mutating acceptance drills run on STAGING only**
      (beta-launch-alerting §4). Production gets routing verification via safe
      synthetic canaries — never failure injection, worker stops, or cost-cap
      exhaustion against the live stack.
- [x] **G4. DONE 2026-08-31 — flipped AND validated in production.** The
      implementation is **binary** (`result.flagged`, `src/lib/moderation/moderate.ts`) —
      there is no threshold to "tune".
      ⚠️ **ORDER CORRECTION.** This box used to say "run the validation, **then** flip".
      That is impossible: with the flag off, `moderateResponse` returns the local decision
      before it ever calls the provider, so the clean-provider check cannot be observed.
      The runbook is right — setting `OPENAI_MODERATION_ENABLED=true` is a **Required
      Environment** precondition of the validation, not its conclusion.
      Written to the **Infisical vault `prod`** (one source of truth for Railway + Vercel),
      confirmed live, then all three checks run against the real provider with production
      credentials: clean → `providerStatus:"clean"`; flagged → `flagged:true`,
      `severity:"high"`, `openai_categories` present; provider error → falls back to local,
      `providerStatus:"error"`, no throw. **All PASS.**
      `AUTO_APPROVAL_PROVIDER_MODERATION_READY` **stays false** — it is the later,
      auto-approval-gate marker, and the runbook's permission to set it is deliberately
      not taken. Evidence file → **Phase G.4**.
- [x] **G5. DONE 2026-08-31.** Four-surface snapshot appended to
      `launch-flag-readiness.md` — Railway prod/stg **and** Vercel prod/stg, 26 flags.
      **Production autonomy posture is correct and consistent on both surfaces.**
      `ONBOARDING_DEMO_ENABLED` is already `true` everywhere — that rollout step was
      **not** owed. No staging drift: four blank Vercel staging reads are `Secret`-type,
      not empty (the F8 mistake, avoided). **Finding G5-F1:** the Infisical Secret Sync
      does NOT preserve Vercel's Sensitive flag — Production went 9 `Secret` → 4, and the
      4 survivors are exactly the 4 the vault does not manage. That turns the owed
      "re-add three vars as `--sensitive`" action into an owed **decision**.
- [x] **G6. DONE 2026-08-31.** `env-vars.md`'s `ZERNIO_PUBLISHING_ENABLED` prod row
      corrected — the `2026-04-28` date was wrong, because the 2026-06-26 worker read
      recorded prod **off**; the row now cites the four-surface re-verification instead.
      Two launch-checklist items ticked, both genuinely done: the
      `ONBOARDING_DEMO_ENABLED` production rollout step (already true) and the
      flag-readiness snapshot walk (G5).

### Phase H — Prove it (deployment-guide §9–§10)

- [x] **DONE 2026-09-16.** §9.1 sanity → §9.2 consented import (31 reviews) → §9.3 cost
      sanity (OpenAI confirmed, $0.000168 for the run) → §9.4 approval email sent AND
      delivered → §9.5 approval page audited read-only, no approve click.
- [x] **§9.6 DONE 2026-09-16T10:37:40Z** — one deliberate first post, clicked by the owner,
      `approval_method='owner'`, kill switch ready and unused. §11 day-2 monitoring starts now.
- [x] **First beta business onboarded 2026-09-16** — tester one is a live paying-in-month-four
      customer. Evidence: `evidence/2026-09-16-beta-tester-one-evidence.md`.

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
- [x] §9.6 first deliberate post succeeded and verified on Google (2026-09-16T10:37:40Z)
- [ ] 🔴 hard blockers (PITR drill, legal review, insurance): each either
      **completed** or covered by a **dated, owner-approved policy change
      recorded in `launch-checklist.md`**. Never tick an incomplete box.
