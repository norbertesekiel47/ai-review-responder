# Handoff — beta launch, the last four items

> **Written:** 2026-08-31 · **Owner:** @norbertesekiel
> **Supersedes** `2026-08-31-phase-e-handoff.md`, which covered Phases E–H.
>
> **This is a pointer, not a source of truth.** Every fact it cites lives in exactly one
> owning file. **If this file and an owning file disagree, the owning file wins** — and fix
> this one in the same change.

---

## The one-line situation

**Phases E, F.2 and G are complete.** Production is live, both remaining webhooks are
proven, the Beta comp coupon exists in both Stripe modes, provider moderation is on and
validated, and all four ops signals reach Discord. **Four items remain**, and the owner has
fixed their order: **F.3 → G.3 → the PITR drill → the secret rotation.**

Three of the four need a human at a browser. Only the rotation is mostly scriptable.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** D.1–D.10, Phase E, F.2, G.1/G.2/G.4, and findings E-F1…E-F5 and G-F1…G-F3 |
| 2 | `docs/runbooks/beta-production-standup.md` §§F–H | The protocol for what remains. **F.3's ten steps are the long pole** |
| 3 | `.claude/reference/lab-notes.md`, entries dated 2026-08-31 | Nine findings from this run. The Infisical one is a live security debt |
| 4 | `docs/runbooks/pitr-restore-drill.md` | The drill's own procedure. Its window closes at the first tester |
| 5 | `docs/launch-checklist.md` | The three hard blockers and the dated 2026-12-01 obligation |

The ordered plan, every phase and command:
**https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c**

## Where things stand

| Area | State |
|---|---|
| **Production API + worker** | ✅ Live since 2026-08-31T07:20:21Z. Worker runs `tsx worker/index.ts`, pollers cycling |
| **Migrations** | ✅ Full lockstep, head 116 |
| **Stripe live webhook** | ✅ Enabled, `api_version=2026-05-27.dahlia`. **Never yet delivered to** |
| **Resend webhook** | ✅ `3de61a3d-b4d5-416c-a0db-5d581d730a02`, proven — `email.delivered` → `processed` |
| **Zernio webhook** | ✅ `6a95315320358f33c89599e5`, proven — `webhook.test` → `processed` |
| **Beta comp coupon** | ✅ **`repworth-beta-comp-3mo` in BOTH Stripe modes.** `repeating`/3 verified against the pinned apiVersion |
| **`BETA_COMP_COUPON_ID`** | Vercel **staging only**. Absent from Vercel Production **and** from the vault — the F.4 gate |
| **Provider moderation** | ✅ `OPENAI_MODERATION_ENABLED=true` in prod, all three checks pass live |
| **Sentry monitors** | ✅ All three production monitors active. Cron heartbeat checking in |
| **Discord routing** | ✅ Rules `3920752` + `3925256`. Four signals → channel `1544045194264051842` |
| **Autonomy flags in prod** | `AUTO_APPROVAL_ENABLED` `AUTOPILOT_PURCHASABLE` `SELF_SERVE_SIGNUP_ENABLED` `TRIAL_ENABLED` all **`false`** |
| **Three secrets** | ⚠️ **EXPOSED, rotation owed.** See below |
| **Hard blockers** | PITR drill, legal review, insurance — **all 3 open** |

---

## Step 0 — land the open PR

**PR #1045** is green and carries the Phase G record. Merge it before making new changes,
then `git pull --ff-only`.

---

## The traps. Read before touching anything.

The first two are new from this run and both cost real time.

1. **`infisical secrets` prints secret VALUES by default.** Its own `--show-values` help
   claims masking is the default. It is not. This exposed three production secrets
   (below). **Never let that command write to a terminal you are recording.** To check a
   value, compare a SHA-256 fingerprint under `railway run`; to write one, use the CLI's
   `@file` form so the value is never a shell argument.

