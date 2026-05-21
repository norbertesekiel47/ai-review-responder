# RepWorth — Personal End-to-End Testing Guide

Last updated: 2026-04-13

This document walks you through manually testing every feature built in Sprints 1-4. Follow the sections in order — each builds on the previous.

---

## Prerequisites — Get Everything Running

### 1. Environment Setup

Make sure `.env.local` has all required variables filled in:

```bash
# Required for ALL testing
DATABASE_POOL_URL=           # Supabase pooled connection
SUPABASE_URL=                # Supabase instance URL
SUPABASE_SERVICE_KEY=        # Server-only admin key
NEXT_PUBLIC_SUPABASE_URL=    # Same as SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # Public anon key
NEXT_PUBLIC_APP_URL=http://localhost:3000
WORKER_SERVICE_URL=http://localhost:3001
SESSION_COOKIE_SECRET=       # 32+ char random string
CSRF_SECRET=                 # 32+ char random string

# For mock mode testing (no API costs)
MOCK_EXTERNAL_APIS=true
REDIS_CACHE_URL=redis://127.0.0.1:6379/0
REDIS_QUEUE_URL=redis://127.0.0.1:6379/1

# For real API testing (costs money)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
SERPAPI_API_KEY=
RESEND_API_KEY=
RESEND_FROM_EMAIL=RepWorth <notifications@yourdomain.com>
ADMIN_NOTIFICATION_EMAIL=your-email@example.com

# For Stripe testing
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/xxx
STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/yyy
```

### 2. Start Services

You need 3 things running:

**Terminal 1 — Redis:**
```bash
docker run -d --name redis-dev -p 6379:6379 redis:7-alpine
# Or if already running: docker start redis-dev
```

**Terminal 2 — Next.js dev server:**
```bash
pnpm dev
# Runs on http://localhost:3000
```

**Terminal 3 — Railway worker:**
```bash
pnpm worker
# Runs on http://localhost:3001
```

### 3. Verify Services Are Up

```bash
# Worker health check
curl http://localhost:3001/api/health
# Expected: {"status":"ok","timestamp":"..."}

# Next.js landing page
curl -s http://localhost:3000 | head -5
# Expected: HTML with "RepWorth"
```

### 4. Admin Auth Setup

If you haven't created admin auth accounts yet:

1. Go to Supabase dashboard → Authentication → Users → Add User
2. Create your admin account with email/password
3. Run SQL to link it:
   ```sql
   UPDATE users SET auth_id = '<supabase-auth-user-uuid>' WHERE email = 'your-email@example.com';
   ```

---

## Test 1: Landing Page (Sprint 1)

**URL:** http://localhost:3000

### What to check:

- [x] Page loads with warm cream/amber design (not the old "Landing Page" placeholder)
- [x] Nav bar shows "RepWorth" logo on the left, "Admin Login" button on the right
- [x] Hero section has cream background with "Every review answered. Zero effort." headline
- [x] "Zero effort." is in amber color
- [x] "Get Started" button is amber, links to `/admin/login`
- [x] "See How It Works" button scrolls smoothly to the How It Works section
- [x] How It Works section shows 4 steps: Monitor → Generate → Approve → Post
- [x] Each step has an amber number circle
- [x] Features section has 6 cards with emoji icons on cream background
- [x] Pricing section shows 2 tiers: Founding ($99/mo) with amber "Limited" badge, Standard ($149/mo)
- [x] Founding card has amber ring highlight
- [x] Footer shows "RepWorth · AI Review Responder" and "Admin" link
- [x] All "Admin Login" / "Get Started" / "Admin" links go to `/admin/login`

### Mobile test:

- [x] Resize browser to ~375px width (phone)
- [x] Cards stack to single column
- [x] CTA buttons stack vertically
- [x] Text is readable, nothing overflows

---

## Test 2: Admin Login (Sprint 3)

**URL:** http://localhost:3000/admin/login

### What to check:

- [x] Login page shows "RepWorth Admin" heading
- [x] Email and password fields are visible
- [x] Enter valid admin credentials → redirected to `/admin/overview`
- [x] Enter wrong password → see error message, stay on login page
- [x] Enter non-existent email → see error message

### Auth protection:

