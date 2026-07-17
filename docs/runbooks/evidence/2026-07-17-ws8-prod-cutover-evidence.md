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

**Resume checklist for the next session, in order:**
1. Owner: Railway prod worker → set `STRIPE_SECRET_KEY` (live) + `DATABASE_POOL_URL`; Vercel production → set
   `STRIPE_SECRET_KEY`. Rotate `WORKER_INTERNAL_SECRET` while there.
2. Agent: create 6 live Prices (catalog table above) → set + verify price vars both platforms.
3. Agent: §2 WAF denial + quiescence evidence (trivially satisfiable — DB empty, no worker, no webhook — but
   record the samples properly).
4. Agent: §3 `verify:stripe-prices` PASS → §4 preflight `blockers=0` (stop if ANY allowlist is needed).
5. Owner: paste 077 into the SQL editor; agent verifies §5 gates.
6. Merge #469. Prod smoke needs Stripe activation (`charges_enabled=true`) for any real Checkout.
