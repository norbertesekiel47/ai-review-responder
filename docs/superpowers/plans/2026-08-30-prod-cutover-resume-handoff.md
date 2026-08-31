# Handoff — WS8 production cutover resume

> **Created:** 2026-08-30 · **Owner:** @norbertesekiel · **Status:** Phase 0 closed,
> Phase I next · `main` @ `d2cb94e3`
>
> **This document is a pointer, not a source of truth.** It says where you are, what to
> read, and what to do next. Every fact it references lives in exactly one owning file,
> named below. If this file and an owning file disagree, **the owning file wins** — and fix
> this one.

---

## The one-line situation

Production is **not un-launched**. It has been **frozen mid-WS8-cutover since 2026-07-17**,
with a Vercel firewall rule denying every `/api/*` request. Phase 0 preflight is now closed
and verified. The next work is standing up secrets in Infisical, then resuming the cutover
at **§6**.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** Roles, zero-state proof, migration state, owner decisions, verified Stripe readings, phase log for §§6–8. Start here. |
| 2 | `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md` | The predecessor run. **Read it to the END** — the 077 apply is at the bottom, and reading only partway is what caused a month of contradictory docs. |
| 3 | `docs/runbooks/ws8-tier-cutover.md` §§5–8 | The cutover protocol. §§1, 5, 8 are **verify-only** in prod; §§2–4 are satisfied by the zero-state proof. |
| 4 | `docs/runbooks/beta-production-standup.md` | Phase structure A–H. Its Phase B boot-gate list is wrong — read the manifest at row 6 instead. |
| 5 | `docs/launch-checklist.md` | Gates and hard blockers. |
| 6 | `docs/runbooks/infisical-production-manifest.md` | **The Phase I input.** Every variable, its gate, its platform, its value source, and what stays out. Derived from code, so it supersedes trap #2 below and the stand-up's Phase B list. |

Ops mechanics live in `docs/runbooks/deployment-guide.md`. Do not duplicate them.

## Where things stand

| Area | State |
|---|---|
| Phase 0 preflight | ✅ **Closed 2026-08-30.** PRs #1025, #1026, #1027 merged |
| Prod database | Zero-state — 52/52 `public` tables empty, `auth.users`=0. Quiescence declared 22:30:03Z |
| Migrations | Head **116, minus 078**. 077 applied 2026-07-17T02:17:11Z; 105/106/116 applied |
| Stripe live | ✅ `charges_enabled=True`, `payouts_enabled=True`, `details_submitted=True`. **0** live webhook endpoints. **6** active livemode Prices |
| Railway prod worker | **0 deployments ever.** 27 vars; 6 hard boot gates missing. No GitHub source connected on the prod env |
| Railway prod Redis | **Does not exist** — the service is in `staging` only |
| Upstash prod cache | Does not exist |
| Sentry prod project | Does not exist |
| Vercel prod | Live at repworth.net. `NEXT_PUBLIC_APP_URL` is **wrong** (see Traps) |
| **WAF** | `ws8-cutover-prod-api-deny` **still Enabled** — every prod `/api/*` returns 403 |
| Infisical | `RepWorth` project created; CLI v0.43.128 logged in. Environments not yet created |
| `alerts@repworth.net` | ✅ Zoho group, 5 members, inbound-only |
| Beta comp coupon | Does not exist in either Stripe mode |
| Hard blockers | PITR drill, legal review, insurance — all 3 open |

## Locked decisions — do not relitigate

1. **Solo run.** Cutover owner, observer and incident owner are one person, recorded as an
   owner-approved deviation with the 2026-07-16 precedent. Not a blank field.
2. **Secret management: Infisical Secret Sync**, not `infisical run` runtime injection.
   Vercel has no build-time agent, and injection would put Infisical in the boot path of a
   single-replica worker. The CLI is **optional** for this approach.
3. **Alert sink: Discord.** Zoho Cliq was checked and rejected — Sentry has no Cliq
   integration, and Cliq's incoming webhook needs a translator service, which would put a
   silently-failable component on the paging path.
4. **`ADMIN_NOTIFICATION_EMAIL` = `alerts@repworth.net`**, a group rather than an alias, so
   it outlives any one founder.
5. **Beta posture unchanged** — `AUTO_APPROVAL_ENABLED=false`, `AUTOPILOT_PURCHASABLE=false`,
   `SELF_SERVE_SIGNUP_ENABLED=false`. Beta lands on Copilot (ADR 0005).

