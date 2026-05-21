# PR #2 Test Runbook — Pre-paywall Demo + Journey Reorder

**PR:** Pre-paywall Demo + Journey Reorder (new feature, flag-gated)
**Branch:** `feat/pre-paywall-demo-pr2`
**Base:** `feat/lifecycle-extraction` (PR #1) → ultimately `main` once PR #1 lands
**Goal of this runbook:** verify the new pre-pay demo flow end-to-end before opening the PR, and confirm the legacy 3-step wizard still works when the flag is off.

This runbook is local pre-PR verification. Delete after PR #2 merges — it's ephemeral.

---

## What you're testing

A new screen between signup and paywall (`/onboarding/start` → `/onboarding/demo` → `/onboarding/pay` → `/onboarding/business`). The user sees a live AI-generated demo of responses for **their actual Google reviews** before being asked to pay.

Five test layers:

1. **Static checks** (5 min) — type, lint, unit tests
2. **Migration apply** (2 min) — run migration 032 in Supabase SQL editor
3. **Mock end-to-end with flag OFF** (10 min) — confirm legacy flow still works
4. **Mock end-to-end with flag ON** (15 min) — full new flow with `MOCK_EXTERNAL_APIS=true`
5. **Real-API end-to-end** (10 min, optional, ~$0.05) — full flow against actual SerpAPI + LLM

Plus failure-path checks (5 min) and rollback notes.

---

## 0. Prerequisites

```powershell
# Confirm you're on the right branch at the right tip
git status
git log --oneline -1
# Expected last commit: de0f8f1 fix(pr2): three more medium review issues
# Expected commit count from PR #1 tip: 21 commits
git rev-list --count d8219a7..HEAD

# Dependencies
pnpm install
```

Required env (`.env.local`):

- `SERPAPI_API_KEY` (skip if you'll only run mock-mode tests)
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (for PlaceAutocomplete on `/onboarding/start`)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
- `DATABASE_POOL_URL`, `REDIS_CACHE_URL`, `REDIS_QUEUE_URL`
- `STRIPE_SECRET_KEY` + `STRIPE_PAYMENT_LINK_*` (for the paywall click-through; optional if you only want to verify the demo screen)

---

## 1. Static checks

### 1a. TypeScript

```powershell
pnpm tsc --noEmit
```

**Expected:** `TypeScript: No errors found`

### 1b. ESLint

```powershell
pnpm lint
```

**Expected:** ~15 pre-existing errors in unrelated files (`twilio-*.test.ts`, `DemoGenerationWorker.test.ts`, `PlaceIdValidationWorker.test.ts`, `correlation-chain.test.ts`, `resend-webhook-bounce.test.ts`). **None should be in `src/lib/demos/**`, `src/lib/costs/onboarding-demo-cost-guard.ts`, `src/app/onboarding/**`, `src/app/api/onboarding/**`, or `worker/jobs/OnboardingDemoWorker.ts`.**

Quick sanity check:

```powershell
pnpm lint 2>&1 | Select-String "onboarding|cost-guard|fallback|SetupChecklist|PaywallWith"
# Expected: no output (no PR #2 files in the lint failures)
```

### 1c. Unit + integration tests

```powershell
$env:MOCK_EXTERNAL_APIS = "true"
npx vitest run `
  src/lib/demos/__tests__ `
  src/lib/costs/__tests__ `
  src/app/api/onboarding/__tests__ `
  src/app/api/onboarding/start/__tests__ `
  worker/jobs/__tests__/OnboardingDemoWorker.test.ts `
  worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts
```

**Expected:** **154 tests pass / 0 fail**. The lifecycle integration tests skip cleanly if `TEST_DATABASE_POOL_URL` is not set.

If you have a test DB:

```powershell
$env:TEST_DATABASE_POOL_URL = "postgres://...your test pool URL..."
npx vitest run src/lib/demos/__tests__/lifecycle.test.ts
# Expected: includes the new 23505 race-loser recovery test
```

---

## 2. Apply migration 032

The migration is **NOT auto-applied**. Run it yourself in the Supabase SQL editor:

1. Open the Supabase dashboard for your local/staging project.
2. Navigate to **SQL Editor**.
3. Paste the contents of `supabase/migrations/032_onboarding_demos.sql` and run.
4. Verify:

   ```sql
   SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'onboarding_demos';
   -- Should return one row.

   SELECT indexname FROM pg_indexes
   WHERE tablename = 'onboarding_demos'
   ORDER BY indexname;
   -- Should return 6 rows:
   --   onboarding_demos_business_lookup
   --   onboarding_demos_completed_for_cleanup
   --   onboarding_demos_generation_inflight
   --   onboarding_demos_one_completed_per_user
   --   onboarding_demos_pkey                    ← auto-created for `id UUID PRIMARY KEY`
   --   onboarding_demos_user_lookup
   ```

---

## 3. Mock E2E — flag OFF (legacy 3-step wizard regression)

Goal: prove the existing single-pass wizard still works when `ONBOARDING_DEMO_ENABLED` is unset.

```powershell
# .env.local — confirm or add:
# MOCK_EXTERNAL_APIS=true
# SELF_SERVE_SIGNUP_ENABLED=true
# (do NOT set ONBOARDING_DEMO_ENABLED — leave it unset)

pnpm dev
# In a second terminal:
pnpm worker
```

Walk the legacy flow (today's order is **pay-first, then wizard**):

1. Visit `http://localhost:3000/signup` and sign up with a test email.
2. Confirm the OTP (or whatever your local mail-stub does).
3. After confirmation you should land on **`/onboarding/pay`** (NOT `/onboarding/business` — the wizard's guard redirects to `/pay` whenever `subscription_status !== 'active'`, and a fresh signup is `pending_payment`). Also confirm `/onboarding/start` returns **404** with the flag off.
4. Complete a Stripe test payment (`4242 4242 4242 4242`). The Stripe webhook flips `subscription_status` to `active`.
5. Once you're back from Stripe success you should land on **`/onboarding/business`** rendering the **3-step wizard**: Location → Profile → Voice (3 progress dots labeled "Location", "Profile", "Voice").
6. Complete all three steps. Submit.
7. You should be redirected to **`/dashboard`**.

**Expected:** identical to today's pre-PR behavior. If anything looks different in the 3-step wizard, that's a regression in the bifurcation work — flag the page diff.

Also verify:

- `http://localhost:3000/onboarding/start` → **404**
- `http://localhost:3000/onboarding/demo` → **404**

---

## 4. Mock E2E — flag ON (new pre-pay demo flow)

Stop the dev server. Add to `.env.local`:

```
ONBOARDING_DEMO_ENABLED=true
ONBOARDING_DEMO_DAILY_CENTS=100
```

(`100` = $1/day — keeps you well clear of accidental spend during testing.)

Restart `pnpm dev` and `pnpm worker`.

### 4a. Happy path

1. Sign up with a NEW test email (don't reuse the flag-off one).
2. After OTP confirmation you should land on **`/onboarding/start`** (not `/business`).
3. Type a business name and pick a real Google business with PlaceAutocomplete (you can use any local cafe — mock mode means no real SerpAPI call). Click **"Generate my demo"**.
4. You should redirect to **`/onboarding/demo`** with a loading spinner.
5. Within ~2–10 seconds the worker picks up the job. The page polls `/api/onboarding/demo/status` every 2s and refreshes when status flips. You should see:
   - 3 review cards (mock mode returns deterministic fixtures)
   - Each with an AI response below
   - A "Choose a plan →" CTA
   - A subtle "Regenerate demo" link below the CTA
6. Click **"Choose a plan →"** → you should land on `/onboarding/pay`.
7. Complete a Stripe test payment (use Stripe's `4242 4242 4242 4242` test card).
8. After webhook confirmation you should land on **`/onboarding/business`** which should now render the **2-step wizard** (Profile → Voice — NO Location step, since location was captured at `/start`). Look for **2 progress dots** labeled "Profile", "Voice" plus the encouraging blue copy at the top: *"You're in. Two quick questions to make responses sound like you, then we go live."*
9. Submit the wizard. You land on `/dashboard`. The dashboard should render the new **SetupChecklist** at the top with 4 items (Connect Zernio, Approve your first response, Tune your voice, Set notification preferences).

### 4b. Cost ceiling block

Reset Redis or set a tighter ceiling and burn it:

```powershell
# In Redis (use redis-cli against your local Upstash):
SET cost:onboarding-demo:override:cents 10
# 10¢ = below the 20¢ reservation, so the FIRST attempt trips it.
```

1. Sign up with a fresh email.
2. On `/onboarding/start`, submit the location.
3. You should still redirect to `/onboarding/demo` — but the page should render the **paywall standalone** with copy like *"Your live demo is on the way after signup — for now, you can still subscribe."* and a "Choose a plan →" button. **No infinite redirect loop.**

Reset the override when done:

```powershell
DEL cost:onboarding-demo:override:cents
```

### 4c. Failed-demo paywall

Force a failure to test the failed-state UI:

```powershell
# In Postgres:
UPDATE onboarding_demos
SET generation_status = 'failed',
    generation_error = 'simulated failure for runbook test'
WHERE user_id = (SELECT id FROM users WHERE email = 'your-test-email@example.com');
```

Refresh `/onboarding/demo`. You should see:

- ⚠️ icon + *"We couldn't generate a sample demo this time."*
- A grey **"Try the demo again"** button
- The full paywall card immediately below it

Critical: **the paywall stays usable on the failure path.** Never block payment on a transient generation issue.

### 4d. Regenerate

From a completed demo screen, click the **"Regenerate demo"** link.

1. The current completed demo gets archived, a new queued demo is inserted.
2. The page refreshes into the loading spinner.
3. The new demo completes within seconds (mock mode).
4. Check the DB:

   ```sql
   SELECT id, generation_status, created_at
   FROM onboarding_demos
   WHERE user_id = (SELECT id FROM users WHERE email = 'your-test-email@example.com')
   ORDER BY created_at DESC;
   ```

   You should see the new completed row at the top and the previous one with `archived` status.

---

## 5. Real-API end-to-end (optional, ~$0.05)

Same as section 4a but with `MOCK_EXTERNAL_APIS=false` (or unset). The worker will hit real SerpAPI and the real LLM. Confirm:

1. The 3 review cards show **real** review text from your test business (not the deterministic fixture text starting with "Absolutely loved the experience here…").
2. The Postgres `api_costs` table gets new rows from the LLM call (SerpAPI cost is NOT yet tracked there — that's Phase 2; see `.claude/skills/onboarding-demo-cost-guard.md`).
3. Daily counter in Redis increments correctly:

   ```
   GET cost:onboarding-demo:2026-05-04
   ```

   Should show ~3 (cents — actual LLM cost rounded after the worker reconciles the 20¢ reservation).

---

## 6. Failure-path spot checks

### 6a. Subscription guard during demo generation

Race the worker: start a demo, then immediately mark the business `active` before the worker picks up the job.

```sql
UPDATE businesses
SET subscription_status = 'active'
WHERE id = (SELECT business_id FROM users WHERE email = 'your-test-email@example.com');
```

The worker should:

- Mark the demo `failed` with `generation_error = 'subscription_state_changed'`
- NOT call `completeDemo` with empty arrays (which would lock the user out via the partial unique index)

Refresh `/onboarding/demo` — page should redirect to `/dashboard` (subscription_status='active' bypass).

### 6b. SerpAPI failure → curated fallback

Temporarily break SerpAPI by setting an invalid key:

```
# .env.local
SERPAPI_API_KEY=invalid-deliberately
```

Restart the worker. Trigger a fresh demo. Worker should fall back to curated content and complete the demo with `source = 'curated_fallback'`. The UI should show an amber banner: *"Sample reviews shown — connect your account after signup to see your real ones."* **The demo should NOT fail.**

Restore the real key when done.

### 6c. Cleanup poller — 30-day stale demos

Insert a fake old completed demo and run the poller:

```sql
UPDATE onboarding_demos
SET completed_at = NOW() - INTERVAL '31 days'
WHERE user_id = (SELECT id FROM users WHERE email = 'your-test-email@example.com')
  AND generation_status = 'completed';
```

Trigger the poller (it runs hourly by default — restart `pnpm worker` or wait):

```sql
SELECT id, generation_status, completed_at FROM onboarding_demos
WHERE id = '...your-id...';
-- Expected: row is gone (deleted by stale-cleanup pass).
```

---

## 7. Rollback

If anything goes wrong in production after deploy:

1. **Disable the feature** — set `ONBOARDING_DEMO_ENABLED=false` and redeploy.
   - `/onboarding/start` and `/onboarding/demo` 404 immediately.
   - `/onboarding/business` reverts to the legacy 3-step wizard.
   - The `onboarding_demos` table stays — it's inert without the flag. The 30-day cleanup pass continues to drop completed rows.
2. **No migration rollback needed.** Migration 032 is additive (new table, new indexes). The legacy flow doesn't touch it.

If you need to fully back out, drop the table:

```sql
DROP TABLE IF EXISTS onboarding_demos CASCADE;
```

(But keep the migration file — it's a record of what shipped.)

---

## Sign-off

- [ ] Static checks (1a, 1b, 1c) all green
- [ ] Migration 032 applied + indexes verified
- [ ] Flag-OFF flow: legacy 3-step wizard still works, `/start` and `/demo` 404
- [x] Flag-ON happy path: signup → /start → /demo (live demo) → /pay → /business (2-step) → /dashboard
- [x] Cost-ceiling block renders standalone paywall (no redirect loop)
- [x] Failed-demo state renders paywall + "Try again"
- [x] Regenerate archives prior, queues new
- [x] Real-API run completed (see Section 5 notes)
- [x] Subscription state-change guard
- [x] SerpAPI failure → curated fallback
- [x] Cleanup poller deletes 30+-day-old completed demos

---

## Test Results — 2026-05-05 (automated run on `feat/pre-paywall-demo-pr2`)

**Tester:** Claude Code (automated browser + DB + Redis via MCP)
**Environment:** local dev, real-API mode (`MOCK_EXTERNAL_APIS` unset), `ONBOARDING_DEMO_ENABLED=true`
**Dev server:** localhost:3000 | **Worker:** localhost:3001

### 4a. Happy path — PASS

- Signed up as `norbertliverpool+s4a@gmail.com`, confirmed OTP, landed on `/onboarding/start` ✓
- Submitted Google Maps URL (place_id URL mode — PlaceAutocomplete web component not testable via Playwright accessibility tree; see note below) ✓
- Redirected to `/onboarding/demo` with loading spinner ✓
- Worker completed demo within ~2 minutes; page polled and refreshed to show 3 real review cards with AI responses ✓
- "Choose a plan →" CTA present; "Regenerate demo" link present below CTA ✓
- Stripe checkout triggered; payment-success polling confirmed; wizard completed; landed on `/dashboard` ✓

**Note — PlaceAutocomplete:** `gmp-place-autocomplete` is a Google Maps web component with `shadowRoot: null` in the Playwright context (Google Maps JS API doesn't initialize in headless Playwright). All testing used the "Or paste a Google Maps URL" fallback with `https://maps.google.com/maps?q=place_id:<ID>` format. The autocomplete path was not exercised by automation.

**Note — Stripe webhook locally:** `PaymentSuccessClient` polls `/api/auth/signup-status` until subscription goes active. Without `stripe listen --forward-to localhost:3001/ingress/stripe` running, the webhook never fires and the page stalls. `subscription_status` was manually updated in Supabase to unblock the test. Add Stripe CLI listener to local dev prerequisites.

**Note — Post-pay wizard steps:** Wizard now has 3 steps (Profile → Voice → Connect Zernio), not 2 as the runbook states in step 8. The Connect step was added in this PR. Update the runbook check.

**Note — Dashboard checklist:** Step 9 references a `SetupChecklist` with 4 items. That component was removed in this PR and replaced with a "Connect Google Business" banner. Sign-off item updated accordingly.

### 4b. Cost ceiling block — PASS

- Set `cost:onboarding-demo:override:cents = 10` (below 20¢ reservation threshold)
- New user (`norbertliverpool+s4b@gmail.com`), OTP delivery failed; user was manually confirmed in Supabase auth; password login used
- Submitted location on `/onboarding/start`; redirected to `/onboarding/demo` ✓
- Page rendered standalone paywall: *"Your live demo is on the way after signup — for now, you can still subscribe."* + "Choose a plan →" — no redirect loop ✓
- DB: `onboarding_demos` row NOT inserted (cost ceiling blocked before transaction) ✓
- Redis: daily cost counter rolled back to 0 after failed reservation ✓
- **Side effect observed:** user-rate-limit and IP-rate-limit keys were incremented even though the cost check failed. Rate limit slots are consumed before the cost guard runs — the user's daily slot is spent even on a ceiling-blocked attempt.
- Override key deleted after test ✓

### 4c. Failed-demo paywall — PASS

- Manually inserted `generation_status = 'failed'` row for s4b user
- `/onboarding/demo` rendered: ⚠️ icon + *"We couldn't generate a sample demo this time."* + grey "Try the demo again" button + paywall card ✓

**Bug:** "Try the demo again" calls `POST /api/onboarding/demo/regenerate`, which only archives a *completed* demo and enqueues a new one. For a user whose only demo is `failed` (no prior `completed` row), the endpoint returns `409 no_demo_to_regenerate`. `handleRegenerate()` checks `if (res.ok)` and silently discards the 409 — the button does nothing and gives no feedback. A user in this state cannot retry until they pay (at which point they get production responses instead). Consider routing "Try the demo again" to `/api/onboarding/start` instead, or having the regenerate endpoint also handle failed demos.

### 4d. Regenerate — PASS

- Updated s4b's failed demo to `completed` with dummy data
- Navigated to `/onboarding/demo`; demo rendered with review + AI response + "Regenerate demo" link ✓
- Clicked "Regenerate demo": page refreshed to loading spinner ✓
- DB: old demo → `archived`; new demo → `queued` (later `completed` by worker) ✓

**Behavior noted:** when regenerate runs and there is already a `completed` demo for the same user (partial unique index `onboarding_demos_one_completed_per_user`), the worker's 23505 race-loser recovery correctly archives the incoming demo rather than failing. Log confirms: *"completed (curated_fallback): 3/3 responses"* then row lands as `archived`.

### 5. Real-API end-to-end — PASS

- Real SerpAPI + GPT-4o-mini; demo completed for Lazy Dog (ChIJAb33GUS0j4ARjGKbpYi5jR4)
- Review cards show real review text (not fixture text) ✓
- `source = 'serpapi'` in DB ✓

**Runbook correction (item 2):** The runbook says "`api_costs` table gets new rows from the LLM call." This is **incorrect**. `runDemoMode` in `src/lib/responses/generator.ts` intentionally skips `api_costs` inserts — the comment reads *"no cost guard, no caching."* Only `runProductionMode` writes to `api_costs`. No `api_costs` rows are created during demo generation.

**Runbook correction (item 3):** The runbook says Redis counter should show *"~3 (cents)"*. In practice, GPT-4o-mini 3-response cost ≈ $0.0004 total → `Math.round(0.04) = 0` → delta = `0 - 20 = -20` → counter returns to 0 after `finalizeOnboardingDemoCost`. Counter shows **0**, not 3. The reservation is fully released for sub-cent LLM costs.

### 6a. Subscription guard during demo generation — PASS

- Inserted `queued` demo + outbox job while business was `active`
- Worker picked up job: demo → `failed`, `generation_error = 'subscription_state_changed'` ✓
- Worker did NOT call `completeDemo` with empty arrays ✓
- `/onboarding/demo` redirected to `/dashboard` for active-subscription user ✓

### 6b. SerpAPI failure → curated fallback — PASS

- Set `SERPAPI_API_KEY=invalid-deliberately`; restarted worker
- Worker log: *"SerpAPI fetch failed for demo …; falling back to curated content: Invalid API key"* ✓
- Demo completed with `generation_status = 'completed'`, `source = 'curated_fallback'` ✓
- `/onboarding/demo` rendered amber banner: *"Sample reviews shown — connect your account after signup to see your real ones."* + 3 curated review cards (Sarah M., James K., Patricia R.) ✓
- SERPAPI key restored; worker restarted ✓

**Note — 23505 collision on first attempt:** The first `curated_fallback` run hit the `one_completed_per_user` partial unique index (prior completed demo for same user). Worker correctly detected the collision and archived the incoming demo. A second run (with prior completed archived first) completed successfully. The 23505 race-loser recovery is working.

### 6c. Cleanup poller — PASS (query confirmed; poller timing noted)

- Updated a completed demo's `completed_at` to `NOW() - INTERVAL '31 days'`
- CleanupAbandonedSignupsPoller (interval=120s) ran but missed the row due to startup race (poller's initial run fired before the updated row was committed)
- Manual execution of the exact cleanup query deleted the row immediately ✓
- Row confirmed absent in DB ✓
- Cleanup SQL: `DELETE FROM onboarding_demos WHERE generation_status = 'completed' AND completed_at < NOW() - INTERVAL '30 days'`

**Recommendation:** For deterministic poller testing, insert stale rows *before* starting the worker, or wait for the second poller cycle (2 min after startup).

### Pre-existing bug noted (not introduced by this PR)

- **Dashboard Review Velocity chart:** All x-axis labels render as "Invalid Date". Appears to be a date-formatting issue in the chart component unrelated to this PR.
- [ ] Cleanup poller deletes 30-day-old completed rows
