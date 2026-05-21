# Onboarding Demo Launch Runbook

PR #2 (`feat/pre-paywall-demo-pr2`) ships the pre-pay SerpAPI demo lane and
the journey reorder (`/onboarding/start` → `/onboarding/demo` → `/onboarding/pay`
→ `/onboarding/business`). This runbook covers staging soak and prod rollout.

## Prerequisites

- PR #1 (`feat/lifecycle-extraction`) merged. Provides
  `src/lib/demos/lifecycle.ts` + `select-qualifying.ts` + `fetch-reviews.ts`
  + `generate-responses.ts`.
- Migration **032** (`onboarding_demos`) applied via Supabase SQL editor.
- `SERPAPI_API_KEY` configured (was added in Sprint 4).
- Redis cache reachable (cost guard + threshold dedup live in Redis).

## Pre-launch — staging

1. Apply migration 032 to staging:
   ```sql
   \i supabase/migrations/032_onboarding_demos.sql
   ```
2. Set staging env:
   - `ONBOARDING_DEMO_ENABLED=true`
   - `ONBOARDING_DEMO_DAILY_CENTS=100` ($1/day — tight ceiling for soak)
3. Deploy `feat/pre-paywall-demo-pr2` to staging.
4. (Optional) Generate per-category fallback fixtures via
   `scripts/generate-fallback-demos.ts` — Phase 2 enhancement; v1 ships
   single `general-business` fixture.

## Smoke tests (staging)

1. **Real-API demo path.**
   - New signup → arrives at `/onboarding/start`.
   - PlaceAutocomplete picks a real business → submit.
   - Redirected to `/onboarding/demo`. Demo polls for ~10–30s.
   - Demo renders 3 review cards with AI responses + paywall CTA.
   - Confirm SerpAPI cost ledger entry (~$0.01) + finalized counter ~3¢.

2. **Curated fallback path.**
   - Use a Place ID known to have <3 qualifying reviews (or set
     `MOCK_EXTERNAL_APIS=true` to stub SerpAPI returning low-rating reviews).
   - Demo completes with `source='curated_fallback'`.
   - Amber banner renders: *"Sample reviews shown — connect your account…"*.

3. **Cost ceiling burn.**
   - Set `ONBOARDING_DEMO_DAILY_CENTS=20` (one demo's reservation = ceiling).
   - First demo succeeds. Second user hits `/onboarding/start` →
     `demoQueued: false, reason: 'cost_ceiling'`.
   - `/onboarding/demo` renders without a demo row → redirect to `/start`
     (or surface a "try again later" notice if Phase 2 lands that copy).

4. **Threshold alerts.**
   - With `ONBOARDING_DEMO_DAILY_CENTS=100`, run demos until the daily
     counter hits 50¢, 90¢, 100¢. Each threshold should fire **exactly
     once** to Sentry (`onboarding_demo_cost_threshold_50/90/100`).
   - Verify no spam — running another demo at 95% should NOT re-fire 50%.

5. **Per-user rate limit.**
   - From the same auth ID, hit `/start` 4 times. The 4th should return
     `demoQueued: false, reason: 'rate_limit'`.

6. **Stripe-mid-flight subscription guard.**
   - Start a demo via `/start`. Before the worker picks up the job, manually
     UPDATE `businesses` SET `subscription_status='active'` for that user.
   - Worker should mark the row `failed` with
     `generation_error='subscription_state_changed'` (NOT empty `completed`).

7. **Cleanup poller.**
   - Insert a 7-day-old `pending_payment` user with an `onboarding_demos`
     row. Trigger `runOnce` in the poller. Confirm the demo row is deleted
     (CASCADE + explicit DELETE) before users/businesses.
   - Insert a 31-day-old `completed` demo for an active user. Trigger poller.
     Confirm the stale demo is deleted but the user/business remain.

## Production rollout — phased

### Phase 0 — Migration + flag-off deploy

1. Apply migration 032 to prod via Supabase SQL editor.
2. Deploy `feat/pre-paywall-demo-pr2` with `ONBOARDING_DEMO_ENABLED=false`.
3. Smoke: existing `/onboarding/business` 3-step wizard still works
   (legacy schema + 3-step UI); `/onboarding/start` and `/onboarding/demo`
   return 404.

### Phase 1 — Code-path warm-up

1. Trigger `CleanupAbandonedSignupsPoller` once to confirm the new
   stale-demos pass + explicit `DELETE FROM onboarding_demos` execute
   cleanly against an empty table.

### Phase 2 — Per-category fallbacks (optional, before staff)

1. Run `scripts/generate-fallback-demos.ts` with prod SerpAPI quota.
2. Commit the resulting fixtures.

### Phase 3 — Staff allowlist soft-launch

1. Set `ONBOARDING_DEMO_STAFF_EMAILS_CSV='alice@repworth.com,bob@repworth.com'`.
2. Set `ONBOARDING_DEMO_ENABLED=true` (gate on staff list inside the
   `/start` route — Phase 3 work).
3. Staff dogfood for 24–48h. Watch Sentry threshold alerts + cost ledger.

### Phase 4 — General availability

1. Remove `ONBOARDING_DEMO_STAFF_EMAILS_CSV` (allowlist code path).
2. Bump `ONBOARDING_DEMO_DAILY_CENTS` to production target (`1000` = $10/day).
3. Monitor:
   - Sentry: `onboarding_demo_cost_threshold_*`, `failDemo` errors,
     `subscription_state_changed` count.
   - Postgres: `SELECT generation_status, COUNT(*) FROM onboarding_demos
     GROUP BY 1`.
   - Conversion: signup → `/start` submit → `/demo` view → `/pay` click.

## Rollback

1. `ONBOARDING_DEMO_ENABLED=false`. `/start` and `/demo` return 404 again;
   `/business` reverts to legacy 3-step wizard.
2. Existing `onboarding_demos` rows remain — they're inert without the flag.
3. The cleanup poller continues to drop them on the standard 30-day TTL.

## Known limitations (Phase 1 scope)

- Single curated fallback fixture (`general-business`) for all categories.
  Per-category fixtures land in Phase 2.
- No auto-regen on stale-revisit (>24h). The `<RegenerateButton />` covers
  the bookmark case at the cost of one click. Phase 2 follow-up.
- Staff allowlist enforcement (Phase 3) is not yet wired in `/start` —
  flag-on currently means everyone-on. Add the env-CSV check before flipping.