## Traps that will cost you hours

1. **`NEXT_PUBLIC_APP_URL` is wrong in Vercel production.** It reads
   `https://rep-worth.vercel.app/` — wrong host, trailing slash. Correct value is
   `https://repworth.net`, no slash. `assertSameOrigin` (`src/lib/shared/csrf.ts:35`)
   compares URL origins, so **21 routes** fail on it — login-attempt, reset-password,
   finish-signup, onboarding/select-plan among them. `plan-activation.ts:323` also
   concatenates it raw, so the slash double-slashes every generated link. Fix in Phase C.
2. **The stand-up runbook's boot-gate list is wrong in five places.** Owner of the correct
   list: `docs/runbooks/infisical-production-manifest.md` §7, derived from code at
   `f6695494`. It names three variables as boot-gated that are not — `SERPAPI_API_KEY`,
   `DATABASE_URL`, `REDIS_CACHE_URL` — and omits two that are: `SESSION_COOKIE_SECRET`
   (≥32 bytes) and `NEXT_PUBLIC_APP_URL`, both hard gates via
   `assertUnsubscribeIngressConfigured` (`worker/index.ts:596`). A gate you did not plan
   for is a crash loop that exhausts `restartPolicyMaxRetries = 10` and stays down.
3. **The local Stripe CLI 401s on live** while the same login's test key works. Most likely
   the browser authorized a **Sandbox**. Not a blocker — use
   `railway run --environment production --service repworth-worker -- <cmd>`, the pattern
   from the 2026-07-17 record, so the live key is used but never observed. **But** a
   Sandbox-defaulted session can create the D.3 webhook endpoint in the wrong context, where
   it looks created and delivers nothing. Confirm it in the live dashboard.
4. **Vercel does not redeploy on an env change.** After Phase C and after every Infisical
   sync, redeploy — `NEXT_PUBLIC_*` is baked into the client bundle at build time.
5. **Sync Infisical only once it is complete, and do NOT switch to Overwrite.** Railway
   restarts on a variable change, so a partial sync is a boot-gate crash loop. Start both
   syncs as **Import (Infisical priority)** and leave them there. Overwrite deletes every
   destination variable Infisical does not manage — which includes the seven legacy
   `STRIPE_PRICE_*` names the WS8 rollback window depends on, and `DB_POOL_MAX`. Enable
   **Disable Secret Deletion** on **both** syncs, not only Railway's. Manifest §8, §9.1.
6. **Keep `REDIS_QUEUE_URL` Railway-native** — its value is a Railway reference expression.
   Enable "Disable Secret Deletion" on that sync so it cannot remove `RAILWAY_*`.
7. **`DB_POOL_MAX` cannot live in Infisical.** Its correct value is `20` on Railway and `3`
   on Vercel, and one key in one environment cannot hold both. Keep it native on each
   platform. Manifest §9.1 — this is the one Phase I design problem the plan does not cover.
8. **`ZERNIO_API_KEY` is required on Vercel and appears in no Phase C list.** The Next
   connect routes call `zernioClient` under the ADR 0001 exception; without it every
   onboarding connect call sends `Bearer ` and 401s, with nothing in the boot log.
   Manifest §7.7.
9. **`?family=0` on the queue URL is mandatory.** Railway's private network is IPv6-only;
   without it every BullMQ connection fails with `ENOTFOUND *.railway.internal` while the
   worker still reports healthy.

## Next action — Phase I

1. Create `production` and `staging` environments in the Infisical `RepWorth` project. Do
   **not** create `development`.
2. Populate `production` by hand, **minting fresh secrets as you go**. This doubles as the
   rotation owed for values exposed in a transcript on 2026-08-30 (`SUPABASE_SERVICE_KEY`,
   `STRIPE_SECRET_KEY`, both DB passwords, `WORKER_INTERNAL_SECRET`). Do not import from
   Vercel — it imports sensitive values as **empty**.
3. Two App Connections, two Secret Syncs — Vercel Production, and Railway
   `production`/`repworth-worker`. Name the service, or it writes environment-level shared
   variables instead.
4. Then Phase A (provision), B+C (variables), D (WS8 §6/§7 — the deploy, 078, and lifting
   the deny rule).

The full ordered plan with every phase, table and command:
**https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c**

## The moment that matters

Slot 5 of the plan. The first time `curl https://repworth.net/api/health` returns **200** is
the moment production stops being fenced off. Everything before it is preparation.
