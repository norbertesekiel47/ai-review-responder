# 1-Month Free Trial — Staging E2E + Production Rollout

Hands-on verification that the card-up-front 30-day trial (PR #362) works end-to-end
on **staging**, plus the production flag flip. The trial is the **default self-serve
onboarding path** when enabled: a new self-serve owner enters a card at Stripe Checkout
(`trial_period_days`), is charged **$0 now**, gets the full product for 30 days, and
Stripe auto-charges at trial end.

- **Env behavior:** `.claude/reference/env-vars.md` (`TRIAL_ENABLED`, `TRIAL_PERIOD_DAYS`).
- **Deploy topology / migration mechanics:** `docs/runbooks/deployment-guide.md`.
- **How to drive a test review through the real pipeline (for the full-access test):**
  `docs/runbooks/multi-location-e2e-full-loop.md` (Zernio webhook → ingest → draft →
  notify → approve → publish).
- **Design / settled decisions:** `PLAN.md` (the grilled+Codex-approved rev 6).

> Staging is the **only** non-prod place the whole pipeline runs. Run every step here
> against staging (separate Supabase project, **Stripe test mode** keys), never prod.
> `TRIAL_ENABLED` stays **OFF in prod** until this whole runbook passes on staging.

Throughout: `APP=https://<staging-app-url>`, `WORKER=https://<staging-worker-url>`. Run
SQL in the **staging** Supabase SQL editor.

---

## 0. Prerequisites (must all be TRUE on staging before testing)

- [ ] PR #362 deployed to staging (push to `staging` auto-deploys Railway worker + Vercel staging env).
- [ ] **Migration 069 applied to the staging Supabase project** (§1).
- [ ] `TRIAL_ENABLED=true` **and** `SELF_SERVE_SIGNUP_ENABLED=true` on **both** Railway and Vercel staging. (Optional `TRIAL_PERIOD_DAYS`; default 30. Use a short value like `TRIAL_PERIOD_DAYS=1` if you want a fast real-time convert, or use a Stripe **Test Clock** to fast-forward — §Part B.)
- [ ] Stripe is in **test mode**: the staging webhook endpoint (`$WORKER/ingress/stripe`) subscribes to **all six** trial-relevant events:
  `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`.
  The endpoint's **API version** matches the pinned outbound `apiVersion` in `src/lib/payments/stripe-client.ts`.
- [ ] (For the §Part B day-30 gate) `STRIPE_TEST_CLOCK_LIVE=true` and a `sk_test_...` key available to the test process (the acceptance suite is skipped otherwise).
- [ ] A **self-serve** test account in `pending_payment` with a primary business (`onboarded_by IS NULL`) and an **active Zernio connection** (needed for T2/T3). Capture its IDs:
  ```sql
  SELECT b.id AS business_id, b.account_id, b.name, b.onboarded_by, a.subscription_status
  FROM businesses b JOIN accounts a ON a.id = b.account_id
  WHERE b.name ILIKE '%<your test business>%' AND b.is_primary = TRUE;
  -- expect: subscription_status='pending_payment', onboarded_by IS NULL (self-serve).
  ```

---

## Part A — Trial start, full access, and the guardrails (no test clock needed)

### T1 — Start the trial → `trialing`, $0 now, card captured, Stripe IDs persisted

1. In the staging app, complete signup as the self-serve owner → choose a plan (default `standard`) → complete Stripe Checkout with a test card (`4242 4242 4242 4242`).
2. Stripe Checkout shows **$0 due today** and a trial end date; the card is captured.
3. After `checkout.session.completed` lands, verify:
   ```sql
   SELECT subscription_status, trial_ends_at, subscription_activated_at,
          stripe_customer_id, stripe_subscription_id
   FROM accounts WHERE id = '<account_id>';
   -- expect: subscription_status='trialing'; trial_ends_at ≈ now()+30d;
   --         subscription_activated_at SET (service-start anchor); BOTH stripe_* ids NON-NULL.
   ```
   **PASS:** status `trialing`, `trial_ends_at` in the future, **both** `stripe_customer_id` and `stripe_subscription_id` populated (so later webhooks can resolve the account). `trial_started` analytics event present:
   ```sql
   SELECT event_name FROM analytics_events
   WHERE account_id='<account_id>' AND event_name='trial_started';  -- expect: 1 row
   ```

### T2 — Full product access during trial (draft → approve → post to Google)

1. The owner lands on `/dashboard` (NOT bounced to pay). A **"Trial — N days left"** banner shows with the auto-charge date.
2. Drive a **3★** test review through the pipeline (Zernio webhook → `$WORKER/ingress/zernio`; see the full-loop runbook). It must NOT auto-approve.
3. Verify a draft + approval notification, then **Approve**:
   ```sql
   SELECT id AS response_id, status, approval_method, posted_at
   FROM responses WHERE business_id='<business_id>' ORDER BY created_at DESC LIMIT 1;
   -- after approve: status='posted', approval_method='owner', posted_at set.
   ```
   **PASS:** a trialing account generates, gets notified, approves, and the reply posts to the live (test) Google profile — identical to an `active` account. (Confirms the entitlement sweep: `subscriptionGrantsFullAccess` treats trialing like active.)

### T3 — Onboarding drip is scheduled for the trial (regression — was broken pre-fix)

1. Confirm the trial-start mirror wrote the **businesses** service-start anchor:
   ```sql
   SELECT subscription_status, subscription_activated_at
   FROM businesses WHERE id='<business_id>';
   -- expect: subscription_activated_at NON-NULL (mirrored on trial start).
   ```
2. After the drip scheduler tick, confirm a drip job is enqueued (not skipped):
   ```sql
   SELECT topic, status, payload->>'drip_type' AS drip_type FROM job_outbox
   WHERE aggregate_id='<business_id>' AND topic = 'onboarding_drip'
   ORDER BY created_at DESC;
   -- expect: at least the day_1 drip enqueued (NOT absent).
   ```
   **PASS:** `businesses.subscription_activated_at` is set and a drip is scheduled. **FAIL signal (the old bug):** anchor NULL → no drip rows ever appear → the conversion-nurture email lane is dead for trials.

### T4 — Ranking is NOT run for trials (deliberate cost boundary)

1. After a ranking-scheduler tick, confirm **no** ranking job is enqueued for the trial account:
   ```sql
   SELECT count(*) FROM job_outbox jo
   JOIN businesses b ON b.id = jo.aggregate_id
   WHERE b.account_id='<account_id>' AND jo.topic = 'track_ranking';  -- expect: 0
   ```
   **PASS:** count = 0. Trials incur no paid SerpAPI ranking spend; ranking activates only on conversion to `active`.

### T5 — Trialing is BLOCKED from creating a second subscription

1. As the trialing owner, POST `$APP/api/billing/checkout` (or hit the billing checkout entrypoint) directly.
   **PASS:** `409 account_already_active` — no second Stripe subscription is created. (The billing **portal** is still allowed for card updates; only *new checkout* is blocked.)

### T6 — Admin-handoff accounts do NOT get a trial (eligibility gate)

1. Take an **admin-onboarded** test account (`onboarded_by` non-null) in `pending_payment` and run it through `/api/onboarding/select-plan` (and `/api/billing/checkout`) with `TRIAL_ENABLED=true`.
   ```sql
   SELECT onboarded_by FROM businesses WHERE account_id='<admin_account_id>' AND is_primary=TRUE;
   -- onboarded_by NON-NULL = admin/partner-onboarded.
   ```
   **PASS:** the resulting Stripe Checkout has **no** `trial_period_days` (a normal **paid** checkout) — the $0 trial is reserved for self-serve (`onboarded_by IS NULL`) only.

---

## Part B — The day-30 boundary (Stripe Test Clock) — the highest-value gate

These convert/cancel/fail paths cannot be proven by unit tests. Run the **test-clock
acceptance suite** (or drive a Test Clock manually in the Stripe test dashboard).

### B0 — Run the acceptance suite

```bash
STRIPE_TEST_CLOCK_LIVE=true STRIPE_SECRET_KEY=sk_test_... \
  pnpm vitest run worker/ingress/stripe/__tests__/trial-test-clock.acceptance.test.ts
# Covers: convert→active; cancel-in-trial $0; mid-trial add-location $0-until-trial_end;
#         mid-trial tier-change $0-until-trial_end. (Skips cleanly without the env above.)
```
For card-fail / SCA (not in the live suite), drive a Test Clock manually with the
designated test cards (§T8). Verify each below against the DB.

### T7 — Convert at trial end → `active`, charged

Advance the Test Clock past `trial_end` (or let `TRIAL_PERIOD_DAYS=1` elapse).
```sql
SELECT subscription_status, trial_ends_at, subscription_activated_at
FROM accounts WHERE id='<account_id>';
-- expect: status='active'; trial_ends_at NULL (invariant: non-null ⟺ trialing);
--         subscription_activated_at UNCHANGED (preserved via COALESCE).
SELECT event_name FROM analytics_events WHERE account_id='<account_id>' AND event_name='trial_converted'; -- 1 row
```
**PASS:** flips to `active` on the FIRST real paid invoice (the $0 trial-start invoice must **not** convert early), `trial_ends_at` cleared, one `trial_converted` event. Confirm the card was charged the plan amount in the Stripe test dashboard.

### T8 — Card fails / SCA at conversion → `past_due` (7-day grace)

Use a card that fails at renewal (`4000 0000 0000 0341`) or requires authentication
(`4000 0025 0000 3155`), then advance the clock past `trial_end`.
```sql
SELECT subscription_status, past_due_at FROM accounts WHERE id='<account_id>';
-- expect: status='past_due', past_due_at set (7-day grace begins).
SELECT event_name FROM analytics_events WHERE account_id='<account_id>' AND event_name='trial_payment_failed'; -- 1 row
```
**PASS:** `trialing → past_due` (not stuck trialing), grace window active, `trial_payment_failed` event. (Both `invoice.payment_failed` and `invoice.payment_action_required` route here.)

### T9 — Cancel during trial → access to trial_end, $0, then `cancelled`

Cancel via the offboarding flow (portal cancel is disabled), then advance the clock past `trial_end`.
```sql
-- During trial after cancel request: still 'trialing' until trial_end (cancel_at_period_end).
-- After trial_end:
SELECT subscription_status, trial_ends_at, cancelled_at FROM accounts WHERE id='<account_id>';
-- expect: status='cancelled', trial_ends_at NULL, cancelled_at set.
SELECT event_name FROM analytics_events WHERE account_id='<account_id>' AND event_name='trial_cancelled'; -- 1 row
```
**PASS:** access stays full until `trial_end`, **$0 charged** (verify in Stripe), then `cancelled`. `access_ends_at` in the offboarding email == `trial_end`.

### T10 — Mid-trial add-location / tier change → $0 until trial_end

While `trialing`, add a 2nd location (or change tier). Confirm in the Stripe test
dashboard that the proration accrues but **nothing is invoiced until `trial_end`**;
then advance the clock and confirm the new quantity/tier bills correctly on conversion.
**PASS:** `$0` during the trial; correct charge at conversion. (`create_prorations` is trial-safe.)

### T11 — Reconcile poller heals a missed conversion webhook

Simulate a dropped `customer.subscription.updated` (e.g. temporarily 4xx the webhook),
advance the clock so Stripe converts the subscription to `active`, leave the DB stuck at
`trialing`, then let the billing-reconciliation poller run.
```sql
SELECT subscription_status FROM accounts WHERE id='<account_id>';  -- expect: corrected to 'active'
```
**PASS:** the poller's scoped corrective authority flips the stuck `trialing` row to match Stripe. Separately, a DB-`active` row whose Stripe sub is `trialing` now **surfaces a `status_mismatch` drift alert** (no longer silently suppressed — PLAN §15).

---

## Sign-off checklist (staging)

**Test run — 2026-06-22 (PR #362).** Legend: ✅ verified live on staging · ◑ partially
verified (acceptance suite / unit / a different method, or a time-gated remainder) · ☐ not run.

| # | Check | Status | Notes |
|---|---|---|---|
| 0 | Migration 069 applied to staging; 6 Stripe events subscribed | ✅ | 069 applied + verified. All **6** events now subscribed — `invoice.payment_action_required` was MISSING and was added (do the same on the **prod** endpoint). |
| T1 | Start trial → `trialing`, $0, card captured, both Stripe IDs persisted, `trial_started` | ✅ | Verified twice (real Stripe test Checkout). |
| T2 | Full access: 3★ → draft → approve → posted to Google | ◑ | AI **draft generated** + owner notification verified (synthetic review). Approve→**post to Google deliberately NOT run** — the connected account is a real business; no posting. |
| T3 | `businesses.subscription_activated_at` set + onboarding drip scheduled | ◑ | Anchor **set** ✅. Drip enqueue is time-gated (day-1 ≈ 24h after activation) — not yet observed. |
| T4 | No ranking job enqueued for the trial | ✅ | `track_ranking` count = 0. |
| T5 | New checkout for trialing → 409 `account_already_active` | ✅ | Exercised the `trialing` guard branch. |
| T6 | Admin-handoff (`onboarded_by` non-null) → paid checkout, NO trial | ✅ | Verified via DB seed (`onboarded_by` non-null) + route code: `TRIAL_ENABLED && onboarded_by===null` short-circuits → no trial. |
| T7 | Convert → `active`, `trial_ends_at` cleared, charged, `trial_converted` | ✅ | **Live staging projection PASS** (run 2): Stripe test-clock convert → staging webhook → DB `active`, `trial_ends_at` cleared, `trial_converted`. (+ acceptance suite 4/4.) |
| T8 | Card-fail/SCA → `past_due` + grace, `trial_payment_failed` | ✅ **FIXED + verified live** | Re-verified on staging (test-clock failing card → trialing→active→past_due): the account ended `past_due` (`trial_ends_at` cleared) AND emitted **BOTH** `trial_converted` (03:56:48) **and** `trial_payment_failed` (03:56:53). Fix: `invoice-payment-failed.ts` emits `trial_payment_failed` on an `active→past_due` failure when the account has a `trial_converted` event from the last 3 days (the conversion charge + dunning), keyed by (account, subscription) so it dedupes with the direct `trialing→past_due` path. **Net conversions = `trial_converted` − `trial_payment_failed`.** Unit-tested (+2) + live test-clock. (Card-decline path covered; a dedicated SCA `payment_action_required` path is the one remaining sub-case, routed to the same applier.) |
| T9 | Cancel-in-trial → access to trial_end, $0, `cancelled`, `trial_cancelled` | ✅ | **Live staging projection PASS** (run 2): test-clock cancel → staging webhook → DB `cancelled`, `trial_cancelled`. |
| T10 | Mid-trial add-location/tier-change → $0 until trial_end | ◑ | Test-clock acceptance suite PASS (4/4: add-location + tier-change $0); not separately driven through staging webhooks. |
| T11 | Reconcile heals stuck trialing; DB-active/Stripe-trialing drift surfaced | ⚠️ **logic ✅ · wedge FIXED · deeper stall OPEN** | **Logic verified live** (2026-06-22): invoking the poller's `runOnce()` against the live staging DB + Stripe healed a stuck `trialing`→`active` row (DB-confirmed, `trial_ends_at` cleared, `trial_converted` emitted) AND surfaced the reverse `status_mismatch` drift (DB `active` / Stripe `trialing`, row untouched) — `accountsChecked=3 driftsFound=1 errors=0`, ~1s. **The deployed staging worker's own `runOnce` STALLED**: across boots it logged `Starting` then never completed and did not heal the seeded row; a stalled run held `inProgress=true` so every later tick skipped — the fail-safe backstop (invariant #3 / PLAN §5) was non-functional on the deployed worker. **WEDGE FIXED (`0e2d13d9`, validated live 2026-06-23):** `runOnce` now wraps the cycle (240s) and each account (60s) in `withTimeout` — the deployed worker logged `Reconcile cycle exceeded its deadline — releasing the run` at exactly boot+240s and reset `inProgress`, so the poller can **no longer be permanently wedged** (+2 regression tests). **DEEPER STALL STILL OPEN:** the accounts query itself never completes on the deployed worker (no `Reconciling N paid accounts` breadcrumb) — it stalls the full 240s even with the worker **idle** and the DB **healthy** (19/60 conns, 0 blocking locks, 0 idle-in-txn), while the same query runs in ~1s via a one-off. So the heal still doesn't happen while stalled. Root cause is worker-side (Postgres.js connection/pool handling on Railway), needs pool instrumentation (log acquire/queue/idle stats around the query) to pin. Net: the timeout makes the backstop **resilient** (no wedge), not yet **functional** on the deployed worker. |
| + | Onboarding (demo ON): "Set up business" → business wizard opens (no loop) | ✅ | Live-verified on a fresh trial, 3× stable. |

**Bugs found + fixed during this run** (all on PR #362, CI green): (1) trial Checkout
completes `payment_status='paid'`/`amount_total=0`, not `no_payment_required` → every trial
was misfiled `active` (fix: gate on `amount_total===0`). (2) `businesses.subscription_activated_at`
not mirrored on trial start → drips dead for trials. (3) onboarding demo-mode loop → trial
couldn't reach the wizard (fix: `shouldUseDemoWizard` gates on location presence).
(4) staging Stripe webhook was missing `invoice.payment_action_required` — added.

**Run 2 (2026-06-22) closed the day-30 projection gap:** the **staging webhook→DB projection**
is proven live for **convert (T7)** and **cancel (T9)** — real Stripe test-clock transition →
staging worker → correct DB status + analytics event. All test data + Stripe test clocks were
cleaned up (staging = the connected account + admin only).

**Remaining before the prod flip:**
- **T11 deployed reconcile poller — wedge FIXED, deeper stall OPEN** (see the T11 row).
  - ✅ **Wedge fixed (`0e2d13d9`, validated live):** a stalled `runOnce` now times out (240s cycle / 60s
    account) and releases `inProgress` instead of wedging — the backstop can no longer be *permanently*
    disabled. This unblocks the worst-case (silent, forever-dead backstop).
  - ⚠️ **Still open before prod:** the deployed worker's reconcile query *stalls* (never completes) even
    idle / DB-healthy, so it doesn't actually HEAL while stalled. Root-cause the worker-side Postgres.js
    pool/connection stall (instrument acquire/queue/idle stats around the accounts query) so the backstop
    is **functional**, not just **resilient**, before relying on it in prod.
- minor: **T3**'s drip after the day-1 window; **T10**'s staging-webhook projection (billing math
  already proven by the acceptance suite).

The core trial loop (T1/T4/T5/T6 + onboarding), **migration 069 + the 6 webhook events**, the
**day-30 convert/cancel projection (T7/T9)**, and **T8 card-fail analytics** are all green live.

---

## Part C — Production rollout (flag flip)

Anything here touches the worker / a webhook / a migration → **staging-first** (above).
Promotion = merge PR #362 into `main`; then:

1. **Migration 069 → prod** (after staging). Apply to the prod Supabase project; both
   projects must be in lockstep. It is additive (a column COMMENT + the
   `analytics_events` event-name CHECK extended for the 4 trial events) — **no data
   backfill**, no new column, negligible lock. Verify the CHECK accepts the trial events:
   ```sql
   SELECT conname FROM pg_constraint WHERE conname = 'analytics_events_event_name_check';
   ```
   > Ordering matters: 069 must land **before/with** the worker deploy that enqueues
   > `trial_*` events, or those inserts hit the old CHECK and fail.
2. **Stripe (prod, live mode):** the prod webhook endpoint subscribes to the same six
   events (§0); endpoint API version == pinned `apiVersion`. Enable Stripe's built-in
   **trial-end email** (Dashboard → Settings → Subscriptions) for the MVP reminder.
3. **Env (set on BOTH Vercel + Railway):** see the matrix below. Keep `TRIAL_ENABLED=false`
   until everything else is in place, then flip to `true` and redeploy both.
4. **Watch after flip:** first real trial signup → `trialing` + both Stripe IDs; first
   real day-30 convert (`trial_converted`, charged); reconcile poller drift alerts quiet.

### Env-var matrix

| Variable | Vercel | Railway | Default | Notes |
|---|---|---|---|---|
| `TRIAL_ENABLED` | ✅ | ✅ | `false` | master switch; server-authoritative (no `NEXT_PUBLIC_*`) |
| `TRIAL_PERIOD_DAYS` | ✅ | ✅ | `30` | trial length in days |
| `SELF_SERVE_SIGNUP_ENABLED` | ✅ | ✅ | — | trials are self-serve only; must also be `true` |
| `STRIPE_TEST_CLOCK_LIVE` | — | — (test only) | unset | gates the staging test-clock acceptance suite; never set in prod |

---

## Rollback

- **Disable trials instantly:** set `TRIAL_ENABLED=false` on Vercel + Railway, redeploy.
  New signups revert to pay-now; **accounts already `trialing` are unaffected** — Stripe
  still owns their subscription and the webhooks/reconcile keep projecting their state
  (convert / cancel / past_due) correctly with the flag off.
- **Migration 069 is additive — nothing to roll back.** (If ever needed, the CHECK change
  is the only reversible piece; do not drop the column comment.)
- **A stuck trial row** (missed webhook) self-heals via the billing-reconciliation poller
  (T11); no manual SQL needed. If you must force it, re-deliver the Stripe event from the
  Dashboard rather than hand-editing `accounts`.