2. **A Railway `redeploy` MAY resolve deploy config — the rule is now conditional.** D.4
   proved a redeploy falls back to Railpack and boots `next start`. On 2026-08-31 a
   redeploy resolved config correctly and booted the worker, most likely because it copied
   a source deployment from minutes earlier. **You cannot tell which case you are in at the
   moment you flip a variable, so keep following the old rule:**
   ```bash
   railway deployment redeploy --from-source \
     --service repworth-worker --environment production \
     --project ad641d0e-dc01-4250-b71c-db1beedb9c8c --yes
   ```
   Confirm `tsx worker/index.ts` **and a poller cycle** in the boot log before moving on.

3. **"Online" on `repworth-worker` is not evidence.** The healthcheck is `/ready`, which
   only the worker serves — but read the worker's own logs, not the dashboard.

4. **`repworth-worker` is ONE service shared by staging AND production.** Railway's
   `update-service` updates **all** environments when `environmentId` is omitted.

5. **The production Redis service is named `Redis`, capital R.**

6. **`psql` rejects the pooler URL** (`?pgbouncer=true`). Strip it, or use the Supabase MCP.

7. **The Infisical CLI cannot delete a secret.** Web UI only. Project
   `1735b0d0-286e-4ca3-a53b-f3a7191b163c`, env slug **`prod`** (not `production`).

8. **A zero-length `vercel env pull` value means `Secret` type, not empty.** Reading it as
   "off" is the F8 mistake. The `type` column needs `npx vercel@latest` — the installed
   54.14.5 has no such column.

9. **An in-process fault injection can silently test nothing.** The OpenAI client is
   memoized; setting a bad key mid-process returned a *clean* result that looked like a
   pass. Inject faults before the process starts.

10. **Webhook subscriptions are per-USER at Resend and Zernio, not per-environment.** Every
    event fans out to both workers. Benign by construction. **Never re-point an endpoint.**

---

## 1. F.3 — the ten-step staging smoke. **Start here.**

Standup §Phase F. This is operator work: admin sign-in at AAL2, an invite email, a Stripe
test card, and eyes on the Stripe dashboard.

**Preparation is already done and verified:**

- Migrations 105 + 106 confirmed on staging **by introspection**, not the ledger.
- `ONBOARDING_DEMO_ENABLED=true` on all four surfaces. No flip needed.
- `BETA_COMP_COUPON_ID=repworth-beta-comp-3mo` set on Vercel staging; the running staging
  deployment carries it.
- **Trial/coupon collision ruled out** — `isTrialEligible` requires `onboarded_by IS NULL`,
  and an **Admin invite** never has that. So step 5's "$0 due today" can only be the coupon.

**Two things the operator must supply:** the `ONBOARDING_DEMO_ENABLED` posture to record
(it is `true`, so expect `/onboarding/start`), and **two** owner email addresses — step 10
needs a second owner who has not signed in.

**Three steps carry the weight:**

- **Step 6 — a card IS collected.** The `payment_method_collection: 'always'` assertion.
  Without it, month 4 fails.
- **Step 8 — the 4th cycle is full price.** The single assertion proving
  `duration_in_months: 3` behaved. Do not skip it.
- **Step 10 — record the real Supabase error code** for the already-accepted case.
  `src/lib/onboarding/resend-invite.ts` shipped staging-unverified.

**Then F.4 — production.** Set `BETA_COMP_COUPON_ID` to the live-mode id on **Vercel
Production** and re-run the smoke with a real card and an immediate cancel.

> **This is where the D.6 debt lands.** No Checkout has ever completed in live mode. Walk
> the production Checkout **before** tester one, or the first live Checkout is a customer's.

## 2. G.3 — mutating acceptance drills, **STAGING ONLY**

`beta-launch-alerting.md` §4. Production gets safe synthetic canaries only — never failure
injection, worker stops, or cost-cap exhaustion against the live stack.

Now worth doing properly, because the alerting it exercises actually works: all three
production monitors are live and all four signals route to Discord.

