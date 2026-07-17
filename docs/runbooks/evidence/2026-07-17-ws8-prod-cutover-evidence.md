# WS8 tier cutover — PRODUCTION evidence record

| Field | Value |
|---|---|
| Environment | production |
| Cutover owner | Norbert Esekiel (norbertesekiel@gmail.com) |
| Observer | **UNFILLED** — owner-approved deviation, decided 2026-07-16 (staging precedent; recorded, not silent) |
| Repo HEAD at start | d5ce8c38 (staging branch; prod deploys `main` @ 7342160a until the merge) |
| UTC start | 2026-07-17T00:22:11Z |
| Stripe mode/account | **live** / acct_1TUcR7IhPBLaM6xA (RepWorth, Inc.) — same account as staging's test mode |
| Staging evidence | ACCEPTED by owner 2026-07-16 (`docs/runbooks/evidence/2026-07-16-ws8-staging-cutover-evidence.md`) |
| Migrations present | pending prod DB introspection (phase 2 recon) |

## Owner decisions recorded at start (2026-07-16, in-session)
1. **Cost ceilings (integration owner supplied, per §1 "do not invent"):** `DAILY_COST_LIMIT_CENTS_COPILOT=500`,
   `DAILY_COST_LIMIT_CENTS_AUTOPILOT=1500` — same as staging.
2. **Prod DB access:** operator approves agent's DB commands per-prompt; 077 apply is its own approval.
3. **Observer:** unfilled, recorded (see header).
4. **§2.2 WAF:** **FULL producer denial per runbook** — prod does NOT inherit staging's skip.

## Pre-flight reconnaissance (read-only, 2026-07-17T00:0x–00:22Z)

**Production has never been launched.** Verified:
- **Live Stripe account is virgin**: 0 Prices, 0 Products, 0 webhook endpoints. `charges_enabled=false` — the live
  account cannot process payments until Stripe activation completes. Not a phase 1–5 blocker (no payments taken);
  **it IS a phase-6/launch blocker**: no prod smoke Checkout can complete until activation. Parked for owner.
- **Prod Railway worker unconfigured**: no active deployment; every secret NOT_SET except `WORKER_INTERNAL_SECRET`
  (the transcript-leaked one — rotation owed, see below); no flags, no price vars.
- **Prod Vercel**: only DB/Supabase vars — no `STRIPE_SECRET_KEY`, no prices, no flags. Prod UI cannot create a
  Checkout Session today.
- Consequence: the §4 expectation "prod should need NO orphan allowlist" is plausible — the live account has zero
  subscriptions of any kind.

## Phase 1 — Prices and configuration

### Live Price creation — BLOCKED at first attempt, by design
The local Stripe CLI holds a **read-only restricted live key** (`rk_live_…` — writes rejected:
"does not have the required permissions"). Verified nothing partial was created (0 products after the attempt).
The full live secret key must never transit an agent transcript, so the sanctioned path is: **owner sets
`STRIPE_SECRET_KEY` (live) on the prod Railway worker + Vercel production themselves**; every subsequent Stripe
write runs through `railway run --environment production` env injection — identical to the staging pattern, key
never observed. Price creation pending that step.

