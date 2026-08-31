# Handoff — WS8 production cutover resume

> **Updated:** 2026-08-30 (Phase I closed) · **Owner:** @norbertesekiel
> **Status:** Phases 0, I, A, B and C closed. **Phase D next** — the WS8 cutover itself.
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
| Secret Syncs | ✅ **Both live, `Overwrite` + deletion disabled.** The Vercel one first ran as `Import` and had to be repaired — evidence file, "Phase I sync 1" |
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

1. **REVERSED 2026-08-31 — use `Overwrite`, never `Import`.** This trap previously said the
   opposite. It was wrong, and following it caused a live incident. **Infisical's `Import`
   copies destination secrets INTO the vault** ("Imports secrets from the destination
   endpoint before syncing"). It pulled 14 names from Vercel into `prod`, five of them
   **empty** because Vercel *Sensitive* variables are write-only — then wrote those empties
   back and destroyed four production values. `Overwrite` + **Disable Secret Deletion**
   cancel exactly: the toggle forbids the only destructive act, so nothing is deleted and
   nothing is imported. That protects the seven legacy `STRIPE_PRICE_*` names better than
   `Import` did. Full reasoning: `infisical-production-manifest.md` §14; the incident:
   evidence file, "Phase I sync 1".

   **`Initial Sync Behavior` is its own wizard step — step 4, "How to resolve the first
   run" — not part of Sync Options.** It has a default already selected. Clicking past it is
   exactly how the incident happened.

   **A `vercel env pull` is NOT a backup.** It writes the literal string `"[SENSITIVE]"` for
   every Sensitive variable. Confirm such a value exists elsewhere before overwriting it.
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

## Next action — Phase D

Phases A, B and C are closed. **B and C completed as a side effect of the two syncs.**

**17 of the 18 unconditional worker boot gates are green.** The one missing is
`STRIPE_WEBHOOK_SECRET`, which D.3 produces. The Zernio conditional gate is satisfied in
full, and every exact-boolean gate is correct.

Two small items owed first, neither blocking:

- **Redeploy Vercel.** `NEXT_PUBLIC_APP_URL` is correct in the store, but `NEXT_PUBLIC_*` is
  inlined at build time, so no browser sees it yet.
- **Delete `PAST_REPLIES_VIEW_ENABLED` from Vercel** — read by no code (manifest §7.10).

Then Phase D, resuming the WS8 runbook at **§6**:

1. **D.1** verify the six live Prices; **D.2** verify migration 077. Both verify-only.
2. **D.3** create the live Stripe webhook endpoint at
   `https://worker.repworth.net/ingress/stripe`, disabled, and put its signing secret in the
   vault as `STRIPE_WEBHOOK_SECRET`. Watch the Sandbox trap — confirm it appears in the
   **live** dashboard.
3. **§6** the worker boots for the first time. Until D.3 it crash-loops on that one gate by
   design; **do not raise `restartPolicyMaxRetries`**.
4. **§7** apply migration 078, remove `ws8-cutover-prod-api-deny`, restore
   `ZERNIO_RECENT_REVIEW_POLL_DISABLED` to unset.
5. **§8** verify migration 105.

Owed after §8 closes: re-add `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET` and
`WORKER_INTERNAL_SECRET` to Vercel with `--sensitive`. They are `Config` today so that
Vercel can be verified against the vault by readback — the check that caught the sync-1
incident. Note that a synced key drifts back to `Config` on every write, so this is a
post-cutover step, not a permanent state.

## The moment that matters

The first time `curl https://repworth.net/api/health` returns **200** is the moment
production stops being fenced off. It is Phase D.8, three phases away. Everything before it
is preparation.
