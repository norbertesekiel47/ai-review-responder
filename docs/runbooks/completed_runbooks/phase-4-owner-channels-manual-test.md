# Phase 4 — Owner Channel Dashboard: Manual Test Runbook

**Purpose:** End-to-end verification of the `/settings/channels` flow before merging PR #10 to `main` and before flipping `CHANNELS_TELEGRAM_ENABLED=true` in prod.

**Scope:** Owner-facing self-serve Telegram enrollment + admin regression. SMS and WhatsApp are out of scope for this phase (they render as Coming Soon rows; their enrollment flows are unchanged from Phase 1 / 3).

**Estimated time:** 25–40 minutes for a full pass.

---

## 0. Prerequisites

You can run this against either **staging** (recommended for the final pre-flag-flip pass) or a **local dev environment** with a real `@RepWorthBot` (recommended for the pre-merge sanity check).

### Required environment variables

```env
# The flag this phase ships behind
CHANNELS_TELEGRAM_ENABLED=true

# Telegram bot — REAL bot, not mock
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_WEBHOOK_SECRET=<32+ byte random string, must match setWebhook>
TELEGRAM_BOT_USERNAME=RepWorthBot         # default; override only if using a non-prod bot

# Worker public URL — must be reachable from Telegram's servers (ngrok http 3001 OR  cloudflared tunnel --url http://localhost:3001)
WORKER_PUBLIC_URL=https://<your-railway-or-ngrok-url>

# Standard Supabase + DB env (you already have these)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
DATABASE_URL=...
DATABASE_POOL_URL=...

# Make sure mock mode is OFF — we need real Telegram + real DB
MOCK_EXTERNAL_APIS=false
```

### Required setup

1. **Migration 027 applied** to the target Supabase project. Verify:

   ```sql
   SELECT indexname FROM pg_indexes
   WHERE indexname = 'channel_enrollments_one_mobile_per_biz';
   ```

   Expect: 1 row.

2. **Telegram webhook registered** pointing at the worker:

   ```bash
   curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=${WORKER_PUBLIC_URL}/ingress/telegram" \
     -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"

   curl -X POST "https://api.telegram.org/bot8387900307:AAG4FryTTeihSy_rrj6dUme3s6gzAZVoGBw/setWebhook" -d "url=https://injuries-presentations-succeed-clear.trycloudflare.com/ingress/telegram" -d "secret_token=9b785e409bc1e2440c972b4a51f893ddb609a8520ea5bbe3df8b21419b815b37"
   ```

   Expect: `{"ok":true,"result":true,"description":"Webhook was set"}`. Verify with `getWebhookInfo`.

3. **Test owner account** — a `users` row with `role='owner'`, `business_id` pointing at a `subscription_status='active'` business. Note the email so you can sign in.

4. **Worker running** (`pnpm worker` locally, or staging worker is up).

5. **Next.js running** (`pnpm dev` locally, or staging Vercel deploy is up).

6. **Telegram app** open on your phone and signed in. You'll need to scan the QR or open the deep link.

7. **Browser session** signed in as the test owner (`/admin/login` → enter owner credentials → land on `/dashboard`).

---

## 1. Smoke test — page renders correctly

| #   | Step                                                    | Expected                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Navigate to `/settings`                                 | Page renders. Tab strip at top shows "General" (active, cyan underline) and "Notification channels" (inactive, grey). Existing settings form renders below.                                                                                                                                               |
| 1.2 | Click the "Notification channels" tab                   | URL changes to `/settings/channels`. Tab "Notification channels" becomes active.                                                                                                                                                                                                                          |
| 1.3 | Inspect the rendered rows                               | 4 rows in this order: **Email** (with your email + green "Always on" pill), **Telegram** (with Connect button if no existing enrollment), **SMS** (Coming Soon, no button, ~50% opacity), **WhatsApp** (Coming Soon, no button, ~50% opacity).                                                            |
| 1.4 | Click the "General" tab                                 | URL returns to `/settings`. Tab strip flips back.                                                                                                                                                                                                                                                         |
| 1.5 | Open DevTools Network tab. Reload `/settings/channels`. | A single `GET /api/dashboard/channels` request fires. Response body has shape `{ enrollments: [...], available: { telegram: true, sms: false, whatsapp: false }, reasons: {...} }`. Response header `Cache-Control: no-store, private`. Response body MUST NOT contain a `verification_token_hash` field. |