- [x] Visit `/admin/overview` while logged out → redirected to `/admin/login?from=/admin/overview`
- [x] Visit `/admin/businesses` while logged out → redirected to login
- [x] Visit `/admin/costs` while logged out → redirected to login
- [x] Visit `/api/admin/overview` while logged out → 401 JSON response
- [x] Visit `/approve/fake-token` while logged out → page loads (NO auth required — this is public)
- [x] Visit `/demo/fake-slug` while logged out → page loads (NO auth required)

---

## Test 3: Admin Overview Dashboard (Sprint 3)

**URL:** http://localhost:3000/admin/overview (must be logged in)

### What to check:

- [x] System health cards at top: Pending Outbox, Failed Jobs, Today's Cost, Notification Failures (24h)
- [x] Cards show numbers (likely 0 for a fresh system)
- [x] Business table below (empty if no businesses onboarded yet)
- [x] Page auto-refreshes every 30 seconds (watch the data timestamp or network tab)

---

## Test 4: Business Onboarding (Sprint 3)

**URL:** http://localhost:3000/admin/businesses/new

### Test Case 4a: Onboard a Business (Mock Mode)

Make sure `MOCK_EXTERNAL_APIS=true` in `.env.local`.

- [x] Fill in the form:
  - Business Name: "Test Taco Shop"
  - Category: "restaurant"
  - Google Maps URL: `https://www.google.com/maps/place/any+restaurant` (any valid-looking URL) https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4
  - Owner Name: "Maria Garcia"
  - Email: "maria@test.local"
  - Phone: (optional)
  - Notification Preference: email
  - Tone: "Warm and casual"
  - Products/Services: "Tacos, burritos, horchata"
  - Staff Names: "Maria, Carlos, Ana"
  - Highlight Facts: "Family-owned since 2010, homemade tortillas"
  - Avoid Facts: "Do not mention delivery times"
  - Subscription Tier: Founding ($99/mo)
- [x] Click Submit
- [x] See Payment Link URL copied to clipboard (alert pops up)
- [x] Redirected to `/admin/businesses/[id]`

### Verify in the database (Supabase SQL editor):

```sql
-- Check the business was created
SELECT id, name, subscription_status, google_place_id FROM businesses ORDER BY created_at DESC LIMIT 1;
-- Expected: subscription_status = 'pending_payment'

-- Check the owner user was created
SELECT id, name, email, role, business_id FROM users WHERE email = 'maria@test.local';
-- Expected: role = 'owner', business_id matches the business

-- Check the initial sync was queued
SELECT id, topic, status, payload FROM job_outbox WHERE topic = 'sync_reviews' ORDER BY created_at DESC LIMIT 1;
-- Expected: status = 'pending' or 'dispatched', payload has the business_id
```

### Test Case 4b: Business List

- [x] Visit `/admin/businesses`
- [x] "Test Taco Shop" appears in the table
- [x] Status badge shows "pending_payment" (yellow/gray)
- [x] Click the row → goes to `/admin/businesses/[id]`
- [x] "Add Business" button → goes to `/admin/businesses/new`

### Test Case 4c: Business Detail Page

**URL:** `/admin/businesses/[id]` (the business you just created)

- [x] Business profile section shows name, category, tone, etc.
- [x] Try editing the business name inline → save → verify it updates
- [x] Review list section (may be empty or have mock reviews from the initial sync)
- [x] "Awaiting Manual Post" section at the bottom (empty initially)

---

## Test 5: Stripe Payment Flow (Sprint 3)

**Prerequisites:** Stripe test mode keys configured in `.env.local`. Stripe CLI or webhook forwarding to `localhost:3001/ingress/stripe`.

### Test Case 5a: Forward Stripe Webhooks Locally

```bash
# Install Stripe CLI: https://stripe.com/docs/stripe-cli
stripe listen --forward-to localhost:3001/ingress/stripe
# Note the webhook signing secret (whsec_...) and put it in STRIPE_WEBHOOK_SECRET
```

### Test Case 5b: Complete Checkout

- [x] Copy the Payment Link URL from when you onboarded the business (or construct one: `https://buy.stripe.com/xxx?client_reference_id={businessId}&prefilled_email=maria@test.local`)
- [x] Open in browser → Stripe checkout page
- [x] Use test card: `4242 4242 4242 4242`, any future expiry, any CVC
- [x] Complete checkout
- [x] Check worker logs — should see `[ingress/stripe] Business {id} activated`