Planned live catalog (mirrors staging's test catalog exactly — verified against the six staging Price objects):
| Product | Price | Amount | Nickname |
|---|---|---|---|
| RepWorth Copilot | COPILOT_LIST | 2900 | Copilot base |
| RepWorth Copilot | COPILOT_FOUNDING | 1900 | Copilot founding base |
| RepWorth Autopilot | AUTOPILOT_LIST | 6900 | Autopilot base |
| RepWorth Autopilot | AUTOPILOT_FOUNDING | 4900 | Autopilot founding base |
| RepWorth Copilot - Extra Location | COPILOT_OVERAGE | 1500 | Copilot extra location |
| RepWorth Autopilot - Extra Location | AUTOPILOT_OVERAGE | 2000 | Autopilot extra location |
All USD, monthly recurring, no `tax_behavior` (Stripe Tax not enabled — parity with staging).

### Retained-legacy variables — SENTINELS (prod deviation from staging, with rationale)
§1 retains the 7 old Price variables so §4 can identify open legacy-Price Checkout Sessions. **Production never
had legacy Prices** (live account virgin), but the preflight hard-requires all 7 nonblank
(`requiredConfiguredPriceIds`, `ws8-stripe-cutover-preflight.ts:612`). They are matching-only — never retrieved
from Stripe. Set to explicit sentinels (`price_none_prod_never_had_basic`, …) on both platforms: nonblank,
disjoint from the six new IDs, and incapable of matching any real Session line item. The gate's semantics hold
vacuously. Recording this here so nobody later mistakes the sentinels for real rotated Prices.

### Applied and verified (fresh reads, both platforms) — 2026-07-17T00:2xZ
| Var | Railway prod worker | Vercel production |
|---|---|---|
| FOUNDING_DEADLINE | 2027-01-01T00:00:00Z ✅ | "2027-01-01T00:00:00Z" ✅ |
| DAILY_COST_LIMIT_CENTS_COPILOT | 500 ✅ | "500" ✅ |
| DAILY_COST_LIMIT_CENTS_AUTOPILOT | 1500 ✅ | "1500" ✅ |
| AUTOPILOT_PURCHASABLE | false ✅ | "false" ✅ |
| 7 × legacy sentinels | all set ✅ | all set ✅ |

Vercel values verified via `env pull` (values, not `env ls` presence — staging resume lesson: presence lies).

### Owed before phase 1 closes
- [ ] Owner sets live `STRIPE_SECRET_KEY` **and `DATABASE_POOL_URL`** on the Railway prod worker (both needed for
      `railway run` to drive the §3/§4 scripts), plus `STRIPE_SECRET_KEY` on Vercel production (needed at merge).
      Never via agent.
- [ ] Agent creates the 6 live Prices via `railway run` injection; verifies each by fresh retrieve; sets the 6
      price vars on both platforms; verifies by fresh read/pull.
- [ ] `WORKER_INTERNAL_SECRET` rotation on prod Railway (leaked value still present; classifier blocked the
      agent's inline rotation — owner rotates, or approves the standalone rotation command).

## Prod DB findings — CORRECTION to "never launched" and the synthetic-data purge

**Correction:** the earlier recon line "Production has never been launched" was imprecise. Production was never
*monetized* (live Stripe virgin), but its DB contained **12 tenant accounts — all synthetic**:
- 7 owners `@repworth.invalid` (seed/demo data), 5 `@test.local` (E2E fixtures);
- 3 accounts projected **fake subscriptions** (`sub_e2e_fc9b80c2`, `sub_e2e_cc486a1f`, `sub_e2e_1894b3fb`) that
  exist in NO Stripe mode — the "disagreeing projection" class §4 blocks on, with **no sanctioned repair path**
  (the reviewed-orphan allowlist covers provider-side debris only);
- 1 account on tier **`pro`** — a value in no tier taxonomy, legacy or new;
- 10 of 12 businesses admin-onboarded; `prospect_demos` empty (no public demo depends on these rows);
- all 166 outbox rows terminal (114 completed `account_offboarding_purge` — synthetic accounts had been churned
  through offboarding before); **no admin users existed in prod** (all 12 users owned synthetic accounts).

**Owner decision (2026-07-16, in-session): purge all synthetic tenant rows before 077.** Rationale: zero real
customers; carrying the debris through the one-way 077 door would strand fake projections against reconciliation
pollers forever and stamp immutable `list` variants on garbage; purging makes §4 pass with **zero allowlist**
(the handoff's "prod needs no allowlist" expectation holds) and 077 becomes schema-only.

**Execution (owner-run; agent's TRUNCATE was classifier-blocked — correctly, for a prod-destructive op):**
1. First attempt (13 nonzero tables) **refused by design**: `api_costs` (0 rows) references `accounts` and was
   unlisted — the deliberate no-CASCADE construction rolled everything back. Lesson recorded: **TRUNCATE scope
   must be the structural FK closure, not the nonzero-row inventory.**
2. Closure computed recursively from `pg_constraint` (36 tables). Owner executed the single-statement TRUNCATE
   via SQL editor; owner verified zeros.
3. **Agent independent verification 2026-07-17T01:11:05Z:** accounts/users/businesses/reviews/responses/outbox/
   offboardings/api_costs/zernio_connections ALL 0; schema intact; `price_variant` absent (077 correctly still
   unapplied).

The purge SQL (for the record):
```sql
TRUNCATE TABLE account_audit_log, account_offboarding_tokens, account_offboardings, accounts,
  agent_outcomes, agent_run_steps, agent_runs, analytics_events, api_costs, api_costs_daily_rollups,
  approval_audit_log, approval_links, auto_approval_policies, businesses, channel_enrollments,
  flagged_responses, google_connections, impersonation_sessions, job_outbox, judge_verdicts,
  monthly_impact_emails, notification_deliveries, onboarding_demos, onboarding_drip_log, prospect_demos,
  ranking_snapshots, responses, review_escalations, review_exceptions, reviews, satisfaction_responses,
  users, weekly_summaries, zernio_backfill_runs, zernio_connections, zernio_finalize_incidents;
```

## Session pause point (2026-07-17T01:1xZ) — clean state, nothing dangling

| Done | Pending |
|---|---|
| Phase 1 operator vars + legacy sentinels, both platforms, verified | Live Prices (blocked on owner's `STRIPE_SECRET_KEY` on Railway) |
| Prod DB purged to zero + independently verified | 6 price vars on both platforms (follows price creation) |
| Live account identity + charges_enabled=false recorded | Phase 2: **full WAF producer denial** (owner-decided, not started) + quiescence samples |
| Owner decisions 1–4 recorded | Phase 3 verify-prices, Phase 4 preflight (expect 0 blockers, NO allowlist), Phase 5 077 (owner pastes via SQL editor) |
| | Then merge #469 → prod phase 6 smoke (blocked on Stripe `charges_enabled`) → 078 → resume |

## Phase 1 COMPLETE + early gate results (2026-07-17T01:49–01:53Z)

Owner placed the live `STRIPE_SECRET_KEY` on both platforms (Railway UI lesson: variable edits sit as **staged
changes** until "Deploy" is clicked — the first attempt silently didn't exist until applied). Verified presence +
`sk_live_` prefix by fresh read. `WORKER_INTERNAL_SECRET` rotated by owner (fresh 64-char value). Agent copied
`DATABASE_POOL_URL`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` from Vercel production to the Railway
prod worker (values never displayed; all needed at merge-time regardless — the §4 script's import graph loads the
Supabase client, so the worker env must carry them).

**Six live Prices created 2026-07-17T01:49:07Z** via `scripts/ws8-create-launch-prices.ts` under
`railway run --environment production` injection (script refuses non-live keys; idempotent by
product-name + amount + interval matching; every Price verified by fresh retrieve):

| Env var | Live Price ID | Amount |
|---|---|---|
| STRIPE_PRICE_COPILOT_LIST | price_1Tu0tlIhPBLaM6xAh1ncYUyD | 2900 |
| STRIPE_PRICE_COPILOT_FOUNDING | price_1Tu0tlIhPBLaM6xAqs62deIQ | 1900 |
| STRIPE_PRICE_AUTOPILOT_LIST | price_1Tu0tmIhPBLaM6xAstHkMhBE | 6900 |
| STRIPE_PRICE_AUTOPILOT_FOUNDING | price_1Tu0tmIhPBLaM6xAWQWKfjLu | 4900 |
| STRIPE_PRICE_COPILOT_OVERAGE | price_1Tu0tmIhPBLaM6xAUH8w841l | 1500 |
| STRIPE_PRICE_AUTOPILOT_OVERAGE | price_1Tu0tnIhPBLaM6xAhDUqdd3r | 2000 |

All `livemode=true`, USD, monthly, active. The 6 vars set + verified (fresh read/pull) on Railway prod worker AND
Vercel production.

**§3 parity (informal early run):** `Stripe price parity OK for 2 tiers, 2 variants, and 0 retained overage
Prices.` — 2026-07-17T01:50:18Z.
**§4 preflight dry-run (informal early run, NO allowlist):**
`SCANNED subscriptions=0 open_sessions=0 line_items=0 expired_sessions=0 status_notices=0` →
**`WS8_PREFLIGHT_PASS blockers=0`** — 2026-07-17T01:52:57Z. The handoff's "prod should need NO allowlist"
expectation HOLDS.

Both §3/§4 will be re-run formally after §2 quiescence; these early results de-risk the sequence.

## Phase 2 — full producer denial + quiescence (2026-07-17T01:56Z → )

**§2.2 WAF denial — FULL, per owner decision (prod does NOT inherit staging's skip):**
- Rule `ws8-cutover-prod-api-deny` (`rule_ws8_cutover_prod_api_deny_gogW1I`): conditions
  `environment eq production` AND `path pre /api/` → **deny**. The environment condition deliberately inverts the
  runbook's usual warning: staging's custom env is preview-type, so `production`-only scoping *excludes* staging —
  exactly right for a cutover denial that must not touch the just-resumed staging. Denies every producer route in
  §2.2's list and every alias — the entire `/api/` surface — justified by zero production users.
- Staged by agent 01:56:31Z; **published by owner** (`vercel firewall publish --yes`, per the WAF runbook's
  owner-publishes rule); diff empty after.
- **Empirically proven 02:0xZ:** `GET /api/auth/signup-status` → **403** on all three prod hosts
  (repworth.net, www.repworth.net, rep-worth.vercel.app); staging → 302 (unaffected).

**§2.1/§2.3 producer flags (recorded pre-cutover state: both UNSET on prod):**
`SELF_SERVE_SIGNUP_ENABLED=false` (Railway + Vercel, verified by fresh read/pull),
`ZERNIO_RECENT_REVIEW_POLL_DISABLED=true` (Railway, verified). Resume state = restore to UNSET (behaviorally
identical to false under `readFlag`).

**§2.4 webhook:** no live webhook endpoint exists — nothing to disable. (Creating the prod endpoint + setting
`STRIPE_WEBHOOK_SECRET` is a post-merge launch task, recorded below.)

**§2.5–2.8 drain/samples:** production has **no queue infrastructure** — no `REDIS_URL`, no Redis service, no
worker deployment, no BullMQ consumers or producers have ever run. Queue counts are structurally zero, not
merely observed zero. Outbox:
- **Sample 1 — 2026-07-17T01:56:57Z:** in-flight (`pending|dispatching|dispatched`) = **0**; total rows = **0**.
- §3 formal parity re-run 02:01:20Z (in the sample gap): PASS, same line as the informal run.
- Sample 2: recorded below after the interval.

**§2.9 pause worker:** no worker process exists to pause; denials verified in force (above).

**Resume checklist for the next session, in order:**
1. Owner: Railway prod worker → set `STRIPE_SECRET_KEY` (live) + `DATABASE_POOL_URL`; Vercel production → set
   `STRIPE_SECRET_KEY`. Rotate `WORKER_INTERNAL_SECRET` while there.
2. Agent: create 6 live Prices (catalog table above) → set + verify price vars both platforms.
3. Agent: §2 WAF denial + quiescence evidence (trivially satisfiable — DB empty, no worker, no webhook — but
   record the samples properly).
4. Agent: §3 `verify:stripe-prices` PASS → §4 preflight `blockers=0` (stop if ANY allowlist is needed).
5. Owner: paste 077 into the SQL editor; agent verifies §5 gates.
6. Merge #469. Prod smoke needs Stripe activation (`charges_enabled=true`) for any real Checkout.

## Quiescence + formal gates + phase 5 (2026-07-17T02:09–02:17Z)

- **Sample 2 — 02:09:45Z:** outbox in-flight 0, total 0 (13 min after sample 1; §3 formal parity re-run PASS in
  the gap at 02:01:20Z). Final read at declaration: prod `/api` denial HTTP 403, both producer flags in force.
- **QUIESCENCE DECLARED 2026-07-17T02:10:04Z.**
- **§4 FORMAL: `WS8_PREFLIGHT_PASS blockers=0`** — zero allowlist (02:10:04Z).
- **Checkpoint 1 — 02:10:06Z:** Railway AND Vercel (fresh pull): `FOUNDING_DEADLINE=2027-01-01T00:00:00Z`,
  `AUTOPILOT_PURCHASABLE=false`. founding_deadline_verified_at_utc = autopilot_purchasable_verified_at_utc =
  2026-07-17T02:10:06Z.
- **§5 — migration 077 applied by OWNER via Supabase SQL editor** (baseline outbox=0 recorded 02:10:24Z;
  `price_variant` absent pre-apply = genuine first apply). Verified 02:17:11Z: incomplete_snapshot_count=0 ·
  invalid_business_mirror_count=0 · outbox_count_after_077=0=baseline · checkout_session_index_present=true ·
  checkout_lease_constraint_present=true · defaults copilot/list/2900/1500/1 · `accounts_price_variant_check`
  CHECK(list,founding) · trigger `accounts_price_variant_immutable` enabled.

>>> PRODUCTION IS NOW PAST THE 077 ROLLBACK BOUNDARY: roll forward only. <<<

**Post-merge launch tasks (not cutover blockers, recorded so they don't vanish):**
1. Stripe activation — `charges_enabled=false`; no live payment (incl. prod smoke checkout) until complete.
2. Create the live webhook endpoint → prod worker URL; set `STRIPE_WEBHOOK_SECRET` on Railway prod.
3. Provision prod worker infra (Redis service + `REDIS_URL`, `SENTRY_DSN`, Resend/Twilio/OpenAI/Anthropic keys,
   remaining boot-assert env) — the worker's first successful boot is expected to FAIL until these exist.
4. Prod phase 6 smoke (reuse `scripts/ws8-staging-smoke.ts`; scenario 7 creates ONE intrinsic orphan — decide
   pre-authorize vs skip), then 078 + resume (§7), removing `ws8-cutover-prod-api-deny` at resume.
