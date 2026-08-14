# Rollback Runbook

How to undo a bad production deploy fast and safely. RepWorth is two deploys —
**web** (Next.js on Vercel) and **worker** (Fastify + BullMQ on Railway) —
decoupled by the transactional outbox in Postgres. This runbook orchestrates the
existing runbooks; it does not duplicate them. For severity definitions and what
to watch, see `observability.md`; for the Zernio publishing kill-switch, see
`deployment-guide.md §10.5`.

---

## Roll back vs. roll forward

| Situation | Action |
|---|---|
| Bad code just shipped, last-known-good deploy exists | **Roll back** the affected service (fastest; no rebuild). |
| Bad behavior is gated by a flag | **Flip the flag** off (faster than a deploy). |
| Data is being corrupted or money is moving wrong | Flag-off / kill-switch **first**, then roll back, then assess data. |
| Bug is small, fix is obvious and safe | **Roll forward** with a hotfix PR. |
| A migration is the problem | Never down-migrate prod — see §5. |

Default bias: **stop the bleeding with a flag, then roll back, then fix forward.**
Pick a severity with `observability.md` before acting (P0 = drop everything).

---

## 1. Feature-flag rollback (fastest — often no redeploy)

Feature flags are **server-authoritative** (CLAUDE.md invariant 13): the browser
learns flag state from API responses, so flipping a server env var is the whole
rollback. Set the flag in the platform that owns the surface, then restart that
service:

- Worker-side behavior (publishing, channels) → set in **Railway**.
- Web-side behavior (signup, public surfaces) → set in **Vercel**.

Common flips:

| Flag | Effect when off |
|---|---|
| `ZERNIO_PUBLISHING_ENABLED=false` | Worker stops calling Zernio; ingress returns 503; already-posted replies stay posted. The Zernio kill-switch — see `deployment-guide.md §10.5`. |
| `SELF_SERVE_SIGNUP_ENABLED=false` | **Anonymous account-minting closes** — `/signup` + its sub-pages 404 and the signup APIs refuse. Everything else keeps working. **(Re-scoped 2026-08-14 — this is a genuine improvement worth knowing during an incident.)** Flipping it off no longer locks anyone out of `/login`, `/forgot-password` or `/reset-password`, which are always-on, and it does not close the authenticated onboarding funnel: an admin-invited owner mid-funnel can still log in, recover a password, capture their location, see the demo, check out, and finish the wizard. Admin onboarding still works. Blast radius is now exactly "no new strangers", where it used to also mean "existing invitees are locked out of login and password recovery". |
| `BETA_COMP_COUPON_ID` unset | The beta comp stops attaching to **new** Checkout attempts (they snapshot `NULL` and render at full price). **Already-snapshotted attempts keep their comp** — that is the per-attempt Stripe idempotency contract, not a leak. Use this if the wrong coupon ID was deployed; pair it with a code rollback only if the coupon *emission* is what broke. |
| `OPENAI_MODERATION_ENABLED=false` | OpenAI moderation layer off; local regex rules still run (they always run). Drafts are still held on local high-severity flags. |

Flags are not data fixes: anything already written stays written. Combine with a
roll back if the bad behavior also shipped in code.

---

## 2. Vercel (web) rollback

Vercel keeps every previous production deployment; promoting one is near-instant
(no rebuild).

1. Vercel dashboard → project → **Deployments**.
2. Find the last-known-good **Production** deployment (green, pre-incident).
3. **⋯ → Promote to Production** (a.k.a. Instant Rollback). CLI equivalent:
   `vercel promote <deployment-url>`.
4. Confirm: `curl -I "$NEXT_PUBLIC_APP_URL/"` → 200 + security headers; visit
   `/admin/login`.

Notes:
- Env vars are read live, not snapshotted — a rollback to older code with newer
  env vars set is fine (unused vars are harmless).
- Security headers come from `next.config.mjs`, so they travel with the code.

---

## 3. Railway (worker) rollback