### Verify:

```sql
SELECT subscription_status, stripe_customer_id, stripe_subscription_id FROM businesses WHERE name = 'Test Taco Shop';
-- Expected: subscription_status = 'active', stripe fields populated
```

- [x] After activation, the ReconciliationPoller should pick up the business within 60 minutes (or immediately on next poll cycle)
- [x] In worker logs, look for: `[ReconciliationPoller] Queued 1 sync_reviews outbox entries`

---

## Test 6: Demo Generation (Sprint 1)

**URL:** http://localhost:3000/admin/demos (must be logged in)

### Test Case 6a: Generate a Demo (Mock Mode)

With `MOCK_EXTERNAL_APIS=true`:

- [x] Enter a Google Maps URL (any valid-looking URL works in mock mode)
- [x] Enter business name: "Demo Pizza Place"
- [x] Click "Generate Demo"
- [x] See status change: queued → running → completed (polls automatically)
- [x] "Copy Link" button appears

### Test Case 6b: View the Demo

- [x] Click "Copy Link" or open the demo URL directly: `/demo/[slug]`
- [x] Demo viewer page shows:
  - [x] Business name at the top
  - [x] 8 mock reviews with star ratings (Alice 5★, Bob 1★, Carlos 4★ in Spanish, etc.)
  - [x] AI-generated response below each review
  - [x] Multilingual responses (Spanish response for Carlos, French for Élise, German for Hans)
  - [x] View count increments on each visit

### Test Case 6c: Generate with Real API (costs money)

Set `MOCK_EXTERNAL_APIS=false` and ensure `SERPAPI_API_KEY` and `OPENAI_API_KEY` are set:

- [x] Use a real Google Maps URL for a business with reviews (e.g., a local restaurant)
- [x] Click Generate → wait 30-60 seconds
- [x] Demo shows REAL reviews from Google Maps with personalized AI responses
- [x] Responses reference specific things mentioned in the reviews (dishes, staff names, etc.)
- [x] Non-English reviews get responses in the same language

### Test Case 6d: Rate Limiting

- [x] Try generating more than 5 demos in 1 minute → should see 429 rate limit error
- [x] Rate resets after 60 seconds

---

## Test 7: Review Sync Pipeline (Sprint 2)

**Prerequisites:** An active business (subscription_status = 'active') with a google_place_id. Worker running.

### Test Case 7a: Mock Mode Sync

With `MOCK_EXTERNAL_APIS=true`:

- [x] If business is active, ReconciliationPoller queues a sync_reviews outbox entry every 60 minutes
- [x] Worker log shows: `[ReviewSyncWorker] ...` processing the sync
- [x] Mock reviews (8 canned reviews) are inserted into the `reviews` table
- [x] For each new review, a `generate_response` outbox entry is created

### Verify:

```sql
-- Check reviews were ingested
SELECT id, reviewer_name, star_rating, detected_language FROM reviews 
WHERE business_id = '<your-business-id>' ORDER BY detected_at DESC;

-- Check response generation was queued
SELECT topic, status FROM job_outbox 
WHERE topic = 'generate_response' AND payload->>'business_id' = '<your-business-id>' 
ORDER BY created_at DESC;
```

### Test Case 7b: Response Generation

- [x] After ReviewSyncWorker creates generate_response outbox entries, watch worker logs
- [x] ResponseGeneratorWorker picks them up: `[ResponseGeneratorWorker] ...`
- [x] In mock mode: instant template responses. In real mode: OpenAI API call (may take 2-5 seconds)
- [x] After generation, a `send_notification` outbox entry is created

### Verify:

```sql
SELECT id, response_text, status, llm_provider, llm_model FROM responses
WHERE business_id = '<your-business-id>' ORDER BY created_at DESC;
-- Expected: status = 'pending_approval', response_text contains a personalized response
```

---

## Test 8: Notification + Approval Flow (Sprint 2)

### Test Case 8a: Approval Email (Mock Mode)

With `MOCK_EXTERNAL_APIS=true`:

