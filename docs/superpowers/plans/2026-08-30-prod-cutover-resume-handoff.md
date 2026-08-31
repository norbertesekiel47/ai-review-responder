# Handoff — WS8 production cutover resume

> **Updated:** 2026-08-30 (Phase I closed) · **Owner:** @norbertesekiel
> **Status:** Phase 0 and Phase I closed, **Phase A next** · `main` @ `007cb544`
>
> **This document is a pointer, not a source of truth.** It says where you are, what to
> read, and what to do next. Every fact it references lives in exactly one owning file,
> named below. If this file and an owning file disagree, **the owning file wins** — and fix
> this one.

---

## The one-line situation

Production is **not un-launched**. It has been **frozen mid-WS8-cutover since 2026-07-17**,
with a Vercel firewall rule denying every `/api/*` request. Preflight is closed and every
production secret now lives in Infisical. The next work is **provisioning the four things
that do not exist**, then the syncs, then resuming the cutover at **§6**.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/infisical-production-manifest.md` | **Start here.** Every variable, its gate, its platform, its value source. §11 is the live two-platform state; §12 is the Phase I record and what is still owed. Derived from code, so it supersedes the stand-up's Phase B list. |
| 2 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** Roles, zero-state proof, migration state, owner decisions, the phase log for §§6–8. |
| 3 | `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md` | The predecessor run. **Read it to the END** — the 077 apply is at the bottom, and reading only partway caused a month of contradictory docs. |
| 4 | `docs/runbooks/ws8-tier-cutover.md` §§5–8 | The cutover protocol. §§1, 5, 8 are **verify-only** in prod; §§2–4 are satisfied by the zero-state proof. |
| 5 | `docs/runbooks/beta-production-standup.md` | Phase structure A–H. **Its Phase B boot-gate list is wrong in five places** — use the manifest instead. |
| 6 | `docs/launch-checklist.md` | Gates and hard blockers. |

Ops mechanics live in `docs/runbooks/deployment-guide.md`. Do not duplicate them.

The ordered plan, with every phase and command:
**https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c**

## Where things stand

| Area | State |
|---|---|
| Phase 0 preflight | ✅ Closed. PRs #1025–#1027 merged |
| **Phase I — Infisical** | ✅ **Closed.** `prod` holds **43 keys**, verified byte-for-byte, 0 empty. Manifest §12 |
| Credential rotation (F4) | ✅ Closed — 5 minted, 3 rotated at their provider |
| Secret Syncs | ❌ **Deliberately not configured.** Blocked on Phase A |
| Prod database | Zero-state — 52/52 `public` tables empty, `auth.users`=0. Quiescence declared 22:30:03Z |
| Migrations | Head **116, minus 078**. 077 applied 2026-07-17T02:17:11Z |
| Stripe live | `charges_enabled=True`. **0** live webhook endpoints. **6** active livemode Prices |
| Railway prod worker | **0 deployments ever.** 27 vars. **No GitHub source connected** |
| Railway prod Redis | **Does not exist** — the service is in `staging` only |
| Upstash prod cache | Does not exist |
| Sentry prod project | **Does not exist.** Org is `repworth-nv`; only `repworth-staging` exists |
| Vercel prod | Live at repworth.net. 34 vars, **9 of them empty** |
| **WAF** | `ws8-cutover-prod-api-deny` **still Enabled** — every prod `/api/*` returns 403 |
| `alerts@repworth.net` | ✅ Zoho group, 5 members |
| `notifications@` / `unsubscribe@` | ✅ Zoho groups, created for Phase I |
| Beta comp coupon | Does not exist in either Stripe mode |
| Hard blockers | PITR drill, legal review, insurance — all 3 open |

## Locked decisions — do not relitigate

1. **Solo run.** Cutover owner, observer and incident owner are one person, an
   owner-approved deviation with the 2026-07-16 precedent.
2. **Infisical Secret Sync**, not `infisical run` injection. Vercel has no build-time agent,
   and injection would put Infisical in a single-replica worker's boot path.
3. **One Infisical environment, union spread accepted.** A key set syncs whole to both
   platforms. Single-platform secrets land on the platform that ignores them. Owner
   decision, 2026-08-30. Manifest §9.1.
4. **Alert sink: Discord.** Zoho Cliq checked and rejected — no Sentry integration, and a
   translator service would put a silently-failable component on the paging path.
5. **`ADMIN_NOTIFICATION_EMAIL` = `alerts@repworth.net`**, a group not an alias.
6. **Supabase moved to a new-format `sb_secret_` key.** Variable name unchanged. Manifest §12.2.
7. **Beta posture** — `AUTO_APPROVAL_ENABLED=false`, `AUTOPILOT_PURCHASABLE=false`,
   `SELF_SERVE_SIGNUP_ENABLED=false`, `TRIAL_ENABLED=false`. Beta lands on Copilot (ADR 0005).

## Traps that will cost you hours

1. **Do NOT switch either Secret Sync to Overwrite.** It deletes every destination variable
   Infisical does not manage — including the seven legacy `STRIPE_PRICE_*` names the WS8
   rollback window depends on, and `DB_POOL_MAX`. `RETAINED_STRIPE_PRICE_HISTORY` is an
   empty array, so nothing in code preserves those IDs. Import only; **Disable Secret
   Deletion on both syncs**.
2. **Do NOT run either sync until Phase A is done.** Four values are still missing and three
   are boot gates. Railway restarts on a variable change, so a partial sync is a crash loop
   that exhausts `restartPolicyMaxRetries = 10` and stays down.
3. **The Infisical environment slug is `prod`, not `production`.** `--env production` errors.
   A sync aimed at a non-existent slug writes nothing.
4. **`DB_POOL_MAX` cannot live in Infisical.** `20` on Railway, `3` on Vercel. Vercel's is
   **empty** today and `readPoolMax()` falls back to **10**, not 3. Keep it native; fix
   Vercel's in Phase C.
5. **`NEXT_PUBLIC_APP_URL` is wrong in Vercel production** — `https://rep-worth.vercel.app/`.
   The correct value is already in Infisical. `assertSameOrigin` fails on 21 routes and the
   trailing slash double-slashes every generated link.
6. **`ZERNIO_API_KEY` is required on Vercel** and appears in no Phase C list. Without it
   every onboarding connect call sends `Bearer ` and 401s, with nothing in the boot log.
7. **The stand-up's boot-gate list is wrong in five places.** It calls `SERPAPI_API_KEY`,
   `DATABASE_URL` and `REDIS_CACHE_URL` boot-gated (none are) and omits
   `SESSION_COOKIE_SECRET` and `NEXT_PUBLIC_APP_URL` (both are). Manifest §7.
8. **Vercel does not redeploy on an env change.** After Phase C and after every sync,
   redeploy — `NEXT_PUBLIC_*` is inlined at build time.
9. **`?family=0` on the queue URL is mandatory.** Railway's private network is IPv6-only;
   without it every BullMQ connection fails with `ENOTFOUND *.railway.internal` while the
   worker still reports healthy.
10. **The local Stripe CLI 401s on live.** Likely a Sandbox-bound browser authorization. Use
    `railway run --environment production --service repworth-worker -- <cmd>`. A
    Sandbox-defaulted session can create the D.3 webhook endpoint in the wrong context, where
    it looks created and delivers nothing.
11. **The Infisical CLI cannot delete a secret** at v0.43.128 — it 404s on a secret the read
    returns. Use the web UI. Manifest §12.7.

## Next action — Phase A, then the syncs

**Phase A — provision what does not exist.** Four of the six steps produce values Infisical
is still missing.

1. **A.1** Sentry project `repworth-production` in org **`repworth-nv`**, platform Next.js.
   Its DSN becomes `SENTRY_DSN` **and** `NEXT_PUBLIC_SENTRY_DSN`. Never reuse the staging
   DSN. `SENTRY_ORG` and `SENTRY_PROJECT` are already in Infisical.
2. **A.2** Railway Redis in the `production` environment. Delete the auto-created TCP proxy.
   Set `REDIS_QUEUE_URL` as a **Railway-native** reference expression with `?family=0`.
3. **A.3** Production Upstash cache → `REDIS_CACHE_URL`, the one value that must match
   across both platforms.
4. **A.4** Worker public domain → `WORKER_PUBLIC_URL`. **Origin-only https, no trailing
   slash** — `assertWorkerPublicUrlFormat` checks `raw === new URL(raw).origin`.
5. **A.5** Connect the GitHub source to the production Railway service and set the deploy
   branch to `main`. It has none today, so Phase D has nothing to deploy.
6. **A.6** Confirm live provider access with **hard provider-side spend caps**, and curl each
   key once before trusting it.

**Then** add the four new values to Infisical `prod`, configure the two syncs (Import,
deletion disabled, service named), and move to B+C.

Three items also owed, none blocking Phase A:

- Check `STRIPE_SECRET_KEY` in the Vercel dashboard — genuinely empty, or Sensitive? If
  empty, production Checkout has been broken since it was set. Manifest §11.
- Prove the new Supabase secret key with one `auth.admin` call on staging. Manifest §12.2.
- Land the five doc corrections the evidence file lists as owed.

## The moment that matters

The first time `curl https://repworth.net/api/health` returns **200** is the moment
production stops being fenced off. It is Phase D.8, three phases away. Everything before it
is preparation.
