# Channels — Staging Smoke Test

Hands-on verification that the Telegram + WhatsApp notification channels **and**
the auto-approved post FYI (Workstream B) actually work end-to-end on **staging**
before any production flag flip.

- **Rollout / env setup (do this first):** `docs/runbooks/channels-rollout.md`
  (env-var matrix, migration 067, BotFather/setWebhook, Meta template).
- **How to drive a test review through the real pipeline:**
  `docs/runbooks/multi-location-e2e-full-loop.md` (Zernio webhook →
  ingest → draft → notify → approve → publish).
- **Env behavior:** `.claude/reference/env-vars.md`.

> Staging is the **only** non-prod place the whole pipeline runs. Run every step
> here against staging (separate Supabase project, sandbox creds), never prod.

---

## 0. Prerequisites (must all be TRUE on staging before testing)

- [ ] `staging` deployed (push auto-deploys Railway worker + Vercel staging env).
- [ ] **Migration 067 applied to the staging Supabase project.** Verify:
  ```sql
  SELECT indexname FROM pg_indexes
   WHERE indexname IN ('idx_jo_auto_post_notice_inflight',
                       'notification_deliveries_auto_post_notice_claim');
  -- expect: BOTH rows. Without these the FYI enqueue / claim ON CONFLICT errors at runtime.
  ```
- [ ] `CHANNELS_TELEGRAM_ENABLED=true` (+ `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`)
  on Railway **and** Vercel staging; `setWebhook` pointed at the **staging** worker URL.
- [ ] (WhatsApp only) `CHANNELS_WHATSAPP_ENABLED=true` + `TWILIO_*` + `WHATSAPP_APPROVAL_TEMPLATE_SID`
  set; the Twilio sandbox/sender reachable. (FYI on WhatsApp also needs
  `WHATSAPP_AUTOPOST_TEMPLATE_SID` — leave it UNSET to test graceful degradation in T8.)
- [ ] A test **account + location (business)** on staging with an **active Zernio
  connection** and a known `account_id` / `business_id`. Capture them:
  ```sql
  SELECT b.id AS business_id, b.account_id, b.name, b.google_maps_url
  FROM businesses b WHERE b.name ILIKE '%<your test business>%';
  ```

Throughout: run SQL in the **staging** Supabase SQL editor. `APP=https://<staging-app-url>`,
`WORKER=https://<staging-worker-url>`.

---

## Part A — Channel notifications (Approve / Edit / Regenerate)

### Setup A — enroll a mobile channel for the test owner

1. In the staging dashboard → **Settings → Channels**, start a Telegram enrollment
   (and/or WhatsApp). Scan the QR / tap the deep link, send `/start <token>` (TG)
   or `start-<token>` (WhatsApp) from the test phone.
2. Verify it went `verified`:
   ```sql
   SELECT channel, status, handle, location_id, archived_at
   FROM channel_enrollments
   WHERE account_id = '<account_id>' ORDER BY created_at DESC;
   -- expect: the channel row status='verified', handle = chat_id (TG) / E.164 (WhatsApp).
   ```
   **PASS:** status `verified`. (Email is always enrolled.)

### T1 — A new review produces an approval notification

1. Drive a test review into the pipeline (Zernio webhook fire — see the full-loop
   runbook; point it at `WORKER/ingress/zernio` with the **staging** Zernio webhook
   secret). Use a **3★** review so it will NOT auto-approve (Part A tests the owner path).
2. Verify a draft + notification:
   ```sql
   SELECT r.id AS response_id, r.status, r.approval_method
   FROM responses r JOIN reviews rv ON rv.id = r.review_id
   WHERE r.business_id = '<business_id>' ORDER BY r.created_at DESC LIMIT 1;
   -- expect: status='pending_approval', approval_method NULL.

   SELECT channel, template, sent_at, failed_at, external_message_id
   FROM notification_deliveries WHERE response_id = '<response_id>';
   -- expect: a row per enrolled channel, template='approval_request', sent_at set.
   ```
   **PASS:** the approval message arrives on email + the mobile channel with
   **Approve / Regenerate** buttons and an **Edit / view full** link.

### T2 — Approve from the mobile channel → posts to Google

1. Tap **Approve** in Telegram/WhatsApp.
2. Verify:
   ```sql
   SELECT status, approval_method, posted_at FROM responses WHERE id = '<response_id>';
   -- expect: status='posted', approval_method='owner', posted_at set.
   ```
   **PASS:** the bot edits the message to "✅ Response approved — we'll post it
   shortly." and the reply appears on the Google profile.

### T3 — Regenerate → a fresh draft arrives

1. On a **new** 3★ test review, tap **Regenerate**.
2. **PASS:** the bot acks "🔄 Regenerating…", the old response goes `superseded`, a
   new `pending_approval` response + notification arrive. Confirm a second
   `responses` row for the same `review_id`.

### T4 — Edit → posts the edited text

1. On a new test review, open the **Edit / view full** link → edit the text →
   submit on the approval page.
2. **PASS:** `responses.status='posted'`, and the **edited** text is live on Google.

### T5 — Parallel-channel race (email + one mobile) → "already handled"