- [x] After response generation, NotificationWorker runs
- [x] Worker log shows: `[NotificationWorker] [MOCK] Approval email to=maria@test.local ...`
- [x] The log includes the approval URL: `http://localhost:3000/approve/{token}`
- [x] Copy that URL from the worker logs

### Test Case 8b: Approval Email (Real Mode)

With `MOCK_EXTERNAL_APIS=false` and Resend configured:

- [ ] The owner actually receives an email at their configured address
- [ ] Email shows star rating, reviewer name, response preview
- [ ] "Review & Approve" button links to `/approve/{token}`

### Test Case 8c: Approve a Response

- [x] Open the approval URL in your browser: `http://localhost:3000/approve/{token}`
- [x] Page shows business name + "Review a draft response"
- [x] Review card shows star rating, reviewer name, review text
- [x] Response card shows the AI-drafted response
- [x] Expiry countdown shows hours remaining
- [x] Click **"Approve"**
- [x] Green success message appears

### Verify:

```sql
SELECT status, approved_text FROM responses WHERE id = '<response-id>';
-- Expected: status = 'approved', approved_text = response_text

SELECT status, consumed_at FROM approval_links WHERE response_id = '<response-id>';
-- Expected: consumed_at IS NOT NULL

SELECT topic, status FROM job_outbox 
WHERE topic = 'publish_response' AND payload->>'response_id' = '<response-id>';
-- Expected: a publish_response outbox entry was created
```

### Test Case 8d: Edit a Response

Use a DIFFERENT response (you need a fresh approval link — each can only be used once):

- [x] Open a fresh approval URL
- [x] Click **"Edit"**
- [x] Textarea appears with the draft response
- [x] Modify the text (e.g., add "Best regards, Maria" at the end)
- [x] Click **"Save & Approve"**
- [x] Green success message appears

### Verify:

```sql
SELECT status, approved_text, edited_text, edit_distance FROM responses WHERE id = '<response-id>';
-- Expected: status = 'edited', edited_text contains your modifications, edit_distance > 0
```

### Test Case 8e: Regenerate a Response

Use a DIFFERENT response with a fresh approval link:

- [x] Open approval URL
- [x] Click **"Regenerate"**
- [x] Success message: something about generating a new response

### Verify:

```sql
-- Old response should be superseded
SELECT status FROM responses WHERE id = '<old-response-id>';
-- Expected: status = 'superseded'

-- New generate_response outbox entry should exist
SELECT topic, status, payload FROM job_outbox 
WHERE topic = 'generate_response' AND payload->>'review_id' = '<review-id>'
ORDER BY created_at DESC LIMIT 1;
-- Expected: version > 1 in the payload
```

### Test Case 8f: Expired Link

```sql
-- Manually expire an approval link for testing
UPDATE approval_links SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = '<link-id>';
```

- [x] Open the approval URL → should see "This approval link has expired."

### Test Case 8g: Already-Used Link

- [x] Open an approval URL that was already approved → should see "This response has already been approved."

---

## Test 9: Manual Posting Flow (Sprint 2)

### Test Case 9a: Publisher Worker

After a response is approved:

- [x] Worker log shows: `[ResponsePublisherWorker] ...`
- [x] In mock mode: log shows manual post email content
- [x] In real mode: admin receives email with approved text + Google Maps link

### Test Case 9b: Admin Marks as Posted

- [x] Go to `/admin/businesses/[id]`
- [x] Scroll to "Awaiting Manual Post" section
- [x] See the approved response with reviewer name and star rating
- [x] Click **"Copy to Clipboard"** → paste somewhere to verify the text
- [x] Click **"Mark as Posted"**
- [x] Response moves from "Awaiting Manual Post" to the review list with green "posted" badge

### Verify:

```sql
SELECT status, posted_at FROM responses WHERE id = '<response-id>';
-- Expected: status = 'posted', posted_at IS NOT NULL
```

---

## Test 10: Admin Monitoring Pages (Sprint 3)

### Test Case 10a: Costs Page

**URL:** `/admin/costs`

- [x] Shows cost breakdown by provider (openai/anthropic/serpapi)
- [x] Shows cost by business
- [x] Shows daily totals
- [x] If any business is above 80% of daily limit, row is highlighted red
- [x] Date range filter works (7d, 30d, 90d)

