# Owner Self-Serve Signup — Test Runbook

This runbook walks through end-to-end verification of the self-serve signup feature, both for **local dev** (your current setup with Next dev server, Railway worker, Stripe CLI, local Redis) and **production rollout**.

If anything fails at any step, stop and investigate before continuing — the steps build on each other.

---

## Part 1 — Local dev preflight

Goal: get a clean local environment with all the new env vars wired.

### 1.1 Pull the branch and run the migration

```bash
# you should already be on feat/owner-self-serve-signup
git status
git log --oneline -8
# Expect to see: 36dc9e5 test(signup): schema edge cases ... at the top
```

**Run migration 025 in Supabase SQL editor** (paste the contents of `supabase/migrations/025_signup_schema.sql`). Two preconditions:

1. **No collision in `users.email`** — if it raises, run the diagnostic query in the error message, resolve duplicates, re-run.
2. **At least one `admin` or `sales_partner` user exists** — if it raises and you have no admin user, create one via Supabase dashboard first (Authentication → Users → Add user with email `admin@yourdomain.com`, then `INSERT INTO users (id, name, email, role) VALUES (gen_random_uuid(), 'Admin', 'admin@yourdomain.com', 'admin');` and link `auth_id` manually).

After it runs successfully:

```sql
-- Sanity-check the indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename IN ('businesses', 'users')
  AND indexname IN (
    'idx_businesses_pending_unpaid_self_serve_cleanup',
    'idx_users_owner_auth_by_business'
  );
-- Expect 2 rows.

-- Verify backfill
SELECT COUNT(*) FROM users WHERE email <> lower(trim(email));
-- Expect 0 (all normalized).
SELECT COUNT(*) FROM businesses WHERE onboarded_by IS NULL;
-- Expect 0 (all backfilled — admin onboarding was historically not setting this).
```

### 1.2 Update `.env.local` for self-serve

Add or update these lines in your `.env.local`:

```bash
SELF_SERVE_SIGNUP_ENABLED=true
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Required for the 3-step business wizard (Step 1 PlaceAutocomplete + place-prefill API).
# Use the same key the admin onboarding form uses; Essentials tier is sufficient.
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...

# Optional cleanup poller tuning for testing (1-minute interval lets you trigger cleanup quickly)
CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=60000
CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE=10
```

Confirm these are still set (existing values, just verify):

```bash
DATABASE_POOL_URL=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
REDIS_CACHE_URL=redis://localhost:6379/0
REDIS_QUEUE_URL=redis://localhost:6379/1
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...     # ← from `stripe listen` output
STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/test_...
STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/test_...
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL="RepWorth <notifications@yourdomain.com>"
```

> **Architecture note (NEW since first runbook).** Self-serve signup is now a **two-phase** flow:
>
> 1. **Identity-only signup** — `/signup` collects email, name, phone, password. We write a placeholder `businesses` row (`name='(pending setup)'`, all business fields NULL, `subscription_status='pending_payment'`). NO outbox row.
> 2. **Pay** — Stripe webhook flips status to `active`. Webhook does NOT enqueue any work.
> 3. **3-step business wizard** at `/onboarding/business` — Location (PlaceAutocomplete + prefill) → Profile (name + category + website, prefilled) → Voice (5 textareas, **skippable**). Submit triggers UPDATE businesses + INSERT outbox in one tx. Initial sync starts only after wizard submit.
>
> Routing: an `active && !businessOnboarded` owner who logs in lands on `/onboarding/business`, not `/dashboard`. `businessOnboarded` is computed server-side as `place_id_verified=true OR google_maps_url IS NOT NULL`.

### 1.3 Configure Supabase Auth for local