## 3. The PITR restore drill — **the highest risk reduction per hour**

`docs/runbooks/pitr-restore-drill.md`. Its results table still reads *pending first drill*.

**The runbook wants it run before real customer data exists.** Production still holds
**zero accounts, zero businesses, zero users** — Phase E added two `inbound_events` rows and
nothing else. **That window closes the moment tester one signs up.**

A clone-to-new-project drill, roughly an hour. Creating a Supabase project costs money, so
confirm the spend before starting.

## 4. The secret rotation — owed, and dated

Three production secrets reached a session transcript via trap 1:

| Key | What the value permits | Runbook |
|---|---|---|
| `RESEND_API_KEY` | Send mail as `notifications@repworth.net`; alter webhook config | `secrets-rotation-email-and-messaging.md` |
| `ZERNIO_API_KEY` | Read profiles; post replies for any connected Google account | `secrets-rotation-zernio.md` |
| `ZERNIO_WEBHOOK_SECRET` | Forge `review.*` / `account.*` events into production ingress | `secrets-rotation-zernio.md` |

**Blast radius today is near zero** — no connected Google Business Profile, so a forged
`review.new` fans out to zero rows. **It stops being zero at the first connected location.**

**Rotating `ZERNIO_WEBHOOK_SECRET` must `PUT` subscription `6a95315320358f33c89599e5`'s
`secret` in the same change.** The vault value and the Zernio subscription move together or
ingest breaks.

The owner deliberately ordered this last, after F.3, so one rotation covers everything.

---

## Owed, and not blocking

| Item | Why it is not done | Order when you do it |
|---|---|---|
| **`PAST_REPLIES_VIEW_ENABLED` deletion** | In the vault, so deleting from Vercel alone returns on the next sync. CLI cannot delete. Read by no code; `true` on all four surfaces | **Vault (web UI) first, then Vercel** |
| **The three `--sensitive` Vercel vars** | **This became a DECISION, not an action.** G5-F1 proved the Infisical sync does not preserve Vercel's Sensitive flag — Production went 9 `Secret` → 4, and the 4 survivors are exactly the 4 the vault does not manage. Re-adding them drifts back to `Config` on the next write | Decide first: accept `Config`, drop them from the vault, or find a sync option that sets the type |
| **IaC migration, due 2026-12-01** | Railway deprecated Config as Code. The service mirror already removes the single point of failure. **`railway config migrate` output is unsafe as generated** — it names the service `RepWorth` (creating a SECOND service) and drops both restart-policy fields | Its own PR, with a reviewed `railway config plan` |
| **Restore the light healthcheck** | `/ready` runs three live probes. Cost is bounded — deploy-time only, 300 s window, failure leaves the running deployment up | A boot-surface change; its own PR |
| **Split the import-consent alert** | G.1 shipped **one** rule with `any` logic covering all four signals. `subsystem:import_consent_analytics` is meant to be frequency-conditioned but shares the "notify on every trigger" throttle | Only if it proves noisy. Do not throttle all four |
| **Drop the "issue resolved" trigger** | Both Discord rules keep Sentry's default trigger set, so resolving an issue posts to Discord | Cosmetic; only if it grates |

## The three open hard blockers

PITR restore drill, lawyer review, insurance binding. **Never tick an incomplete box.**

Two of them cannot finish quickly. That makes proceeding an explicit, recorded owner
decision — add a dated block to `docs/launch-checklist.md` under the hard-blocker section
saying what you decided and why. **A recorded exception is a decision. An unticked box that
everyone stopped looking at is not.**

## What changed about the shape of this work

Phase D ended the freeze, so a mistake is now live rather than eaten by a firewall. Phase G
closed the other half of that: **the alarms work now.** All three production monitors are
active and four signals reach a Discord channel someone reads. The remaining work is no
longer "build the safety net" — it is "walk the paths no one has walked", starting with a
Checkout that has never completed in live mode.