### Test Case 10b: Notifications Page

**URL:** `/admin/notifications`

- [x] Shows notification delivery log
- [x] Filter by business (dropdown)
- [x] Filter by channel (email)
- [x] Filter by status (delivered/failed/pending)
- [x] Pagination works (20 per page)

### Test Case 10c: Jobs Page

**URL:** `/admin/jobs`

- [x] Shows summary cards: Pending, Dispatched, Failed, Completed Today
- [x] Shows BullMQ queue depth per queue (if Redis is running)
- [x] If Redis is unavailable, shows "unavailable" gracefully instead of crashing
- [x] Failed jobs table at bottom (if any)

---

## Test 11: Weekly Summary (Sprint 4)

The WeeklySummaryScheduler only fires on Monday 8-9 AM UTC. To test manually:

### Test Case 11a: Manual Trigger via Outbox

```sql
-- Insert a weekly_summary outbox entry manually
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
VALUES (
  gen_random_uuid(),
  'weekly_summary',
  'business',
  '<your-business-id>',
  '{"business_id":"<your-business-id>","week_start_date":"2026-04-06"}'::jsonb,
  'pending'
);
```

- [ ] Worker picks it up within 10 seconds (OutboxPoller interval)
- [ ] Worker log shows: `[WeeklySummaryWorker] Weekly summary sent for Test Taco Shop`
- [ ] In mock mode: email logged to console
- [ ] In real mode: owner receives weekly summary email with review count, response rate, notable reviews

### Verify:

```sql
SELECT * FROM weekly_summaries WHERE business_id = '<your-business-id>';
-- Expected: total_reviews, total_responded populated, sent_at IS NOT NULL
```

### Test Case 11b: Idempotent (no duplicate emails)

- [ ] Insert the SAME outbox entry again (same business_id + week_start_date)
- [ ] Worker should log: "already sent" and complete without sending

---

## Test 12: Notification Failover (Sprint 4)

The NotificationFailoverPoller runs every 2 hours. To test manually:

### Test Case 12a: Simulate a Stale Notification

```sql
-- Create a response that's been pending_approval for >4 hours with no delivery
UPDATE responses SET created_at = NOW() - INTERVAL '5 hours'
WHERE id = '<a-pending-approval-response-id>';

-- Make sure there's no successful delivery
DELETE FROM notification_deliveries WHERE response_id = '<that-response-id>';

-- Make sure there's no in-flight outbox entry
DELETE FROM job_outbox WHERE topic = 'send_notification' AND aggregate_id = '<that-response-id>' AND status IN ('pending', 'dispatched');
```

- [ ] Wait for the failover poller to run (every 2 hours), or restart the worker to trigger it immediately
- [ ] Worker log shows: `[NotificationFailover] Queued 1 stale failover entries`
- [ ] A new `send_notification` outbox entry is created with `failover.reason = 'stale_no_delivery'`
- [ ] NotificationWorker re-sends the approval email with a fresh token

---

## Test 13: Archival (Sprint 4)

The ArchivalPoller runs every 24 hours. To test the cleanup logic:

### Test Case 13a: Verify Old Data Gets Cleaned

```sql
-- Create some old completed outbox entries (>7 days)
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, completed_at)
VALUES (gen_random_uuid(), 'test_cleanup', 'test', gen_random_uuid(), '{}'::jsonb, 'completed', NOW() - INTERVAL '8 days');

-- Create some old processed inbound events (>30 days)
INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status, processed_at)
VALUES (gen_random_uuid(), 'test', 'test_cleanup_' || gen_random_uuid(), 'test', '{}'::jsonb, 'processed', NOW() - INTERVAL '31 days');
```

- [ ] Wait for archival poller to run (every 24 hours), or restart worker
- [ ] Worker log shows: `[ArchivalPoller] Archived: X outbox entries, Y inbound events, Z expired demos`

---

## Test 14: Security Verification (Sprint 4)

### Test Case 14a: Run Security Tests

```bash
pnpm test -- src/lib/shared/__tests__/security.test.ts
# Expected: all tests pass
```

### Test Case 14b: Run Webhook Dedup Tests

```bash
pnpm test -- worker/__tests__/webhook-dedup.test.ts
# Expected: all 7 tests pass
```