**Pass criteria:** All 5 sub-steps render correctly and the network response is well-formed.

---

## 2. Connect flow — happy path

This is the most important scenario. It exercises the full state machine: idle → generating → awaiting_scan → verified.

| #   | Step                                                                                                                                                                                                                         | Expected                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | On `/settings/channels`, click **Connect** in the Telegram row                                                                                                                                                               | Button briefly shows "Generating link…" then page renders a QR code (200×200 px), a `https://t.me/RepWorthBot?start=...` deep link below it, an "Expires in 59m 59s" countdown that ticks down each second, and a Cancel button.                                                                               |
| 2.2 | Open DevTools Network tab. Inspect the `POST /api/dashboard/channels/telegram/start` request.                                                                                                                                | Status 200. Response has `{ deepLink, qrDataUrl, expiresAt }`. `Cache-Control: no-store, private` header present. **No** `verification_token_hash` in body. The QR `data:` URL starts with `data:image/png;base64,`.                                                                                           |
| 2.3 | Run this in Supabase SQL editor: `SELECT status, verification_token_hash IS NOT NULL AS has_hash, verification_token_expires_at FROM channel_enrollments WHERE business_id = '<test-business-id>' AND channel = 'telegram';` | One row. `status = 'pending_verification'`, `has_hash = true`, `verification_token_expires_at` is roughly NOW() + 1 hour.                                                                                                                                                                                      |
| 2.4 | On your phone, open Telegram and scan the QR (or click the deep link if your phone is on this browser session).                                                                                                              | Telegram app opens a chat with `@RepWorthBot`. A blue "START" button appears at the bottom.                                                                                                                                                                                                                    |
| 2.5 | Tap **START** in Telegram.                                                                                                                                                                                                   | Bot replies with a confirmation message ("✅ You're connected to RepWorth..." or similar). Within 3–6 seconds, the browser page polls and flips the Telegram row to ✓ Connected · ••• 1234 (last 4 digits of your Telegram chat ID). The Cancel/QR section disappears. A Disconnect button appears in the row. |
| 2.6 | Re-run the SQL query from 2.3                                                                                                                                                                                                | One row. `status = 'verified'`, `has_hash = false` (token was cleared on verification), `handle = '<your chat ID>'`.                                                                                                                                                                                           |
| 2.7 | DevTools — open the Network tab and observe polling                                                                                                                                                                          | `GET /api/dashboard/channels` requests fire roughly every 3 seconds while in `awaiting_scan` state. Polling stops as soon as the row flips to `verified`.                                                                                                                                                      |

**Pass criteria:** Browser flips to ✓ Connected within 10 seconds of the Telegram tap. SQL row reflects the verified state. No errors in browser or worker logs.

---

## 3. Disconnect flow

| #   | Step                                                                       | Expected                                                                              |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 3.1 | On the verified Telegram row, click **Disconnect**                         | Browser shows a `confirm()` dialog: "Disconnect Telegram from RepWorth?"              |
| 3.2 | Click **OK** to confirm                                                    | Within ~1 second, the row flips back to its idle state with the Connect button shown. |
| 3.3 | DevTools Network — inspect `POST /api/dashboard/channels/telegram/disable` | Status 200. `Cache-Control: no-store, private` header.                                |
| 3.4 | Re-run the SQL query from 2.3                                              | `status = 'disabled'`, `handle = NULL`, `disabled_at` is roughly NOW().               |

**Pass criteria:** UI flips to idle, DB row goes to `disabled` with `disabled_at` set.

---

## 4. Cancel flow (token expiry path)

This validates that cancelling a pending QR scan correctly releases the migration 027 mobile slot — the most important hardening fix from the review.