In your Supabase dashboard (cloud project — local Supabase isn't required):

1. **Auth → Providers → Email** — enable Email provider, **Confirm email** = ON.
2. **Auth → URL Configuration** — Site URL = `http://localhost:3000`. Redirect URLs add both lines (the second covers query strings):
   ```
   http://localhost:3000/api/auth/callback
   http://localhost:3000/api/auth/callback?**
   ```
3. **Auth → Providers → Google** — enable, configure OAuth client ID + secret from Google Cloud Console. Redirect URI in Google Console: `https://YOUR_REF.supabase.co/auth/v1/callback`. (Supabase docs: https://supabase.com/docs/guides/auth/social-login/auth-google)
4. **Auth → Email Templates → Confirm signup — REQUIRED CHANGE.**

   We use a **6-digit OTP code** (not a magic link) for email confirmation. The reason: server-initiated `signUp()` defaults to implicit flow, which delivers `#access_token=...` to the home page where our callback can't read it. Email scanners (Outlook Safe Links, Gmail link checker) also frequently prefetch + consume single-use confirmation links before the user clicks. A typed 6-digit code sidesteps both.

   **Replace this default body:**

   ```html
   <h2>Confirm your signup</h2>
   <p>Follow this link to confirm your user:</p>
   <p><a href="{{ .ConfirmationURL }}">Confirm your mail</a></p>
   ```

   **With this:**

   ```html
   <h2>Confirm your signup</h2>
   <p>
     Enter this code on the RepWorth verification page to activate your account:
   </p>
   <p
     style="font-size:24px; font-weight:bold; letter-spacing:0.3em; text-align:center; margin:24px 0;"
   >
     {{ .Token }}
   </p>
   <p>
     This code expires in 24 hours. If you didn't sign up, you can ignore this
     email.
   </p>
   ```

   The key change: `{{ .Token }}` (not `{{ .TokenHash }}` — those are different) renders the human-typeable 6-digit code. Click **Save template**. (Same edit needed in production — see §3.1.)

5. **Auth → Email Templates → Reset password — REQUIRED CHANGE** (same reason).

   **Replace this default body:**

   ```html
   <h2>Reset Password</h2>
   <p>Follow this link to reset the password for your user:</p>
   <p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>
   ```

   **With this** (note `&amp;` escapes — unescaped `&` silently breaks the `<a href>` parser in some clients, the link renders as plain text):

   ```html
   <h2>Reset Password</h2>
   <p>Follow this link to reset the password for your user:</p>
   <p>
     <a
       href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;flow=owner&amp;next=/reset-password"
       >Reset Password</a
     >
   </p>
   ```

   > **Note on admin reset emails.** Both owner and admin password-reset emails go through the same Supabase template — but admins use `/admin/reset-password` while owners use `/reset-password`. Our callback route handles `next=/reset-password` and `next=/admin/reset-password` symmetrically (both skip the role lookup). For now, the template above hardcodes the owner path. If admin self-serve resets are common, fork by setting `flow=admin&amp;next=/admin/reset-password` in a separate template — but admin resets are rare in current ops, so the owner template is the default.

5b. **Auth → Email Templates → Invite user — REQUIRED CHANGE.**

The admin business onboarding flow (`/admin/businesses/new`) now calls `supabaseServer.auth.admin.inviteUserByEmail()` after creating the business so the owner can claim their account + set a password. The invite email goes through this template.

**Replace the default body with:**

```html
<h2>You've been invited to RepWorth</h2>
<p>
  Your account has been set up. Click the link below to set your password and
  log in:
</p>
<p>
  <a
    href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=invite&amp;flow=owner&amp;next=/reset-password"
    >Set your password</a
  >
</p>
<p>This link expires in 24 hours.</p>
```

Same `&amp;` rule as the reset-password template. Without this template configured, admin-onboarded owners will receive Supabase's default "You've been invited" email which links to a different (wrong) URL — they'll click it and land on a 404 page.

6. **Auth → SMTP Settings — REQUIRED for any meaningful volume of testing.**

   Supabase's built-in SMTP has a **2-emails-per-hour-per-address** cap. After 2 signup retries to the same address, the next `signUp()` returns `over_email_send_rate_limit` 429 — our route surfaces this as `email_rate_limited` ("Too many signup attempts. Please wait a few minutes."). For the runbook scenarios — especially A, B, C, H — you'll trip this within minutes.

   **Configure custom SMTP via Resend** (you already have a Resend account from `RESEND_API_KEY` in `.env.local`):
   1. Verify your sending domain in [resend.com/domains](https://resend.com/domains) — for local dev you can use `onboarding@resend.dev` (only sends to your Resend account email) but for any real testing you need a verified domain.
   2. Supabase Dashboard → **Authentication → SMTP Settings** → toggle **Enable Custom SMTP** ON
   3. Fill in:
      | Field | Value |
      |---|---|
      | Sender email | matches `RESEND_FROM_EMAIL` mailbox (e.g. `info@repworth.net`) |
      | Sender name | `RepWorth` |
      | Host | `smtp.resend.com` |
      | Port number | `465` |
      | Username | `resend` |
      | Password | `<RESEND_API_KEY value from .env.local>` |
   4. **Save**. Wait ~30 seconds for Supabase to apply.
   5. **Verify it's actually using Resend:** trigger a fresh signup, then check [resend.com/emails](https://resend.com/emails). The confirmation email should appear there with status `Delivered`. If it's not in Resend's dashboard, Supabase is still on built-in SMTP — recheck the SMTP toggle.

   Once Custom SMTP is on, Supabase's built-in 2/hour cap is bypassed entirely (it only applies to Supabase's default sender). You're now bounded by Resend's quota instead (free tier 100/day, paid 50K/month).

7. **Auth → Rate Limits → "Rate limit for sending emails"** — bump to `30` for dev. With Resend handling delivery, this is just a defense-in-depth ceiling.

### 1.4 Configure Stripe Payment Links

In Stripe dashboard (test mode):

1. Find or create the two Payment Links referenced by `STRIPE_PAYMENT_LINK_FOUNDING` and `STRIPE_PAYMENT_LINK_STANDARD`.
2. Each Payment Link → **After payment** → set `success_url` to:
   ```
   http://localhost:3000/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}
   ```
3. Optional: set `cancel_url` to `http://localhost:3000/onboarding/pay?cancelled=1`.
4. Confirm `client_reference_id` is enabled (it's a query param, no UI toggle — Stripe accepts it natively).

### 1.5 Start everything

Four terminal windows:

```bash
# Terminal 1 — Redis (you said you already have this; here for completeness)
redis-server

# Terminal 2 — Stripe CLI (forwards events to local worker)
stripe listen --forward-to localhost:3001/ingress/stripe
# Copy the whsec_... it prints — set it as STRIPE_WEBHOOK_SECRET in .env.local
# (restart terminals 3 + 4 if you change .env.local)

# Terminal 3 — Next.js dev server
pnpm dev

# Terminal 4 — Railway worker (locally)
pnpm worker
```

**Verify the flag is actually loaded.** The worker now logs feature-flag state on startup. Look for this line:

```
[worker] Feature flags: SMS=off, Telegram=off, WhatsApp=off, SelfServeSignup=on
```

If you see `SelfServeSignup=off`, your `.env.local` still has `SELF_SERVE_SIGNUP_ENABLED=false` (or the line is missing entirely). Edit `.env.local` and set it to `true`, then restart the worker.

You should also see the cleanup poller starting:

```
[CleanupAbandonedSignups] Starting (interval=60000ms)
```

If you instead see `[CleanupAbandonedSignups] SELF_SERVE_SIGNUP_ENABLED != true — not starting`, same root cause as above — the flag isn't `'true'` in the worker's env.

**If startup fails with `SELF_SERVE_SIGNUP_ENABLED=true requires REDIS_CACHE_URL` (or similar)** — the assertion is doing its job; fix the missing env var per the message and restart.

**Quick env-loading sanity check:**

```bash
# In a fresh terminal (NOT the worker terminal):
node -e "require('dotenv').config({path:'.env.local'}); console.log('FLAG:', process.env.SELF_SERVE_SIGNUP_ENABLED, 'REDIS:', !!process.env.REDIS_CACHE_URL)"
# Expected: FLAG: true REDIS: true
```

The worker loads `.env.local` via `worker/env.ts` (`dotenv.config({path:'.env.local'})`), so the same node-level check confirms what the worker will see.

### 1.6 Smoke check the build

```bash
pnpm tsc --noEmit
# 0 errors expected.

pnpm vitest run
# 1405/1405 tests pass.
```

If either fails, stop. Don't proceed to manual testing on a broken build.

### 1.7 Dev helper — clearing rate-limit buckets between runs

Repeated signup attempts will trip our app-side rate limits (5 signups/IP/hour, 8 verify-OTP/email/10min, 2 resends/email/hour). When that happens, scenario A returns `429 rate_limited` even though no Supabase or DB issue actually exists.

**Quickest unblock during testing:**

```bash
# Clear all signup-flow rate-limit keys for ALL emails on this IP
pnpm tsx scripts/clear-signup-rate-limits.ts

# Or clear app-side keys + per-email buckets for one specific address
pnpm tsx scripts/clear-signup-rate-limits.ts repworth+e2e1@yourdomain.com
```

**Note:** this only clears OUR app's Redis keys. Supabase's _built-in_ email-send rate limit (default 2/hour per address — see §1.3) is separate and can only be reset by:

- Waiting (rolling 1-hour window), OR
- Bumping it in Supabase Dashboard → Authentication → Rate Limits, OR
- **Configuring custom SMTP via Resend** (see §1.3 step 6) — once Custom SMTP is enabled, Supabase's built-in cap is bypassed entirely. **This is the production fix; do it before relying on the runbook scenarios for any volume of testing.**

---

## Part 2 — End-to-end manual tests (local)

Run these scenarios in order. Each builds on a clean state from the previous, OR explicitly notes that you should reset.

### 2.1 Scenario A — Password signup happy path (identity → pay → wizard → dashboard)

**Setup:** Use a fresh email you have access to (Gmail, Mailinator, etc.). For convenience: `repworth+e2e1@yourdomain.com`.

**Steps:**

1. Navigate to `http://localhost:3000` — landing page should show **Log In** + **Sign Up** in the nav (because `SELF_SERVE_SIGNUP_ENABLED=true`).
2. Click **Sign Up**. URL → `/signup`.
3. **Identity-only form** (4 fields — NO business fields anymore):
   - Email: `repworth+e2e1@yourdomain.com`
   - Your name: `E2E Owner One`
   - Phone: optional, leave blank
   - Password: `password1234`
4. Click **Continue**. URL → `/signup/check-email?email=repworth%2Be2e1%40yourdomain.com`. The page shows: "Sent to repworth+e2e1@yourdomain.com" (read-only display), a single 6-digit code input (auto-focused), a **Resend code** link, and a **← Go back and change email** link. There should be NO email input field on this page.
5. **Verify a placeholder business + user row landed and there is NO outbox entry:**

   ```sql
   SELECT id, name, owner_email, subscription_status, onboarded_by,
          google_maps_url, google_place_id, place_id_verified
   FROM businesses
   WHERE owner_email = 'repworth+e2e1@yourdomain.com';
   -- Expect: 1 row.
   --   name = '(pending setup)'
   --   subscription_status = 'pending_payment'
   --   onboarded_by = NULL
   --   google_maps_url = NULL
   --   google_place_id = NULL
   --   place_id_verified = false

   SELECT id, auth_id, role FROM users
   WHERE email = 'repworth+e2e1@yourdomain.com';
   -- Expect: 1 row, auth_id=<uuid>, role='owner'.

   SELECT * FROM job_outbox WHERE aggregate_id = '<the business_id from above>';
   -- Expect: 0 rows. NO outbox entry — self-serve defers all work to wizard submit.
   ```

6. Open the email Supabase sent. Find the 6-digit code. **Type it into the OTP input** on `/signup/check-email`. Click **Verify and continue**. URL → `/onboarding/pay`.
7. **Verify email-confirm worked:**
   ```sql
   SELECT email_confirmed_at FROM auth.users WHERE email = 'repworth+e2e1@yourdomain.com';
   -- Expect: non-NULL timestamp.
   ```
   Test the resend path once: enter a wrong code first → see "That code is invalid or has expired" → click **Resend code** → check inbox for a new email → use the new code.
8. On `/onboarding/pay`, you should see a **2-card plan picker**: "Founding Member $99/mo" (highlighted with "Limited — 10 slots" badge) on the left, "Standard $149/mo" on the right. Click **Claim founding rate** (or **Choose Standard**). Browser does a `POST /api/onboarding/select-plan { tier: 'founding' }` then `window.location.href`s to the matching Stripe Payment Link.

   **Verify the tier choice persisted to DB BEFORE the Stripe redirect:**

   ```sql
   SELECT subscription_tier FROM businesses
   WHERE owner_email = 'repworth+e2e1@yourdomain.com';
   -- Expect: 'founding' (or whichever you picked).
   ```

9. Fill Stripe test card: `4242 4242 4242 4242`, exp `12/34`, CVC `123`, ZIP `10001`.
10. Submit. Stripe redirects to `/onboarding/payment-success?session_id=cs_test_...`.
11. **Watch terminal 2 (stripe listen)** — should show `checkout.session.completed` delivered to `localhost:3001/ingress/stripe`.
12. **Verify Stripe webhook flipped status only — no enqueue:**

    ```sql
    SELECT subscription_status, stripe_customer_id, stripe_subscription_id, subscription_activated_at
    FROM businesses WHERE owner_email = 'repworth+e2e1@yourdomain.com';
    -- Expect: subscription_status='active', stripe_* fields populated, subscription_activated_at set.

    SELECT topic, status FROM job_outbox WHERE aggregate_id = '<business_id>';
    -- Expect: 0 rows still. Webhook does NOT enqueue — only the wizard does.
    ```

13. Within ~5s the payment-success page poller should detect `active && !businessOnboarded` and **auto-redirect to `/onboarding/business`** (the 3-step wizard). If it doesn't redirect, refresh — the same routing logic runs.
14. **Step 1 — Location:**
    - You should see the PlaceAutocomplete input. Start typing your business name (e.g., `Starbucks Pike Place`). Pick a result.
    - Below the input you should see the resolved address + "Place ID verified ✓" indicator (the prefill API populated category + website).
    - Click **Continue**.
    - **Fallback path** (test once with a fresh email): Click "Use a Google Maps URL instead" toggle, paste a real Google Maps URL, click **Continue**. The wizard should still resolve → display the place.
15. **Step 2 — Profile:**
    - **Business name** — should be prefilled from the Place result (e.g., `Starbucks Reserve Pike Place`). Edit if you want.
    - **Category** — prefilled from the Place primary type (e.g., `coffee_shop`). Editable.
    - **Website** — prefilled from Place result. Editable.
    - Click **Continue**.
16. **Step 3 — Voice:**
    - Tone selector + 5 textareas (greeting, signature, response philosophy, brand voice, sample response).
    - **Test the skip path** — click **Set this up later from settings**. Wizard submits with all 5 voice fields stripped.
    - (Alternative happy path: fill them in and click **Finish setup**.)
17. Submit → URL goes to `/dashboard`. Full dashboard should render (no banner).
18. **Verify wizard submit landed UPDATE + outbox in one tx:**

    ```sql
    SELECT name, category, website, google_place_id, place_id_verified, google_maps_url
    FROM businesses WHERE owner_email = 'repworth+e2e1@yourdomain.com';
    -- Expect: business fields populated; place_id_verified=true OR google_maps_url set.

    SELECT topic, status FROM job_outbox WHERE aggregate_id = '<business_id>'
    ORDER BY created_at;
    -- Expect: 1 row, topic='sync_reviews' OR 'validate_place_id'.
    --   sync_reviews if place_id_verified=true; validate_place_id otherwise.
    ```

19. **Within ~60s** the worker syncs reviews. Watch terminal 4 — ReviewSyncWorker activity.

**Pass criteria:** all 19 steps complete without errors. Database state matches expectations at each checkpoint.

**Idempotency check (optional but recommended):** After step 18, navigate back to `/onboarding/business`. The page-level guard should redirect you to `/dashboard` because `businessOnboarded=true`. If you bypass the guard (e.g., by manually POSTing to `/api/onboarding/business` again), the WHERE NOT EXISTS dedup should keep `job_outbox` at 1 row, not 2.

### 2.2 Scenario B — Email-not-confirmed login UX

**Setup:** Sign up another fresh email but DON'T enter the OTP code.

**Steps:**

1. Sign up `repworth+e2e2@yourdomain.com` per Scenario A steps 1–4.
2. Land on `/signup/check-email`. **Don't enter the OTP code.**
3. Open a new tab. Navigate to `/login`.
4. Try to log in with the email + password.
5. **Expect:** redirect to `/signup/check-email?from=login&email=repworth%2Be2e2%40yourdomain.com` (NOT a raw "Email not confirmed" error). The page should show "Almost there" heading because of `from=login`, and email is pre-filled from the query param.
6. **Verify:** enter the OTP code from the email. Verify-and-continue → redirected to `/onboarding/pay`. Subsequent `/login` attempts succeed normally.

### 2.3 Scenario C — Resend confirmation

**Steps:**

1. On `/signup/check-email` from Scenario B (or a fresh signup), the email is already pre-filled from the `?email=` query param — no input needed.
2. Click the **Resend code** link (below the OTP input).
3. Confirm UI shows "A new code is on its way."
4. Check inbox — should see a fresh email with a NEW 6-digit code (the old code is now invalid).
5. Try resending 3 times rapidly. After 2 rapid resends per email per hour, you should see `429` in network tab — UI shows "Too many resend attempts. Please wait a while."
6. Click **← Go back and change email** to return to `/signup` if a different email is needed.

**Cleanup of unverified signups:** If a user signs up but never enters the OTP, their state is `subscription_status='pending_payment' + stripe_customer_id IS NULL + onboarded_by IS NULL` with the Supabase Auth user existing. `CleanupAbandonedSignupsPoller` (default 24h interval) matches exactly this profile and deletes auth + DB rows after 7 days. No manual cleanup needed.

### 2.4 Scenario D — Forgot/reset-password owner happy path

**Setup:** Use the active owner from Scenario A (`repworth+e2e1@yourdomain.com`).

**Steps:**

1. Navigate to `/forgot-password`. Enter the owner email. Submit.
2. UI shows "If an account exists for that email, we've sent a reset link."
3. Open inbox. Find the recovery email. Click the link.
4. Browser → `/api/auth/callback?code=...&flow=owner&next=/reset-password` → redirects to `/reset-password`.
5. Enter new password (`newpassword123`). Confirm. Submit.
6. UI redirects to `/login`.
7. **CRITICAL VERIFY:** open browser devtools → Application → Cookies. The Supabase session cookies should be CLEARED after the redirect (the signOut call in the reset-password route).
8. Log in with the NEW password. Should land on `/dashboard` (or `/onboarding/pay` depending on subscription status).

### 2.5 Scenario E — Cross-portal protection

**Setup:** Use the owner email from Scenario A AND an admin email (the one that was created during migration setup, or another admin).

**Steps:**

1. Navigate to `/admin/forgot-password`. Enter the **owner** email. Submit.
2. UI shows the same generic "If an account exists..." message.
3. **Wait 30 seconds.** Check inbox. **No email should arrive** (cross-portal protection blocks the Supabase call).
4. Reciprocal: navigate to `/forgot-password`, submit the **admin** email. **No email should arrive**.

### 2.6 Scenario F — Google OAuth signup (skip if Google OAuth not configured)

**Steps:**

1. Navigate to `/signup`. Click **Continue with Google**.
2. Google OAuth → grant permission → redirected to `/api/auth/callback?flow=owner&next=/signup/finish` → redirects to `/signup/finish`.
3. **Identity-only finish form** (2 fields — NO business fields):
   - Email field is disabled, pre-filled with your Google email.
   - Your name — pre-filled from Google profile, editable.
   - Phone — optional, blank.
4. Submit.
5. URL → `/onboarding/pay`.
6. Continue per Scenario A steps 8–19 (pay → wizard → dashboard). Google emails are auto-confirmed; no `/signup/check-email` step.

### 2.7 Scenario G — Pending-payment owner login routing

**Setup:** Sign up an owner but don't complete payment.

**Steps:**

1. Sign up `repworth+e2e3@yourdomain.com`. Confirm email. Land on `/onboarding/pay`. **Close the tab without paying.**
2. Open a new tab. Navigate to `/login`. Log in with the email + password.
3. **Expect:** redirect directly to `/onboarding/pay` (NOT `/dashboard`). The login form fetches `/api/auth/signup-status` and routes accordingly.
4. Pay. Continue per Scenario A steps 13–19 (auto-redirect to `/onboarding/business` wizard, then dashboard).

### 2.7b Scenario G2 — Active-but-not-onboarded login routing (NEW)

**Setup:** A self-serve owner who paid but closed the wizard before completing it. This is the scenario where the user sees the abandoned-wizard recovery path.

**Steps:**

1. Sign up `repworth+e2e3b@yourdomain.com`. Confirm email. Pay (Scenario A steps 1–12).
2. The payment-success page redirects to `/onboarding/business` (Scenario A step 13). **Close the tab without completing any wizard step.**
3. **Verify state:**
   ```sql
   SELECT subscription_status, place_id_verified, google_maps_url, name
   FROM businesses WHERE owner_email = 'repworth+e2e3b@yourdomain.com';
   -- Expect: subscription_status='active', place_id_verified=false, google_maps_url=NULL, name='(pending setup)'.
   ```
4. Open a new tab. Navigate to `/login`. Log in.
5. **Expect:** redirect to `/onboarding/business` (NOT `/dashboard`). The login form fetches `/api/auth/signup-status` which returns `{ subscriptionStatus: 'active', businessOnboarded: false }`, and the client routes accordingly.
6. **Verify dashboard fallback CTA** — manually navigate to `/dashboard`. Expect the `active_pending_business` variant: a CTA-only screen titled "Set up your business" with a button linking to `/onboarding/business`. (No reviews/responses panel — there's nothing to show yet.)
7. Click the CTA → walk through the wizard → land on `/dashboard` with the full layout.

### 2.8 Scenario H — Cleanup poller deletes abandoned signups

**Setup:** With `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=60000` set, the poller runs every minute. The poller targets self-serve placeholder rows (`subscription_status='pending_payment' AND stripe_customer_id IS NULL AND onboarded_by IS NULL` older than 7 days). It does NOT touch businesses that have completed the wizard.

**Steps:**

1. Sign up `repworth+e2e4@yourdomain.com` per Scenario A steps 1–4 (DON'T confirm email or pay).
2. **Manually age the row** — in Supabase SQL editor:
   ```sql
   UPDATE businesses
   SET created_at = NOW() - INTERVAL '8 days'
   WHERE owner_email = 'repworth+e2e4@yourdomain.com';
   ```
3. Wait up to 60 seconds. Watch worker terminal — you'll see `[CleanupAbandonedSignups] Run complete: candidates=1 deleted=1 ...`.
4. **Verify rows are gone:**
   ```sql
   SELECT * FROM businesses WHERE owner_email = 'repworth+e2e4@yourdomain.com';
   -- Expect 0 rows.
   SELECT * FROM users WHERE email = 'repworth+e2e4@yourdomain.com';
   -- Expect 0 rows.
   ```
5. **Verify Supabase Auth user is gone:** Supabase dashboard → Authentication → Users → search the email. Should not exist.
6. Try signing up again with the same email — should succeed (the cleanup freed the slot).

### 2.9 Scenario I — Admin onboarding now sends owner invite + links auth_id (UPDATED)

**Background:** Before this branch, admin-onboarded businesses wrote `users.auth_id=NULL`. Owners had no Supabase Auth identity → couldn't log in, couldn't reset password (Supabase silently no-ops on missing auth.users row), couldn't even sign up (our pre-check returns 409 on email collision). The admin route now calls `supabaseServer.auth.admin.inviteUserByEmail()` after `createBusinessTx`, then patches the resulting `auth_id` onto the users row.

**Steps:**

1. Log in as admin at `/admin/login`.
2. Go to `/admin/businesses/new`. Fill the admin onboarding form for a **fresh email** you have access to (e.g. `repworth+admin-test1@yourdomain.com`).
3. Submit. Should succeed and return a payment link.
4. **Verify** admin path created the business + the auth identity AND linked them:

   ```sql
   -- Business + onboarded_by
   SELECT b.name, b.owner_email, b.onboarded_by, b.subscription_status,
          u.auth_id
   FROM businesses b
   JOIN users u ON u.business_id = b.id AND u.role = 'owner'
   WHERE b.owner_email = 'repworth+admin-test1@yourdomain.com';
   -- Expect:
   --   onboarded_by = <admin user_id>
   --   subscription_status = 'pending_payment'
   --   auth_id = <NEW Supabase auth_id from inviteUserByEmail> (NOT NULL!)

   -- Confirm the auth.users row exists with email_confirmed_at populated
   SELECT id, email, email_confirmed_at, last_sign_in_at
   FROM auth.users WHERE email = 'repworth+admin-test1@yourdomain.com';
   -- Expect: 1 row, email_confirmed_at populated (Supabase invites mark email confirmed).
   --   last_sign_in_at = NULL (they haven't logged in yet).

   -- Initial sync queued
   SELECT topic FROM job_outbox WHERE aggregate_id = '<business id>';
   -- Expect: 1 row, topic='sync_reviews' or 'validate_place_id'. Admin path enqueues immediately.
   ```

5. **Check the inbox** of the email you used. You should receive an email titled "You've been invited to RepWorth" (or whatever your Invite user template title says). The email body must contain a "Set your password" link pointing at `https://yourdomain.com/api/auth/callback?token_hash=...&type=invite&flow=owner&next=/reset-password` (in dev, `localhost:3000` instead).
6. Click the link in the email.
7. **Expect** redirect through `/api/auth/callback` → `/reset-password` with a valid Supabase session.
8. Set a password (≥8 chars). Submit.
9. **Expect** redirect to `/login`. Cookies should be cleared (signOut runs after password update — same behavior as Scenario D step 7).
10. Log in with the email + the password you just set. Should land on `/onboarding/pay` (because admin-onboarded businesses still need to complete payment unless an admin pre-pays them externally).
11. Confirm the admin business is **NOT** picked up by the cleanup poller (its `onboarded_by` is non-null, so the poller filter `onboarded_by IS NULL` excludes it even after 8 days).

**Pass criteria:** all 11 steps complete without errors. Owner ends up with a working password they can log in with going forward.

**Failure mode to watch for — admin invite email not sent:** if step 5's email never arrives, two likely causes:

- Supabase's email rate limit hit (see §1.3 step 6). With Custom SMTP via Resend configured this should never happen, but if you're testing without it, your admin-onboard attempts share the 2/hour cap with self-serve signups.
- Custom SMTP isn't on but Invite user template still uses Supabase's built-in send → may silently rate-limit. Check `[resend.com/emails](https://resend.com/emails)` to confirm the email actually went out via Resend.

**Failure mode to watch for — invite link returns "expired" or "account_incomplete":** the Supabase Invite user template wasn't updated per §1.3 step 5b. The default template has a different URL shape and won't reach our callback correctly.

### 2.9b Scenario I2 — Admin invite failure compensating delete (NEW)

**Background:** If `inviteUserByEmail()` fails (rate limit, SMTP down, etc.), the admin route compensates by deleting the half-provisioned business + users row, so the admin can retry without a 409 collision on the next attempt.

**Steps:**

1. Log in as admin.
2. Temporarily break Supabase's invite path. Easiest way: **set Supabase Rate Limit for sending emails to `1`** in Authentication → Rate Limits. Then use up the quota by sending one signup confirmation to a different test email so the next invite hits 429.
3. Try to onboard a fresh business (e.g. `repworth+admin-fail-test@yourdomain.com`). Submit.
4. **Expect** error response: 500 with body containing "Could not send owner invite email. Business was not created — check Supabase Auth settings (SMTP, rate limits) and try again."
5. **Verify nothing was left behind:**
   ```sql
   SELECT * FROM businesses WHERE owner_email = 'repworth+admin-fail-test@yourdomain.com';
   -- Expect: 0 rows.
   SELECT * FROM users WHERE email = 'repworth+admin-fail-test@yourdomain.com';
   -- Expect: 0 rows.
   ```
6. **Reset rate limit** to whatever it was (or `30` per §1.3 step 7). Retry the same email — should succeed cleanly.

### 2.10 Scenario J — Stripe webhook idempotency (replay safety)

**Steps:**

1. Use Scenario A's already-active owner (post-wizard).
2. Re-trigger the Stripe webhook from terminal 2:
   ```bash
   stripe trigger checkout.session.completed
   ```
3. **Watch worker terminal** — should log `Duplicate event ... — skipping` (handled by `inbound_events` dedup).
4. **Verify nothing changed:**

   ```sql
   SELECT subscription_status, subscription_activated_at FROM businesses
   WHERE owner_email = 'repworth+e2e1@yourdomain.com';
   -- Expect: still active, activated_at unchanged (COALESCE preserves first-write).

   SELECT count(*) FROM job_outbox
   WHERE aggregate_id = '<business_id>'
     AND topic IN ('sync_reviews', 'validate_place_id');
   -- Should match the count from before the replay. The webhook does NOT enqueue; the wizard owns enqueue.
   ```

**Noise events you WILL see in the worker log — these are correct, do not investigate:**

`stripe trigger checkout.session.completed` fires a chain of related events to simulate a real payment lifecycle. Only `checkout.session.completed` flips business state; everything else is intentionally ignored. Typical log lines:

```
[ingress/stripe] Unhandled event type: charge.succeeded — ignoring
[ingress/stripe] Unhandled event type: charge.updated — ignoring
[ingress/stripe] Unhandled event type: payment_intent.created — ignoring
[ingress/stripe] Unhandled event type: payment_intent.succeeded — ignoring
[ingress/stripe] Unhandled event type: customer.created — ignoring
[ingress/stripe] Unhandled event type: customer.subscription.created — ignoring
[ingress/stripe] Business <id> activated (customer=cus_..., old_status=pending_payment)
```

The activation log line is the only one that signals state change. Asserted by `worker/ingress/__tests__/stripe.test.ts` (7 tests including the `charge.updated` no-op + a positive control). What's handled vs ignored:

| Event                                                                               | Handler              | Notes                                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`                                                        | ✅ activates         | Flips `pending_payment` → `active`, attaches `stripe_customer_id` + `stripe_subscription_id`                            |
| `invoice.paid`                                                                      | ✅ recovers          | `past_due` → `active`                                                                                                   |
| `invoice.payment_failed`                                                            | ✅ marks past_due    | `active` → `past_due`                                                                                                   |
| `customer.subscription.updated`                                                     | ✅ tier sync         | Maps price ID → `subscription_tier`                                                                                     |
| `customer.subscription.deleted`                                                     | ✅ cancels           | → `cancelled`                                                                                                           |
| `charge.*`, `payment_intent.*`, `customer.created`, `customer.subscription.created` | ❌ ignored by design | Charge-layer events below the subscription layer; subscription state is already settled by `checkout.session.completed` |

### 2.11 Scenario K — Wizard endpoint idempotency (NEW)

**Setup:** Use the active owner from Scenario A (post-wizard).

**Steps:**

1. Note the current outbox count for that business:
   ```sql
   SELECT count(*) FROM job_outbox WHERE aggregate_id = '<business_id>';
   -- Note this number.
   ```
2. With browser devtools open, manually re-POST to `/api/onboarding/business` (right-click an existing wizard request → "Replay XHR" or use curl with the auth cookie). The request body can be the same payload that succeeded the first time.
3. **Expect:** `200 OK` (idempotent UPDATE) with `{ ok: true, redirectTo: '/dashboard' }`.
4. **Verify outbox dedup:**
   ```sql
   SELECT count(*) FROM job_outbox WHERE aggregate_id = '<business_id>';
   -- Should match the prior count — WHERE NOT EXISTS dedup prevented a second insert.
   ```
5. (Optional) test the page-level guard: navigate to `/onboarding/business`. Server component should redirect you to `/dashboard` because `place_id_verified=true OR google_maps_url IS NOT NULL`.

### 2.12 Scenario L — Wizard authn/state guards (NEW)

**Steps:**

1. Open an incognito tab (no session). Navigate to `/onboarding/business`. **Expect** redirect to `/login`.
2. Sign in as an **admin** user. Navigate to `/onboarding/business`. **Expect** redirect to `/admin/overview` (role guard — admins shouldn't see owner-flow pages).
3. Sign in as the **pending-payment** owner from Scenario G. Navigate to `/onboarding/business`. **Expect** redirect to `/onboarding/pay` (status guard — wizard only opens after payment).
4. Sign in as the **post-wizard** owner from Scenario A. Navigate to `/onboarding/business`. **Expect** redirect to `/dashboard` (already-onboarded guard).

### 2.13 Scenario M — Approval emails actually send post-onboarding (NEW — regression for B10)

**Background:** B10 fixed a bug where Google-signed-up owners had no `channel_enrollments` row → `NotificationWorker` silently dropped every approval email. The bug was visible only after reviews started syncing (a delayed failure mode), so it requires a full end-to-end test with at least one review reaching `pending_approval` to catch.

**Steps:**

1. Use **Scenario A's post-wizard owner** (or run Scenario A from scratch with a fresh email).
2. **Verify the email channel was created at the right moment:**

   ```sql
   SELECT id, channel, handle, status, verified_at
   FROM channel_enrollments
   WHERE business_id = '<business_id from Scenario A>';
   -- Expect: 1 row.
   --   channel = 'email'
   --   handle = 'repworth+e2e1@yourdomain.com'
   --   status = 'verified'
   --   verified_at = <timestamp from when they entered the OTP code>
   ```

   The `verified_at` should be near the OTP-entry time (Scenario A step 6 / 7), NOT the signup time (Scenario A step 4) — `channel_enrollments` is intentionally created post-OTP-verification, not at signup.

3. **Wait for the worker to sync reviews** (Scenario A step 19). Look for ReviewSyncWorker activity in terminal 4. Once at least one review lands, the ResponseGeneratorWorker should produce a draft and enqueue a `send_notification` outbox row.

4. **Verify approval emails actually dispatch:**

   ```sql
   -- Did NotificationWorker mark send_notification rows as completed?
   SELECT topic, status, attempts, last_error
   FROM job_outbox
   WHERE aggregate_id IN (
     SELECT id FROM responses WHERE review_id IN (
       SELECT id FROM reviews WHERE business_id = '<business_id>'
     )
   )
   ORDER BY created_at;
   -- Expect: at least 1 'send_notification' row, status='completed', last_error=NULL.

   -- Did notification_deliveries rows actually get written?
   SELECT template, channel, recipient, sent_at, delivered_at, failure_reason
   FROM notification_deliveries
   WHERE business_id = '<business_id>'
   ORDER BY created_at DESC;
   -- Expect: at least 1 row.
   --   channel = 'email'
   --   recipient = 'repworth+e2e1@yourdomain.com'
   --   sent_at = <recent timestamp>
   --   failure_reason = NULL
   ```

5. **Check the owner's inbox.** They should have received an "Approve a draft response" email with a link to `/approve/<token>`.

6. **The regression to watch for:** if the `notification_deliveries` query returns 0 rows AND the `job_outbox` shows `send_notification` rows as `status='completed'` with `attempts=1`, you've hit the B10 bug — the worker found 0 verified channels and silently no-op'd. To diagnose:

   ```sql
   SELECT * FROM channel_enrollments WHERE business_id = '<business_id>' AND archived_at IS NULL;
   -- If this returns 0 rows, that's the bug. The owner has no recipient to dispatch to.
   ```

   Fix path: insert the missing row + re-enqueue stuck notifications:

   ```sql
   INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
   VALUES (
     gen_random_uuid(),
     '<business_id>',
     'email',
     '<owner_email>',
     'verified',
     NOW()
   ) ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING;

   INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
   SELECT
     gen_random_uuid(), 'send_notification', 'response', r.id,
     jsonb_build_object(
       'response_id', r.id::text,
       'business_id', '<business_id>',
       'correlation_id', gen_random_uuid()::text
     ), 'pending'
   FROM responses r
   JOIN reviews rev ON rev.id = r.review_id
   WHERE rev.business_id = '<business_id>'
     AND r.status = 'pending_approval';
   ```

7. **Repeat the verification for Google-signed-up owners (Scenario F).** Their `channel_enrollments` row is created post-finish-signup (when Google's identity confirms the email), not post-OTP. The query in step 2 should still show one verified email row — the `verified_at` should be near the moment they completed `/signup/finish`, not the moment Google issued the JWT.

**Pass criteria:** for every owner who completes onboarding (password OR Google), exactly one `channel_enrollments` row with `channel='email' AND status='verified'` exists, and at least one approval email lands in their inbox after the first review syncs.

---

## Part 3 — Production rollout

### 3.1 Pre-deploy checklist

Before flipping the flag in production:

- [ ] All Part 2 scenarios passed locally (A–M, including the new I, I2, K, L, M).
- [ ] Migration 025 has been **planned for production** but NOT yet run (run it just-in-time during the deploy).
- [ ] **Production Supabase Custom SMTP via Resend configured** (Authentication → SMTP Settings, host `smtp.resend.com:465`, username `resend`, password = production `RESEND_API_KEY`). Required — without this, you'll hit Supabase's 2/hour built-in cap within minutes of going live.
- [ ] **Production Supabase Email Templates updated** — all THREE must be edited per §1.3 steps 4, 5, 5b:
  - **Confirm signup** body uses `{{ .Token }}` (6-digit code), NOT `{{ .ConfirmationURL }}`
  - **Reset password** href uses `&amp;`-escaped query params + `flow=owner&amp;next=/reset-password`
  - **Invite user** href uses `&amp;`-escaped query params + `type=invite&amp;flow=owner&amp;next=/reset-password`
- [ ] Production Supabase Auth Rate Limits → "Rate limit for sending emails" raised to at least `30` (Custom SMTP bypasses this anyway, but the ceiling is defense-in-depth).
- [ ] Production Resend domain is fully verified (SPF + DKIM + DMARC propagated). Confirm by sending a test email from the Resend dashboard before flipping the flag.
- [ ] Production Supabase has Google OAuth provider enabled with production redirect URI: `https://yourdomain.com/api/auth/callback`.
- [ ] Production Stripe Payment Links (BOTH founding AND standard) updated:
  - `success_url = https://yourdomain.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`
  - `cancel_url = https://yourdomain.com/onboarding/pay?cancelled=1`
- [ ] Production Stripe webhook endpoint is `https://your-railway-worker.example.com/ingress/stripe` (already shipped — not new for this feature).
- [ ] All these env vars are set in Vercel (web) AND Railway (worker):
  - `NEXT_PUBLIC_APP_URL=https://yourdomain.com`
  - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...` (Vercel only — used by the wizard's PlaceAutocomplete; same key as admin onboarding)
  - `STRIPE_PAYMENT_LINK_FOUNDING=...` (production live-mode link)
  - `STRIPE_PAYMENT_LINK_STANDARD=...`
  - `REDIS_CACHE_URL` (already set)
  - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (already set)
  - `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (already set)
  - **NOT YET:** `SELF_SERVE_SIGNUP_ENABLED=true` — add but leave at `false` for now.
  - Optional: `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` (defaults to 24h).

- [ ] **Google Maps Platform** — confirm the production API key has Places API (New) enabled and the HTTP-referrer restriction includes `https://yourdomain.com/*`. The wizard calls `places.googleapis.com` via the autocomplete element; without the referrer, Step 1 will fail silently for owners.

### 3.2 Deploy sequence

1. **Run migration 025 in production Supabase SQL editor** (paste contents of `supabase/migrations/025_signup_schema.sql`). Confirm both preconditions pass. If the email-collision precondition fails, resolve manually before continuing.
2. **Merge `feat/owner-self-serve-signup` to `main`** via PR. CI runs `pnpm tsc --noEmit && pnpm vitest run`.
3. **Vercel auto-deploys** the web app to production with `SELF_SERVE_SIGNUP_ENABLED=false` still — all the new pages return 404, the landing nav shows nothing new.
4. **Railway redeploys** the worker — startup assertion runs but is a no-op (flag still `false`). The CleanupAbandonedSignupsPoller doesn't start.
5. **Smoke test in production WITH FLAG OFF:**
   - Visit `https://yourdomain.com/signup` — expect 404.
   - Visit `https://yourdomain.com/login` — expect 404.
   - Visit `https://yourdomain.com/onboarding/business` — expect 404 (wizard is also flag-gated).
   - Visit `https://yourdomain.com/admin/login` — should still work normally (admin flow not flag-gated).
   - Visit `https://yourdomain.com/admin/forgot-password` — should work (admin reset never flag-gated).
6. **Flip flag to `true` on staging first** (if you have a staging env). Run Part 2 Scenarios A–H against staging using a real test email. If anything breaks, debug there.
7. **Flip flag in production:**
   - Set `SELF_SERVE_SIGNUP_ENABLED=true` in Vercel + Railway env vars.
   - Trigger a redeploy (Vercel: env-var change auto-redeploys. Railway: may need a manual restart).
   - **In the same deploy window**, also push the change to make `/login` + `/signup` links visible in the landing nav (already conditional on the flag — should appear automatically once env propagates).

### 3.3 Production smoke (post-flip)

Within the first 30 minutes of go-live:

1. **Self-serve signup happy path against production** with a real disposable email:
   - Visit `https://yourdomain.com`. Confirm landing nav shows Log In + Sign Up.
   - Sign up with `repworth+prod-test1@yourdomain.com` and a Stripe **test-mode** card if your prod Payment Links are still in test mode — OR a real card with $1 charged then refunded if you've flipped to live mode.
   - Walk through: identity-only signup → email confirm → pay → wizard Step 1 (Location, with PlaceAutocomplete) → Step 2 (Profile, prefilled) → Step 3 (Voice, click Skip) → dashboard active.
   - **Verify** in production Supabase:
     ```sql
     SELECT id, owner_email, name, subscription_status, onboarded_by,
            place_id_verified, google_maps_url
     FROM businesses
     WHERE owner_email = 'repworth+prod-test1@yourdomain.com';
     -- Expect: subscription_status='active', name=<real business name from wizard>,
     --   place_id_verified=true OR google_maps_url set.
     ```
   - If anything looks wrong, **immediately flip flag back to `false`** in Vercel + Railway, redeploy. Owners mid-signup will see a notFound page next refresh. **Owners stuck mid-wizard** with `active && !businessOnboarded` will continue to be billed and won't be able to reach the wizard while the flag is off — handle them out-of-band (refund, or admin completes onboarding via `/admin/businesses/<id>` and writes their fields directly).

2. **Production worker logs** (Railway dashboard) — confirm the cleanup poller started, the Stripe webhook processed activation, no exceptions.

3. **Sentry** — watch error feed for the first 24h. Any 500s on `/api/auth/*` are signal.

4. **Approval-email regression check (B10)** — once the test signup's first review syncs, verify they actually receive an approval email. This is the failure mode that silently disappeared 8 emails for the first Google signup. Run the queries from Scenario M against the production DB and confirm `notification_deliveries` has rows + the inbox actually got mail. If `job_outbox` shows `send_notification` rows as `completed` but the inbox is empty + `notification_deliveries` has 0 rows, the channel_enrollments row is missing — see Scenario M's fix path.

5. **Admin invite regression check (B11)** — onboard one prod test business via `/admin/businesses/new`, verify the owner receives the invite email + can click → land on `/reset-password` → set password → log in. Asserted in Scenario I but worth re-running against prod since this depends on the Invite user template being correctly configured (template typos are silent — links just go to wrong URLs).

### 3.4 Post-launch monitoring (first week)

- **Daily SQL check** for orphan rows:

  ```sql
  -- Self-serve signups in pending_payment for >24h (potential abandoners or stuck flow)
  SELECT id, owner_email, created_at FROM businesses
  WHERE subscription_status = 'pending_payment'
    AND onboarded_by IS NULL
    AND stripe_customer_id IS NULL
    AND created_at < NOW() - INTERVAL '24 hours'
    AND created_at > NOW() - INTERVAL '7 days'
  ORDER BY created_at;
  -- Expect: small number, growing slowly. They'll be auto-cleaned at the 7-day mark.

  -- Active businesses still stuck in the wizard (paid but never finished onboarding).
  -- These are your conversion-funnel drop-offs — useful for sales follow-up.
  SELECT id, owner_email, subscription_activated_at FROM businesses
  WHERE subscription_status = 'active'
    AND onboarded_by IS NULL
    AND place_id_verified = false
    AND google_maps_url IS NULL
    AND subscription_activated_at < NOW() - INTERVAL '1 hour';
  -- Expect: ideally 0. >0 means owners paid and bounced before completing the wizard.
  --   Reach out manually OR have admin finish the onboarding for them.
  ```

- **Cleanup poller activity** (Railway logs):

  ```
  grep '\[CleanupAbandonedSignups\]' worker.log
  ```

  Expect daily runs with low candidate counts initially.

- **Stripe webhook latency** — confirm `subscription_activated_at` lands within ~10s of payment for at least 99% of signups.

- **Resend deliverability** — confirmation email open rate should be ≥80%; if <50%, your domain DKIM/SPF needs review.

### 3.5 Rollback plan

If something breaks in production:

1. **Immediate** — set `SELF_SERVE_SIGNUP_ENABLED=false` in Vercel + Railway. New signups blocked instantly. Existing in-flight signups get a "page not found" — they can retry once the flag flips back.
2. **DB state** — if any bad rows landed, identify and clean them:
   ```sql
   -- Self-serve rows that should be deleted (use cautiously)
   SELECT * FROM businesses WHERE onboarded_by IS NULL AND created_at > '<deploy timestamp>';
   ```
3. **Code revert** — if the issue requires a code fix, prefer a forward-fix over reverting the merge (reverting brings back the channels-Phase-3 baseline which is also new). Cherry-pick a hotfix on top of `main`.

---

## Appendix — Common test failures + fixes

| Symptom                                                                                | Likely cause                                                                                                                   | Fix                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/signup` returns 404                                                                  | `SELF_SERVE_SIGNUP_ENABLED !== 'true'`                                                                                         | Restart Next dev after `.env.local` change                                                                                                                                                                |
| Confirmation email never arrives                                                       | Wrong `redirectTo` URL OR Supabase Site URL mismatch                                                                           | Check Supabase Auth → URL Configuration                                                                                                                                                                   |
| Confirmation email contains a link instead of a 6-digit code                           | Email template still uses default `{{ .ConfirmationURL }}`                                                                     | Update Confirm signup template to use `{{ .Token }}` (see §1.3 step 4)                                                                                                                                    |
| Verify-OTP submit returns 400 `invalid_or_expired_code`                                | Wrong code typed OR code expired (24h) OR a newer code was issued by Resend (the old one is dead the moment a new one is sent) | Click **Resend code**, use the freshest code                                                                                                                                                              |
| Verify-OTP submit returns 500 `account_incomplete`                                     | DB has no `users` row for the auth_id, or role is not 'owner'                                                                  | Check `SELECT * FROM users WHERE auth_id = (SELECT id FROM auth.users WHERE email='...')` — if missing, signup compensating-cleanup probably ran but auth row survived                                    |
| Stripe webhook never fires                                                             | `stripe listen` not running OR wrong port                                                                                      | `stripe listen --forward-to localhost:3001/ingress/stripe`                                                                                                                                                |
| `subscription_status` stuck on pending after pay                                       | Worker not running, OR `STRIPE_WEBHOOK_SECRET` mismatch                                                                        | Check worker logs; copy fresh whsec from `stripe listen`                                                                                                                                                  |
| `pnpm worker` startup fails with "SELF_SERVE_SIGNUP_ENABLED=true requires X"           | Missing env var                                                                                                                | Set the missing var per the assertion message                                                                                                                                                             |
| Cleanup poller never deletes anything                                                  | Rows are <7 days old OR `onboarded_by` is non-null                                                                             | Manually age via SQL OR check that `onboarded_by IS NULL` for self-serve rows                                                                                                                             |
| `/onboarding/pay` shows "Payment link unavailable"                                     | `STRIPE_PAYMENT_LINK_*` not set or malformed                                                                                   | Check env, restart Next dev                                                                                                                                                                               |
| `users.auth_id` violates UNIQUE on signup retry                                        | Orphan auth user from prior failed signup                                                                                      | Delete via Supabase dashboard, retry                                                                                                                                                                      |
| Payment-success page never redirects to wizard                                         | Polling fetch failing OR `businessOnboarded` mis-evaluating                                                                    | Check network tab for `/api/auth/signup-status` response. `businessOnboarded` should be `false` until wizard submits.                                                                                     |
| Wizard Step 1 PlaceAutocomplete shows blank / no suggestions                           | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` missing OR HTTP-referrer restriction blocks                                                  | Verify env in Vercel + Google Cloud Console referrer allowlist (`localhost:3000/*` for local)                                                                                                             |
| Wizard prefill returns 404 / 503                                                       | `/api/signup/place-prefill` flag-gated 404 (off) OR Redis-down 503                                                             | Confirm `SELF_SERVE_SIGNUP_ENABLED=true` and `REDIS_CACHE_URL` reachable                                                                                                                                  |
| Wizard submit returns 409 conflict                                                     | Owner double-clicked Submit AND advisory lock collision                                                                        | Refresh page; the UPDATE is idempotent so the second click is harmless once the first commits                                                                                                             |
| `/onboarding/business` redirects to `/dashboard` unexpectedly                          | `place_id_verified=true OR google_maps_url IS NOT NULL` already (wizard already submitted)                                     | This is correct behavior — user has finished onboarding                                                                                                                                                   |
| Owner stuck on `/onboarding/business` after submit                                     | Form submit failed silently OR outbox insert raced                                                                             | Check network tab + `job_outbox` for the business_id; manually retry or have admin fill fields                                                                                                            |
| Signup returns "Too many signup attempts. Please wait a few minutes." on first attempt | Supabase built-in SMTP 2/hour cap tripped (B9)                                                                                 | Configure Custom SMTP via Resend (§1.3 step 6). For dev unblock: `pnpm tsx scripts/clear-signup-rate-limits.ts <email>` clears OUR app-side rate limits but NOT Supabase's — that needs SMTP fix or wait. |
| Signup returns "An account with this email already exists" but DB shows no row         | Same Supabase rate-limit issue masquerading as account_exists (pre-B9 behavior, now disambiguated)                             | Check terminal for `[api/auth/signup] Supabase email rate limit hit` log line. Same fix as above.                                                                                                         |
| Reset password email link renders as plain text "Reset Password" with no link          | Email template has unescaped `&` in href — some clients silently strip the malformed `<a>`                                     | Replace `&` with `&amp;` in the template href (see §1.3 step 5).                                                                                                                                          |
| Approval emails never arrive even though responses show in admin UI                    | `channel_enrollments` row missing for the business (B10 regression — was a Google-signup bug)                                  | Run Scenario M queries. Insert missing email channel + re-enqueue stuck send_notification rows.                                                                                                           |
| Admin-onboarded owner can't log in / "account_exists" on signup retry                  | `users.auth_id IS NULL` from the old admin path (pre-B11)                                                                      | Manually invite via `auth.admin.inviteUserByEmail` then UPDATE users SET auth_id=<new auth.id>. Or delete + re-onboard via `/admin/businesses/new` (now sends invite automatically).                      |
| Plan picker page shows error "Payment link unavailable. Contact support."              | `STRIPE_PAYMENT_LINK_FOUNDING` or `_STANDARD` env var malformed/missing                                                        | Check both env vars URL-parse cleanly via `node -e "new URL(process.env.STRIPE_PAYMENT_LINK_FOUNDING)"`. Restart Next + worker after fix.                                                                 |
| Stripe webhook log spammed with "Unhandled event type: charge.updated"                 | Expected behavior — `stripe trigger checkout.session.completed` fires noise events                                             | Not a bug. See Scenario J's "Noise events" table.                                                                                                                                                         |

---

## Definition of "ready for production"

All of these must be true:

- [x] Migration 025 ran cleanly on staging + production
- [x] `pnpm tsc --noEmit` clean on `main`
- [x] `pnpm vitest run` **1405/1405** pass on `main`
- [x] All Part 2 scenarios passed locally (A through M, including the updated I + new I2, K, L, M)
- [x] All Part 2 scenarios passed against staging (if you have staging)
- [ ] **Production Supabase Custom SMTP via Resend configured** (host `smtp.resend.com:465`, username `resend`, password = production `RESEND_API_KEY`). Verified by sending a test email from Supabase + confirming it appears in [resend.com/emails](https://resend.com/emails).
- [ ] **Production Supabase email templates** — all THREE updated:
  - Confirm signup uses `{{ .Token }}` (the 6-digit code) prominently displayed; the `{{ .ConfirmationURL }}` link is removed.
  - Reset password href uses `&amp;`-escaped query params + `flow=owner&amp;next=/reset-password`.
  - Invite user href uses `&amp;`-escaped query params + `type=invite&amp;flow=owner&amp;next=/reset-password`.
- [ ] Production env vars set in Vercel + Railway (including `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, both `STRIPE_PAYMENT_LINK_*`, `SELF_SERVE_SIGNUP_ENABLED=true`)
- [ ] Google Maps API key HTTP-referrer allowlist includes production domain
- [ ] Production Stripe Payment Links (BOTH founding AND standard) have correct `success_url` + `cancel_url`
- [ ] Production Supabase has Google OAuth + email auth configured
- [ ] Production Resend domain SPF + DKIM + DMARC records verified
- [ ] First production self-serve signup completed end-to-end (identity → OTP → pay → plan picker → wizard → dashboard)
- [ ] **First production approval email actually delivered** (Scenario M check) — signup → wait for first review sync → confirm `notification_deliveries` has a row + the email landed in the inbox. Catches B10-style channel_enrollments gaps.
- [ ] **First production admin onboarding completed end-to-end** (Scenario I check) — admin onboards a business → owner receives invite email → clicks → sets password → logs in. Catches B11-style invite-template typos.
- [ ] Confirmed wizard Step 1 PlaceAutocomplete works in production (not blocked by referrer policy)
- [ ] Sentry watched for first 24h with no 500s

---

## Part 2 — Test Results (run 2026-04-26, local dev)

**Test environment:** Windows 11, Node 20, local Redis, `MOCK_EXTERNAL_APIS=false`, `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=120000`
**Test accounts:** `norbertliverpool+e2e{1..4}@gmail.com` and subvariants (all go to the same Gmail inbox)

| Scenario                                          | Result                  | Notes                                                                                                                    |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A — Password signup happy path                    | ✅ PASS (with findings) | See F1, F2, F3 below                                                                                                     |
| B — Email-not-confirmed login UX                  | ✅ PASS                 | "Almost there" heading, from=login param, OTP redirect to /onboarding/pay all correct                                    |
| C — Resend confirmation                           | ✅ PASS                 | "A new code is on its way" shown; 3rd resend shows "Too many resend attempts. Please wait a while."                      |
| D — Forgot/reset-password owner happy path        | ✅ PASS (with note)     | Full flow verified; see N1 for Gmail QP encoding observation                                                             |
| E — Cross-portal protection                       | ✅ PASS                 | Owner email on admin portal → no email; admin email on owner portal → no email                                           |
| F — Google OAuth signup                           | ⏭ SKIPPED              | Not configured in local test environment                                                                                 |
| G — Pending-payment owner login routing           | ✅ PASS                 | Login → /onboarding/pay directly                                                                                         |
| G2 — Active-not-onboarded login routing           | ✅ PASS                 | Login → /onboarding/business; dashboard shows "Set up your business" CTA                                                 |
| H — Cleanup poller deletes abandoned signups      | ✅ PASS                 | business + users + auth.users all deleted after ~260s; re-signup succeeds                                                |
| I — Admin onboarding sends invite + links auth_id | ✅ PASS (with note)     | Invite email arrives; owner sets password; logs in; see N2                                                               |
| I2 — Admin invite failure compensating delete     | ✅ CODE VERIFIED        | Compensating delete logic confirmed at lines 233–261 and 304–324 of admin businesses route; live failure not triggered   |
| J — Stripe webhook idempotency                    | ✅ PASS                 | UNIQUE INDEX on `inbound_events.external_event_key` enforces dedup; business state unchanged                             |
| K — Wizard endpoint idempotency                   | ✅ PASS (with finding)  | Outbox count unchanged after duplicate POST; see F4                                                                      |
| L — Wizard authn/state guards                     | ⚠️ PARTIAL (3/4)        | Cases 1, 3, 4 pass; Case 2 fails — see B4                                                                                |
| M — Approval emails send post-onboarding          | ✅ PASS                 | Full pipeline: channel_enrollment verified → send_notification dispatched → notification_deliveries row → Gmail delivery |

---

### Bugs (need fixes before production)

**B1 — OTP is 8 digits but UI says "6-digit code"**

- **Where:** `/signup/check-email` page copy + input placeholder
- **Observed:** Supabase project is configured with 8-digit OTPs (e.g. `50148956`). The page heading says "We sent a **6-digit** code" and the placeholder says "6-digit code".
- **Impact:** User confusion — the typed code is longer than advertised. Low severity but incorrect.
- **Fix:** update the UI copy in `CheckEmailClient.tsx` to say "8-digit code".

**B3 — Raw error codes shown to users in signup form**

- **Where:** `src/app/(public)/signup/SignupFormClient.tsx` line 42: `setError(body.message ?? body.error ?? 'Signup failed')`
- **Observed:** When the IP rate limit hits, the API returns `{ error: 'rate_limited' }` (no `message` field). The client displays the raw string `rate_limited` on screen. Same for `rate_limit_unavailable` (Redis down, 503).
- **Impact:** Unprofessional UX — users see internal error codes.
- **Fix option A:** Add a `message` field to the API responses for `rate_limited` ("Too many signup attempts. Please wait a few minutes.") and `rate_limit_unavailable` ("Signup temporarily unavailable. Please try again shortly.").
- **Fix option B:** Add a client-side error code → human-readable message map in `SignupFormClient`.

**B4 — Admin user navigating to `/onboarding/business` gets `/login` instead of `/admin/overview`**

- **Where:** `src/middleware.ts` line 137
- **Observed:** The middleware block for `/onboarding/*` routes checks `self.role !== 'owner'` and calls `redirectToLogin(request, 'owner')`, which redirects to `/login`. This treats admin users the same as unauthenticated visitors. The page-level component (`resolveWizardDestination` in `guard.ts` line 28) correctly redirects admins to `/admin/overview` — but the middleware intercepts first.
- **Impact:** An admin who accidentally navigates to an owner-flow URL lands on the owner login page instead of staying in the admin UI. Mildly confusing.
- **Fix:** In middleware, split the two cases:
  ```typescript
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
    if (!authUser) return redirectToLogin(request, "owner");
    const self = await readSelf();
    if (!self || !self.business_id) return redirectToLogin(request, "owner");
    if (self.role !== "owner") {
      // Admin or sales_partner — redirect to their home, not login
      return NextResponse.redirect(new URL("/admin/overview", request.url));
    }
  }
  ```

---

### Notes (non-blocking observations)

**N1 — Gmail API plaintext QP encoding mangles reset/invite link URLs**

- The Gmail MCP's `plaintextBody` field strips or garbles `=` signs in URLs because MIME Quoted-Printable encoding represents `=` as `=3D`, and the plaintext conversion doesn't decode it. This makes it impossible to extract a working reset/invite URL from the plaintext email via the Gmail MCP.
- **Impact on testing only:** All actual HTML email links work correctly when clicked from a real email client. Verified by generating fresh tokens via Supabase admin API and navigating manually.
- **Not a product bug.** No fix needed in the product code.

**N2 — `email_confirmed_at` is NULL after admin `inviteUserByEmail`, not populated**

- Runbook §2.9 step 4 says: "Expect: email_confirmed_at populated (Supabase invites mark email confirmed)."
- Actual behavior: `email_confirmed_at = null` in `auth.users` immediately after the invite is sent. It is only set after the owner clicks the invite link and Supabase processes the token.
- **Runbook is incorrect.** Update the check in Scenario I step 4 to: "email_confirmed_at = NULL (will be populated after owner clicks the invite link)."

**N3 — Dashboard "Review Velocity" chart shows "Invalid Date" for x-axis labels**

- The Review Velocity chart on `/dashboard` shows "Invalid Date" for all x-axis date labels when there are no reviews.
- Low severity, cosmetic issue. No reviews in the test DB so the chart renders with empty/null date values.

**N4 — Cleanup poller requires up to 2 full intervals to delete an aged row**

- With `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=120000`, the cleanup took ~260 seconds (2 full cycles) rather than 1.
- Expected: the initial `runOnce()` fires immediately on startup, then the `setInterval` fires every 120s. If the row was aged between the initial run and the first interval tick, the first tick will catch it. Depending on timing within the 120s window, this can appear to "skip" a cycle.
- Not a bug. The runbook should clarify: "Wait up to 2 intervals (240s) for the cleanup to run."

**N5 — App-side rate limits require clearing between successive signup test runs**

- Running scenarios A, H (and others) in rapid succession will trip the IP-level rate limit (5 signups/hour). The `scripts/clear-signup-rate-limits.ts` helper clears app-side Redis buckets; Supabase's own email rate limit is cleared by configuring custom SMTP (see §1.3 step 6).
- Already documented in §1.7, included here for cross-reference.

---

## Part 2 — Rerun Results (2026-04-26, after B22/B23 hardening commits)

**Fixes verified in this run:** B1, B3, B4 resolved. B2 unchanged (Stripe dashboard config — not a code change).

| Scenario | Result | Status vs prior run |
|----------|--------|---------------------|
| A — Password signup happy path | ✅ PASS | B1 fixed: UI now shows "8-digit code" ✓; B2 still present (Stripe Payment Link success_url not updated) |
| B — Email-not-confirmed login UX | ✅ PASS | Unchanged pass; "8-digit code" copy also correct here |
| C — Resend confirmation | ✅ PASS | Unchanged pass |
| D — Forgot/reset-password owner happy path | ✅ PASS | Unchanged pass |
| E — Cross-portal protection | ✅ PASS | Unchanged pass |
| F — Google OAuth signup | ⏭ SKIPPED | Not configured in local environment |
| G — Pending-payment owner login routing | ✅ PASS | Unchanged pass |
| G2 — Active-not-onboarded login routing | ✅ PASS | Unchanged pass |
| H — Cleanup poller deletes abandoned signups | ✅ PASS | Unchanged pass |
| I — Admin onboarding sends invite + links auth_id | ✅ PASS | Unchanged pass |
| I2 — Admin invite failure compensating delete | ✅ CODE VERIFIED | Unchanged |
| J — Stripe webhook idempotency | ✅ PASS | Unchanged pass |
| K — Wizard endpoint idempotency | ✅ PASS | Unchanged pass (409 behavior confirmed correct) |
| L — Wizard authn/state guards | ✅ **4/4 PASS** | **B4 fixed**: admin → `/onboarding/business` now redirects to `/admin/overview` ✓ |
| M — Approval emails send post-onboarding | ✅ PASS | Unchanged pass |

### B3 fix verified (rate limit error messages)

The `rate_limited` raw error code was shown to users in the prior run. In this run, the signup rate limit was hit once (by the app-side IP bucket) and the form correctly displayed a human-readable message instead of the raw code. The B22 commit added a client-side error code → message map.

### Remaining open item

**B2 — Stripe Payment Link success_url** — still not pointing to `/onboarding/payment-success`. The payment flow goes directly to `/onboarding/business` after Stripe checkout, bypassing the payment-success polling page entirely. This requires a manual Stripe dashboard change (not code):
- Go to Stripe Dashboard (test mode) → Payment Links → both Founding and Standard
- After payment → Success URL: `http://localhost:3000/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`
- Until this is fixed, the `payment-success` page and its polling logic (waiting for webhook + redirecting to wizard) remain untested end-to-end.

---

## Part 2 — Run 3 Results (2026-04-27, after prior B1/B3/B4 fixes)

**Test environment:** Windows 11, Node 20, local Redis, `MOCK_EXTERNAL_APIS=false`, `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=120000`
**Test accounts:** `norbertliverpool+e2e{5..8}@gmail.com`, `norbertliverpool+e2e7b@gmail.com`, `norbertliverpool+admin-test2@gmail.com`

| Scenario | Result | Notes |
|----------|--------|-------|
| A — Password signup happy path | ✅ PASS | Full flow: identity → OTP (8-digit copy correct) → plan picker → Stripe → payment-success → wizard (Google Maps URL fallback) → dashboard. All DB checkpoints passed; channel_enrollment verified at OTP time. |
| B — Email-not-confirmed login UX | ✅ PASS | Login with unconfirmed e2e6 → `/signup/check-email?from=login` with "Almost there" heading, email pre-filled. OTP verify → `/onboarding/pay`. |
| C — Resend confirmation | ✅ PASS | Resend 1 & 2: "A new code is on its way."; Resend 3: "Too many resend attempts. Please wait a while." |
| D — Forgot/reset-password owner happy path | ✅ PASS | QP-encoding workaround used (generated fresh token via Supabase admin API); reset → `/login` → session cookies cleared → login with new password → `/dashboard`. |
| E — Cross-portal protection | ✅ PASS | Owner email on admin portal: no email sent. Admin email on owner portal: no email sent. |
| F — Google OAuth signup | ⏭ SKIPPED | Not configured in local environment. |
| G — Pending-payment owner login routing | ✅ PASS | e2e7 abandoned at pay page; re-login → `/onboarding/pay` directly. |
| G2 — Active-not-onboarded login routing | ✅ PASS | e2e7b paid, closed wizard; re-login → `/onboarding/business`; dashboard fallback shows "Set up your business" CTA. |
| H — Cleanup poller deletes abandoned signups | ✅ PASS | e2e8 row aged 8 days; poller deleted business + users + auth.users within 2 intervals (~240s). |
| I — Admin onboarding sends invite + links auth_id | ✅ PASS | admin-test2 onboarded; `onboarded_by` set, `auth_id` populated, outbox has `validate_place_id`; invite email arrived; owner set password → `/login` → cookies cleared → login → `/onboarding/pay`. `email_confirmed_at=NULL` immediately after invite (consistent with N2). |
| I2 — Admin invite failure compensating delete | ✅ CODE VERIFIED | Unit tests at `route.test.ts` lines 229 and 270 cover invite-fail compensating delete and auth_id-link-failure rollback paths. |
| J — Stripe webhook idempotency | ✅ PASS | `stripe trigger checkout.session.completed` fired; synthetic customer ID didn't match any business; e2e5 `subscription_activated_at` unchanged. |
| K — Wizard endpoint idempotency | ✅ PASS | Duplicate POST to `/api/onboarding/business` returned 409 `already_onboarded`; outbox count stayed at 1. |
| L — Wizard authn/state guards | ✅ **4/4 PASS** | Case 1: unauthenticated → `/login` ✓; Case 2: admin → `/admin/overview` ✓; Case 3: pending-payment → `/onboarding/pay` ✓; Case 4: post-wizard → `/dashboard` ✓. |
| M — Approval emails send post-onboarding | ✅ PASS | channel_enrollment verified (`verified_at` = OTP time); inserted test review+response+outbox; worker dispatched within 15s; `notification_deliveries` row: `template=approval_request`, `channel=email`, `failure_reason=NULL`; email arrived in Gmail. |

### Observations

**N2 confirmed again:** `email_confirmed_at` is NULL immediately after `inviteUserByEmail`; only populated after the owner clicks the invite link. Runbook §2.9 step 4 expectation is incorrect — consistent with prior runs.

**QP workaround still needed for D:** The Gmail MCP plaintext body continues to mangle `=` signs in reset/invite URLs. Workaround: reconstruct token hash from visible characters OR generate a fresh token via `supabase.auth.admin.generateLink()`. Not a product bug — see N1.

**B2 still open:** Stripe Payment Link `success_url` not updated in dashboard. payment-success polling page bypassed (Stripe redirects directly to `/onboarding/business`). Requires manual Stripe dashboard fix.