### Test Case 14c: Run Full Test Suite

```bash
pnpm test
# Expected: 219 tests pass across 19 files
```

### Test Case 14d: Manual Security Checks

- [ ] Visit `/admin/overview` without logging in → redirected to `/admin/login`
- [ ] Try accessing `/api/admin/overview` without auth → 401 response
- [ ] Approval page works without auth (token-based, not session-based)
- [ ] Open browser DevTools → Network tab → check response headers:
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`

---

## Test 15: Sentry Error Tracking (Sprint 3)

### Test Case 15a: Trigger a Test Error

```bash
# Next.js side — visit a page that errors
curl http://localhost:3000/api/admin/overview
# Without auth this returns 401 — but check Sentry dashboard for the request
```

- [ ] Check Sentry dashboard → see the error appear
- [ ] Verify sensitive data is NOT in the error payload (no API keys, tokens, passwords)

---

## Full End-to-End Happy Path (Complete Walkthrough)

This is the golden path — everything working together:

1. **Start services:** Redis + `pnpm dev` + `pnpm worker`
2. **Visit landing page** at `http://localhost:3000` → see the marketing page
3. **Log in** at `/admin/login` with admin credentials
4. **Onboard a business** at `/admin/businesses/new` → fill form → finish payment
5. **Complete Stripe checkout** with test card `4242 4242 4242 4242`
6. **Verify activation** in worker logs: `Business {id} activated`
7. **Wait for ReconciliationPoller** (up to 60 min, or restart worker to trigger immediately)
8. **Watch the pipeline fire:**
   - `[ReconciliationPoller] Queued 1 sync_reviews`
   - `[ReviewSyncWorker] ...` (reviews ingested)
   - `[ResponseGeneratorWorker] ...` (AI drafts generated)
   - `[NotificationWorker] ...` (approval emails sent)
9. **Open approval URL** from worker logs (mock mode) or email (real mode)
10. **Approve the response** → click "Approve"
11. **Watch publisher fire:** `[ResponsePublisherWorker] ...` → manual post email sent
12. **Go to business detail** `/admin/businesses/[id]` → see "Awaiting Manual Post"
13. **Copy text, mark as posted** → response shows green "posted" badge
14. **Check overview dashboard** `/admin/overview` → response rate updated

**Estimated time for full walkthrough:**
- Mock mode: ~5 minutes (instant APIs, 10-second outbox polling)
- Real mode: ~10-15 minutes (API latency, email delivery, 60-min polling wait)

---

## Troubleshooting

### "Page shows blank / error after visiting approval URL"
- Clear `.next` cache: `rm -rf .next && pnpm dev`
- Check that the Supabase `@supabase/ssr` module resolves correctly

### "Worker logs show Redis ECONNREFUSED"
- Start Redis: `docker start redis-dev` or `docker run -d --name redis-dev -p 6379:6379 redis:7-alpine`
- Rate limiter and cost tracker gracefully skip when Redis is unavailable, but BullMQ queue won't work

### "Approval page hangs instead of showing error"
- This was fixed in Sprint 4 — Redis cache client now fails fast (3-second timeout)
- If still happening, check `REDIS_CACHE_URL` in `.env.local` isn't pointing to a dead host

### "ReconciliationPoller doesn't pick up the business"
- Business must have `subscription_status = 'active'` (not `pending_payment`)
- Business must have a non-null `google_place_id`
- Check `last_sync_at` — if it synced within 60 minutes, it won't sync again

### "Demo generation fails"
- In mock mode: should always work (no external calls)
- In real mode: check `SERPAPI_API_KEY` is valid, Google Maps URL is a real place
- Check rate limits: 50/day global, 5/min per IP

### "Stripe webhook doesn't fire"
- Make sure `stripe listen --forward-to localhost:3001/ingress/stripe` is running
- Make sure `STRIPE_WEBHOOK_SECRET` matches the CLI output
- Check worker logs for `[ingress/stripe]` messages

### "Approval email not received"
- In mock mode: check worker logs for `[MOCK] Approval email` with the URL
- In real mode: check Resend dashboard for delivery status
- Check `RESEND_FROM_EMAIL` uses a verified domain
- Check `notification_deliveries` table for failure records