1. On a new test review (owner enrolled on email **and** a mobile channel), approve
   on ONE channel, then tap the OTHER channel's button / open the email link.
2. **PASS:** the second action returns "This reply was just handled on another
   channel." — **no second post** to Google (one `posted` row, siblings consumed/revoked).

### T6 — Mobile-channel exclusivity → 409

1. With a verified Telegram enrollment, try to start a WhatsApp enrollment for the
   same account-location (or vice-versa).
2. **PASS:** the second mobile enroll is rejected (409 `multiple_mobile_channels`,
   "Disconnect your current channel first"). Email + exactly one mobile is the max.

---

## Part B — Auto-approved post FYI (the new feature)

### Setup B — enable auto-approval for the test location

1. Set `AUTO_APPROVAL_ENABLED=true` on Railway + Vercel staging (+ ensure
   `PROVIDER_MODERATION_ENABLED=true`, required for auto-approval to pass moderation).
2. Configure a policy threshold for the test location (owner Settings → auto-approval,
   or directly):
   ```sql
   SELECT account_id, location_id, auto_approve_min_star
   FROM auto_approval_policies WHERE account_id = '<account_id>';
   -- expect: a row with auto_approve_min_star <= 5 (e.g. 5 = only 5★ auto-approve).
   ```

### T7 — A 5★ review auto-approves, posts, and FYIs the owner

1. Drive a **5★** test review through the pipeline (live ingest, v1).
2. Verify the auto-approval + post:
   ```sql
   SELECT id AS response_id, status, approval_method, posted_at
   FROM responses WHERE business_id = '<business_id>' ORDER BY created_at DESC LIMIT 1;
   -- expect: status='posted', approval_method='auto_policy' (NO owner action). Capture response_id.
   ```
3. Verify the FYI fired (one outbox row + a delivery per free-form channel):
   ```sql
   SELECT topic, status FROM job_outbox
   WHERE topic='auto_post_notice' AND aggregate_id='<response_id>';
   -- expect: one row (status completed/dispatched).

   SELECT channel, template, sent_at, failed_at
   FROM notification_deliveries
   WHERE response_id='<response_id>' AND template='auto_post_notice';
   -- expect: email + telegram rows with sent_at set (NO approval_request row was created for an auto post).
   ```
   **PASS:** the owner receives **"✅ Auto-approved reply posted"** on email +
   Telegram with a **View on Google** button — and **no** Approve/Regenerate buttons
   (the post already happened). Owner did nothing.

### T7b — "View on Google" redirect works

1. Click **View on Google** (or hit `APP/r/google/<response_id>` directly).
2. **PASS:** 302 → the business's Google Maps profile (`businesses.google_maps_url`).
   If that column is NULL for the test business, you get the **"Link unavailable"**
   page (not an error, not an open redirect) — that's correct degradation.

### T8 — WhatsApp FYI degrades gracefully when its template SID is unset

1. With `WHATSAPP_AUTOPOST_TEMPLATE_SID` **unset** and the owner on WhatsApp, run a
   5★ auto-approval (as T7).
2. **PASS:** email + Telegram FYIs still send; WhatsApp is **skipped** (no failed
   delivery row, no enrollment flip, no job failure). Worker log:
   `auto_post_notice skipped channel=whatsapp reason=template_unset`.

### T9 — Owner-approved posts do NOT get an FYI

1. Confirm the owner path (T2) produced **no** `auto_post_notice` delivery:
   ```sql
   SELECT count(*) FROM notification_deliveries
   WHERE response_id='<owner_approved_response_id>' AND template='auto_post_notice';
   -- expect: 0. The owner clicked Approve; they already know.
   ```
   **PASS:** count = 0.

---

## Sign-off checklist

| # | Check | Pass |
|---|---|---|
| 0 | Migration 067 present (both indexes) | ☐ |
| A | Mobile channel enrolls → `verified` | ☐ |
| T1 | New review → approval notification on each channel | ☐ |
| T2 | Approve → `posted` + live on Google | ☐ |
| T3 | Regenerate → fresh draft | ☐ |
| T4 | Edit → edited text posted | ☐ |
| T5 | Parallel race → "already handled", no double-post | ☐ |
| T6 | 2nd mobile enroll → 409 | ☐ |
| T7 | 5★ → `auto_policy` posted + FYI on email/Telegram | ☐ |
| T7b | View-on-Google redirect (or unavailable page on null) | ☐ |
| T8 | WhatsApp FYI skips cleanly when SID unset | ☐ |
| T9 | Owner-approved post → no FYI | ☐ |

All green on staging ⇒ proceed to the prod flip per `channels-rollout.md`
(Telegram first; WhatsApp after its Meta template clears).

---

## Cleanup / rollback (staging)

- To stop notifications mid-test: flip `CHANNELS_TELEGRAM_ENABLED` /
  `CHANNELS_WHATSAPP_ENABLED` back to `false` and redeploy.
- To stop auto-approval: set `AUTO_APPROVAL_ENABLED=false` (any unposted
  `auto_policy` rows get downgraded to owner review by `ResponsePublisherWorker`).
- Disconnect a test channel from Settings → Channels (or set the enrollment
  `status='disabled'`). Migration 067 is additive — nothing to roll back.