| #   | Step                                                                                                                                                                           | Expected                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 4.1 | On the disabled (or freshly `idle`) Telegram row, click **Connect** again                                                                                                      | QR + deep link render. State is `awaiting_scan`.                                                 |
| 4.2 | Click **Cancel** without scanning                                                                                                                                              | Row flips back to idle. Connect button reappears.                                                |
| 4.3 | Run: `SELECT status, verification_token_hash IS NOT NULL AS has_hash, disabled_at FROM channel_enrollments WHERE business_id = '<test-business-id>' AND channel = 'telegram';` | `status = 'disabled'` (NOT `pending_verification`!), `has_hash = false`, `disabled_at` is NOW(). |
| 4.4 | Run the migration 027 audit query from `docs/superpowers/plans/2026-04-28-phase-4-owner-channel-dashboard-plan.md` Task 0.1                                                    | Returns 0 rows for this business — the cancelled row is no longer in the index predicate.        |

**Pass criteria:** Cancel flips status to `disabled` (not just clearing the token). This is the Critical fix #1 from the Codex review.

---

## 5. Reconnect after disable

| #   | Step                                                   | Expected                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 | After step 4 (status is `disabled`), click **Connect** | Fresh QR + deep link. Row state goes idle → generating → awaiting_scan.                                                                                                                                                              |
| 5.2 | Run the SQL query from 2.3                             | `status = 'pending_verification'`, fresh `verification_token_hash`, fresh `verification_token_expires_at`. The same row was reused — no INSERT, just an UPDATE. (You can verify by SELECTing `id` from before and after; same UUID.) |
| 5.3 | Scan QR + tap START in Telegram                        | Row flips to verified within 3–6 seconds (same as step 2.5).                                                                                                                                                                         |

**Pass criteria:** Disable → Connect → Verify round-trip works without DB row churn. The same row transitions disabled → pending → verified.

---

## 6. TTL expiry

| #   | Step                                                                                                                                    | Expected                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 6.1 | Disconnect or get to `idle` state. Click **Connect**.                                                                                   | QR + deep link + countdown render.                                          |
| 6.2 | Wait for the countdown to reach 0 (or fast-forward by editing `verification_token_expires_at` directly in Supabase to a past timestamp) | UI flips to "Verification link expired." with a "Generate new link" button. |
| 6.3 | If you fast-forwarded via SQL, also delete the row to reset, then click **Generate new link**                                           | Fresh QR + countdown.                                                       |

