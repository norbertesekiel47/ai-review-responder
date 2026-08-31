# Handoff — beta launch, the last four items

> **Written:** 2026-08-31 · **Owner:** @norbertesekiel
> **Supersedes** `2026-08-31-phase-e-handoff.md`, which covered Phases E–H.
>
> **This is a pointer, not a source of truth.** Every fact it cites lives in exactly one
> owning file. **If this file and an owning file disagree, the owning file wins** — and fix
> this one in the same change.

---

## The one-line situation

**Phases E, F.2, G and now F.3 are complete.** Production is live, both remaining webhooks
are proven, the Beta comp coupon exists in both Stripe modes, provider moderation is on and
validated, and all four ops signals reach Discord.

**Updated 2026-08-31 — F.3 AND F.4 both passed.** The **Beta comp coupon** is proven end to
end on the real Stripe rails in **both** modes: $0.00 due today, a card still captured, and
the 4th cycle at full price. **The D.6 debt is closed** — production has completed a
live-mode Checkout, and it was the owner's, not a customer's. The live Stripe webhook is
proven across three event types.

**Three items remain**, in the owner's order: **G.3 → the PITR drill → the secret rotation.**
Only the rotation is mostly scriptable.

> **F.4 found two production COMMISSIONING gaps**, either of which would have stopped beta
> tester one: production had **no admin user at all**, and Supabase Auth's **Site URL was
> `http://localhost:3000`**, so the invite email pointed at a machine that is not ours. Both
> are fixed and both are now steps in `deployment-guide.md` §2. The lesson generalises:
> **production was provisioned but never commissioned**, and only walking the path found it.

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

## 1. F.3 — the ten-step staging smoke. ✅ **DONE 2026-08-31. ALL TEN PASS.**

Run at repo HEAD `37a3b49b` against `https://staging.repworth.net`, posture
`ONBOARDING_DEMO_ENABLED=true` / `AUTOPILOT_PURCHASABLE=false` (Copilot founding,
$19.00/mo). Owner A `norbert.esekiel@repworth.net` walked steps 2–9; Owner B
`nsunn@usc.edu` served step 10. **Full record and every id: evidence file → Phase F.3.**

The three weighted steps, and what they returned:

- **Step 6 — a card IS collected. PASS.** `pm_1UAaO0IhPBLaM6xAv6XPwnke`, visa ·4242,
  captured against an invoice whose **total was $0.00**. That is
  `payment_method_collection: 'always'` behaving, read from the Stripe API rather than the
  form.
- **Step 8 — the 4th cycle is full price. PASS, by boundary proof.** The discount's `end` is
  2026-11-30T18:56:52Z — the cycle-4 anchor to the second, a 91-day span Stripe derived from
  `duration_in_months: 3`. **F.2's `repeating` deprecation risk does not materialise.** The
  limit is stated in the record: this is the discount's own end timestamp, **not** a rendered
  4th invoice, which would need a Stripe test clock a real Checkout cannot have.
- **Step 10 — CORRECTED, and it is finding F3-F1.** This step tests the eligibility **gate**
  and structurally **cannot** reach the provider error mapping: `resendOwnerInvite` throws on
  `last_sign_in_at` before `inviteUserByEmail` is called. Observed **409 Conflict**,
  `code: "OWNER_ALREADY_SIGNED_IN"`, and **no third email** (`invited_at` unmoved on
  re-read). ~~`src/lib/onboarding/resend-invite.ts` shipped staging-unverified.~~ **It did
  not.** `INVITE_ERROR_CODE_MAP`'s header reads `CONTRACT VERIFIED` and cites the
  2026-08-14 staging evidence D-13 (`email_exists` / 422 → 409). That sentence was stale when
  this handoff was written.

**Original preparation notes, all confirmed correct before the run:** migrations 105 + 106
by introspection; `ONBOARDING_DEMO_ENABLED=true`; `BETA_COMP_COUPON_ID=repworth-beta-comp-3mo`
on Vercel staging with the running deployment carrying it; and the trial/coupon collision
ruled out, because `isTrialEligible` requires `onboarded_by IS NULL` and an **Admin invite**
never has that — so step 5's "$0 due today" could only be the coupon. It was.

## 1b. F.4 — the production walk. ✅ **DONE 2026-08-31. THE D.6 DEBT IS CLOSED.**

`BETA_COMP_COUPON_ID` written to the Infisical vault `prod` (the owner chose vault-then-
verify over a Vercel-only write), Railway redeployed `--from-source` and confirmed running
`tsx worker/index.ts` with four poller cycles, Vercel Production read back and redeployed.

Session `cs_live_a1vi…` · subscription `sub_1UAbs7IhPBLaM6xASGkfGz2V` · invoice
`in_1UAbs5…` — **subtotal $19.00, total $0.00, `paid`**, card `pm_1UAbs5…` captured on that
$0 invoice. `payment_method_collection: "always"`, `allow_promotion_codes: null`. 4th cycle
full price by the same boundary proof as F.3. Cancelled immediately; **the owner was charged
$0.00**. **Six findings, F4-F1…F4-F6.** Full record: evidence file → **Phase F.4**.

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
**zero accounts, zero businesses, zero users** — Phase E added `inbound_events` rows (three
as of 2026-08-31; see the count note in the evidence file) and nothing else.

> **Ordering correction, 2026-08-31.** "That window closes the moment tester one signs up"
> reads as *drill before F.4*. **Do not read it that way.** Two facts, both checked against
> the runbook rather than assumed:
>
> 1. **The drill is non-destructive** — §3 is *Restore to a New Project*. Nothing about it
>    needs production empty.
> 2. **Zero-state makes the drill WEAKER, not safer.** §4's pass criteria are row-count
>    comparisons, `count(*) as auth_users`, and `max(created_at)` being recent. Against an
>    empty database every one of those passes **vacuously** — it would prove the clone ran,
>    not that data came back.
>
> **So run F.4 first, then the drill.** F.4's one staff **Account**, **Business**, auth user
> and Stripe rows are the minimum data that makes §4 a real check, with no customer exposure.
> The genuine deadline is *before you have to depend on a restore*, not *before any row
> exists*.

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