1. Railway dashboard → `repworth-worker` service → **Deployments**.
2. Select the last-known-good deployment → **Redeploy** (rolls back to that build).
3. The worker reboots; Railway probes `healthcheckPath = /api/health` (see
   `railway.toml`) — 200 = ready before traffic shifts.
4. Confirm: worker `GET /api/health` → 200 `{service:"worker"}`; `/admin/jobs`
   queues draining.

Notes:
- `PORT` is injected by Railway and read by Fastify — nothing to set on rollback.
- The health endpoint is dependency-light, so a healthy worker reports ready even
  if a downstream (Redis/Postgres) is briefly slow.

> **Boot prerequisite — set before deploying.** The worker asserts required env
> at boot and `process.exit(1)`s if any are missing in production
> (`worker/config/startup-assert.ts`). Because `railway.toml` caps restarts at
> `restartPolicyMaxRetries = 10`, a *missing* var is a deterministic failure that
> Railway will **not** self-heal — the service exhausts its restarts and stays
> down, and the outbox stops draining. Confirm these are set in Railway **before**
> a deploy or rollback that ships this code:
> - `ADMIN_NOTIFICATION_EMAIL` — recipient for admin exception/failover/engagement
>   alerts (hard-required in prod).
> - Any channel/Stripe/self-serve var whose feature flag is ON (see
>   `worker/config/startup-assert.ts` and `.claude/reference/env-vars.md`).
> A missing *optional* var (`LIST_UNSUBSCRIBE_EMAIL`, `SENTRY_DSN`) only warns and
> does not block boot.

---

## 4. Database — forward-only, expand/contract

Migrations are **forward-only**, numbered SQL applied by number (head: 053). There
are **no down-migrations**, and you do **not** run one in production.

To recover from a bad migration:

1. **Roll back the code, not the schema.** The schema should be designed
   expand/contract so older code still works against the migrated schema
   (additive first; destructive changes come in a later migration). If the code
   is compatible, a code roll back (§2/§3) is the whole fix.
2. **If the migration itself is wrong**, write a **compensating forward
   migration** (next number) that corrects it. Never edit an applied migration.
3. **For bad data**, fix with a single explicit `BEGIN … COMMIT` transaction;
   account-status changes go through `writeAccountAuditLog` in the same tx
   (CLAUDE.md). Re-validate predicates with `SELECT … FOR UPDATE` before mutating.
4. **For catastrophic data loss**, restore from Supabase backups / PITR — full
   procedure (the safe clone-to-new-project drill vs. the destructive in-place
   restore, plus integrity checks) in **`pitr-restore-drill.md`**. Never run an
   in-place restore as a *test*: it rewinds and downs the named project — drill
   via *Restore to a New Project* instead.

Rule of thumb: a code rollback must never require a schema rollback. If it does,
the migration wasn't expand/contract — fix forward.

---

## 5. Web ↔ worker version skew

The two services deploy independently and are decoupled by the **transactional
outbox** (state change + follow-up work in one Postgres tx). You can roll back one
without the other as long as the **outbox payload shape and DB schema stay
compatible** — which the expand/contract rule (§4) guarantees.

- Roll back only the broken service first; the other keeps draining the outbox.
- Watch `/admin/jobs`: rising outbox `failed` after a rollback means a
  payload/schema mismatch — roll the *other* service to its matching deployment.
- When in doubt, roll both web and worker back to the deployments from the same
  known-good commit.

---

## 6. Post-rollback verification

Run the `observability.md` synthetic checks, plus:

1. Web `GET /api/health` → 200 `{service:"web"}`; worker `GET /api/health` → 200
   `{service:"worker"}`.
2. `/admin/jobs`: outbox `failed`/`pending` flat or falling; no queue runaway.
3. Sentry: no new error class spiking post-rollback.
4. Exercise one real path (login, and one webhook ingress) per
   `observability.md` synthetic list.

---

## Guardrails

- **Never bypass the approval step** to "unblock" posting (CLAUDE.md invariant 3).
- **Never disable moderation** to clear a flagged backlog.
- **Prefer pausing a queue** over deleting jobs.
- **Never down-migrate prod** or edit an applied migration — fix forward (§4).