**Pass criteria:** Expired QR is replaced with a clear error state and a fresh-start button. (Skip this whole section in a hurry — it's a visual sanity check, not a correctness scenario.)

---

## 7. Subscription guard

This validates the defense-in-depth subscription check on both the page and the API.

| #   | Step                                                                                                              | Expected                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | In Supabase SQL editor: `UPDATE businesses SET subscription_status = 'past_due' WHERE id = '<test-business-id>';` | 1 row updated.                                                                                                                                      |
| 7.2 | Reload `/settings/channels` in the owner browser                                                                  | Browser redirects to `/onboarding/pay`. The channels page never renders.                                                                            |
| 7.3 | If you have curl handy and a stored session cookie, hit `GET /api/dashboard/channels` directly                    | Status 403 with body `{ "error": "subscription_not_active" }`. (You can also test with `POST /api/dashboard/channels/telegram/start`; same result.) |
| 7.4 | Restore: `UPDATE businesses SET subscription_status = 'active' WHERE id = '<test-business-id>';`                  | 1 row updated. Reload `/settings/channels` — page renders again.                                                                                    |

**Pass criteria:** Both the page server component AND every owner route reject non-active subscriptions.

---

## 8. Cross-tab race (advanced — optional)

This validates the `mobile_enroll` advisory lock from hardening Fix #7. Skip if you're short on time; the unit tests already cover the lock contents.

| #   | Step                                                                                                                                                              | Expected                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.1 | Open `/settings/channels` in two browser tabs as the same owner. Tab A and Tab B.                                                                                 | Both tabs show identical state.                                                                                                                                                                                                                        |
| 8.2 | In Tab A, click **Connect**. While Tab A is in `awaiting_scan` (showing QR), in Tab B click **Connect**.                                                          | Tab B should NOT flash an error. The owner routes' state-machine helper handles `pending_verification → pending_verification` as a fresh-token UPDATE — Tab B gets a NEW QR with a fresh token. Tab A's polling will eventually pick up the new state. |
| 8.3 | Verify only one row exists: `SELECT COUNT(*) FROM channel_enrollments WHERE business_id = '<test-business-id>' AND channel = 'telegram' AND archived_at IS NULL;` | Returns 1.                                                                                                                                                                                                                                             |

**Pass criteria:** No 23505 errors, exactly one row per business per channel.

---

## 9. Admin-side regression

The admin Telegram + WhatsApp widgets were refactored to consume the same `useEnrollment` hook. This validates they still behave identically to pre-Phase-4.

| #   | Step                                                                                    | Expected                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | Sign out as owner. Sign in as admin. Navigate to `/admin/businesses/<test-business-id>` | Business detail page renders. The "Channels" section shows the Telegram widget + (if WhatsApp env is configured) WhatsApp widget + (if SMS env is configured) SMS widget. |
| 9.2 | Inspect the Telegram widget when it's in the verified state from step 2                 | Idle: Connect button. Verified: ✅ Connected — Telegram chat ••• 1234 + Disable button. Visual layout unchanged from before the Phase 4 refactor.                         |
| 9.3 | Click **Disable** (admin's name for Disconnect). Confirm.                               | Row flips to "Disabled" with a Reconnect button.                                                                                                                          |
| 9.4 | Click **Connect** in the admin widget                                                   | QR + deep link + countdown render in the admin widget. Cancel + Refresh status buttons appear.                                                                            |
| 9.5 | Click **Cancel** (admin)                                                                | Widget returns to disabled state.                                                                                                                                         |

**Pass criteria:** The admin widget's UX is functionally identical to the pre-Phase-4 behavior. Visual layout is unchanged.

---

## 10. Worker logs sanity check

After running scenarios 1–9, check the worker logs for any unexpected errors.

| Pattern to grep for                    | Acceptable count                                                      | Meaning                                                         |
| -------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `enrollment db error`                  | 0                                                                     | An unexpected 23505 hit `EnrollmentDatabaseError`. Investigate. |
| `multiple_mobile_channels`             | 0 in normal flow; > 0 only if you manually inserted a conflicting row | Migration 027 fired correctly.                                  |
| `Telegram webhook` errors              | 0                                                                     | Webhook secret mismatch or payload-shape issue.                 |
| `pg_advisory_xact_lock` slow / timeout | 0                                                                     | Lock contention. Should be near-instant on a single-user test.  |

---

## Sign-off table

Fill this in before flipping `CHANNELS_TELEGRAM_ENABLED=true` in prod.

| Scenario                       | Pass? | Notes |
| ------------------------------ | ----- | ----- |
| 1. Page renders                | ✅ PASS | 4 rows render correctly (Email/Telegram/SMS coming soon/WhatsApp coming soon). API returns correct shape, Cache-Control: no-store. No token hash in response. |
| 2. Connect happy path          | ✅ PASS | QR + deep link + countdown render. POST 200. DB flips to pending_verification with hash. Bot acked START, browser flipped to ✓ Connected ••• 5018 within polling cycle. Polling stopped after verified. Token cleared in DB. |
| 3. Disconnect                  | ✅ PASS | confirm() dialog fires. POST /disable 200. UI flips to disabled state. DB: status=disabled, handle=null, disabled_at set. Minor: button label is "Reconnect" (not "Connect") — cosmetic only. |
| 4. Cancel releases mobile slot | ✅ PASS | Cancel flips status to disabled (not pending_verification). Token cleared. Migration 027 audit returns 0 rows — slot fully released. Critical fix #1 confirmed. |
| 5. Reconnect after disable     | ✅ PASS | Fresh QR generated. Single row reused (UPDATE not INSERT). Same row transitions disabled→pending→verified after START tap. |
| 6. TTL expiry (optional)       | ⏭ SKIPPED | Skipped per runbook (optional). |
| 7. Subscription guard          | ✅ PASS | Page redirects away from /settings/channels on non-active subscription. Chain: /settings/channels → /onboarding/pay → /dashboard. The pay page's own guard (`src/app/onboarding/pay/page.tsx:81`) bounces past_due/cancelled owners to /dashboard regardless of `SELF_SERVE_SIGNUP_ENABLED` — the picker would otherwise create a duplicate Stripe subscription. API returns 403 `{"error":"subscription_not_active"}` confirmed independently of the flag. |
| 8. Cross-tab race (optional)   | ⏭ SKIPPED | Skipped per runbook (optional; unit tests cover lock). |
| 9. Admin-side regression       | ✅ PASS | Admin page renders Channels table + Telegram enrollment widget. Verified state shows ✅ Connected ••• 5018 + Disable button (after hydration). Disable→confirm dialog→Disabled state. Reconnect→QR+countdown+Cancel+Refresh status. Cancel returns to Connect. All states correct. |
| 10. Worker logs clean          | ⏭ NOT CHECKED | Run manually: grep worker logs for enrollment db error / multiple_mobile_channels / Telegram webhook errors. |

**Tester:** Claude Code (automated via Playwright MCP + Supabase MCP)
**Date:** 2026-04-29
**Environment:** ☑ local-dev ☐ staging ☐ prod

---

## What to do if something fails

| Symptom                                                                         | Likely cause                                                                                               | Fix                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page redirects to `/admin/login` even when signed in                            | Owner session expired, or `auth_id` doesn't match the test owner's user row                                | Re-sign-in. Verify `users.auth_id` matches `auth.users.id` for the owner.                                                                                                                                                |
| Page redirects to `/onboarding/pay`                                             | `subscription_status` is not `'active'`                                                                    | `UPDATE businesses SET subscription_status='active' WHERE id='<biz-id>';`                                                                                                                                                |
| Connect button does nothing                                                     | Open DevTools Console — likely a 401 on `/api/dashboard/channels` (session expired) or 503 (env not ready) | Re-sign-in OR confirm `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` are set on the worker                                                                                                                             |
| QR scan → "✅ connected" in Telegram, but browser stays on QR page indefinitely | Webhook is reaching Telegram but NOT reaching the worker. Or webhook secret mismatch.                      | `curl https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo` — check `last_error_message`. Verify `TELEGRAM_WEBHOOK_SECRET` matches what was passed to `setWebhook`.                                          |
| 409 `multiple_mobile_channels` on Connect                                       | Another mobile channel is already pending/verified for this business                                       | `SELECT * FROM channel_enrollments WHERE business_id=... AND channel IN ('sms','whatsapp') AND status IN ('pending_verification','verified') AND archived_at IS NULL;` to find the conflicting row. Disable it manually. |
| Connect button shows for verified row briefly before flipping to ✓ Connected    | This is the bug Fix #3 was supposed to solve. The widget should hydrate from `initialEnrollments`.         | Confirm the widget receives the `initialEnrollment` prop from `ChannelsClient`. Check git: `git log --oneline -- src/components/dashboard/OwnerTelegramWidget.tsx`. Should include commit `9d6e8eb`.                     |
| Tests `pnpm test` fail                                                          | Run `pnpm test 2>&1 \| tail -50` — investigate the specific failure                                        | Don't proceed with the manual test until tests are green.                                                                                                                                                                |

---

## Reference

- **PR:** https://github.com/norbertesekiel47/ai-review-responder/pull/10
- **Plan:** `docs/superpowers/plans/2026-04-28-phase-4-owner-channel-dashboard-plan.md`
- **Spec:** `docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md`
- **Migration:** `supabase/migrations/027_one_mobile_channel_per_business.sql`
- **Detailed progress notes:** `docs/progresstracking.md` § Sprint Channels-4
- **Plain-English summary:** `docs/currents.md` § Channels Phase 4
