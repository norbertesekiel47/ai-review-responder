# Prompt 20e — Launch Readiness Documentation + Runbook Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create launch-readiness documentation (operational runbook + pre-launch smoke test checklist) and a lightweight admin-facing "Runbook" quick-reference page. No worker or pipeline behavior changes.

**Architecture:** Two new Markdown docs in `docs/` (authoritative reference for ops), plus a single read-only Next.js page at `/admin/runbook` that surfaces the five most common "Customer says X" scenarios as a quick table and links to the full markdown file. AdminNav gets one new link. Everything is static — no new API routes, DB queries, or workers.

**Tech Stack:** Next.js 14 App Router (client component following existing admin page pattern), Tailwind CSS, Markdown for docs.

---

## File Structure

**Create:**
- `docs/operational-runbook.md` — 5 sections (customer-says-X, daily health check, debugging SQL, incident response, weekly maintenance)
- `docs/smoke-test-checklist.md` — pre-launch manual E2E verification across 3 real businesses
- `src/app/admin/runbook/page.tsx` — admin quick-reference page (read-only, static content, no data fetches)

**Modify:**
- `src/components/AdminNav.tsx` — add `Runbook` link to `navItems`

**No changes to:** workers, DB schema, API routes, middleware, tests (this prompt is docs + lightweight UI).

---

## Scope Check

This is a single coherent unit of work (docs + one static page + one nav link). No subsystem split needed.

---

### Task 1: Write the operational runbook

**Files:**
- Create: `docs/operational-runbook.md`

- [ ] **Step 1: Create the runbook file with all five sections**

Write the complete file with the exact content below. This is an authoritative ops reference — it should be copy-pasteable for whoever is oncall, with exact admin page URLs, exact SQL queries, and exact table/column names from the current schema.

```markdown
# RepWorth Operational Runbook

Authoritative ops reference for RepWorth. Written for the sales partner +
oncall engineer. Everything here should be executable without needing to
read the codebase first.

**Fast links:**
- Admin overview: https://<your-domain>/admin/overview
- Jobs page: https://<your-domain>/admin/jobs
- Notifications page: https://<your-domain>/admin/notifications
- Costs page: https://<your-domain>/admin/costs
- Email deliverability runbook: `docs/email-deliverability.md`

---

## Section A — "Customer says X" troubleshooting

Five scenarios a customer is likely to surface. Each one lists the
**fastest path to diagnose** followed by the fix.

### A1. "I never got the approval email."

**Diagnose, in order:**
1. `/admin/notifications` — filter by the customer's business. Is there
   a row with `template='approval_request'` in the last 24h? If
   `failed_at IS NOT NULL`, read `failure_reason`.
2. If no row at all — the notification never fired. Check
   `/admin/jobs` for a stuck `send_notification` outbox entry
   (`status='pending'` or `status='dispatched'` older than 1h).
3. If the notification *did* send but bounced — check
   `businesses.owner_email_bounced` on `/admin/businesses/<id>`. A red
   banner at the top of the detail page means the flag is set.
4. Check the `responses` row: is `status='pending_approval'`? If it's
   `superseded` or `failed`, the notification may have pointed at a
   dead draft.

**Fix:**
- Bounced owner → verify the email address with the customer. If the
  address is wrong, update it via the Business Profile editor
  (Edit → Owner Email). Then clear the bounce flag using the red
  banner's "Clear bounce flag" button. **Never** clear the flag until
  the address is verified — you'll just bounce again.
- Stuck outbox entry → follow "Reset stuck outbox entry" in Section C.
- Missing notification row → look for a `correlation_id` via the
  `responses.id` and trace the chain (Section C).

### A2. "The response doesn't sound like me."

**Diagnose:**
1. `/admin/businesses/<id>` → Business Profile. Is `tone` set
   appropriately? Are `highlight_facts` and `avoid_facts` populated?
   Are `staff_names` correct?
2. `sample_responses` column (visible on detail page) — the owner's
   previously-approved drafts feed few-shot voice learning. If it's
   empty, the generator has no voice reference.
3. Check the last 5-10 `responses` rows: are owners editing heavily
   before approving? Heavy edits are a signal to update `tone` or
   `highlight_facts` so future drafts start closer to the owner's voice.

**Fix:**
- Update `tone`, `highlight_facts`, `avoid_facts` via the Business
  Profile editor.
- Voice learning activates automatically once ≥5 edited+posted
  responses exist — if you're under that threshold, heavy edits are
  expected.

### A3. "I approved it but it's not posted on Google."

**Diagnose (SerpAPI-first mode — current MVP):**
1. `/admin/businesses/<id>` → find the review in the list. Status
   badge should say `awaiting_manual_post`. This is the expected state
   after approval — posting is manual in SerpAPI mode.
2. If it's `posted`, the row was already marked done. Check Google
   directly.
3. If it's still `approved` or `edited`, the outbox `publish_response`
   entry hasn't fired yet — check `/admin/jobs`.

**Fix:**
- Expected path: sales partner opens the business detail page, copies
  the approved text from the Manual Post Section, pastes it into the
  Google Business Profile UI, then clicks **Mark as posted** on the
  admin page. This transitions the row to `posted` and records
  `posted_at`.
- When GBP API access lands, this step becomes automatic — see
  `docs/Implementation_Phases_SerpAPI_First.md` Phase 5.

### A4. "I'm getting too many emails."

**Diagnose:**
1. The owner controls per-category opt-outs on `/settings`
   (authenticated owner route). Check which toggles they left ON:
   `weekly_summary_enabled`, `monthly_impact_enabled`,
   `notification_preference`.
2. Weekly Value Reports fire Monday 8-9 AM UTC. Monthly Impact fires
   the 1st of the month 9-10 AM UTC. Onboarding drips fire on days 1,
   7, 30 after `subscription_activated_at`. Approval emails fire
   per-review.

**Fix:**
- Tell the owner to log in and toggle off what they don't want on
  `/settings`, OR an admin can toggle the same columns directly via
  DB UPDATE.
- If they want all customer-facing emails off but still want approval
  emails: leave `notification_preference` as `email`, disable the
  other two flags.

### A5. "My reviews aren't being picked up."

**Diagnose:**
1. `/admin/businesses/<id>` → check `last_sync_at`. If stale (>6h
   for active businesses, >24h for pending_payment), syncs are not
   running for this business.
2. `subscription_status` — `cancelled` or `past_due` (after grace)
   stops the ReconciliationPoller from including this business.
3. `place_id_verified` — if FALSE, ReviewSyncWorker skips. Look for
   a `review_exceptions` row with `type='place_id_resolution_required'`.
4. `/admin/jobs` — any failed `sync_reviews` outbox entries? Read
   `last_error`.

**Fix:**
- SerpAPI quota exhausted → check SerpAPI dashboard. Wait for daily
  reset or top up.
- Place ID not verified → re-enter via the onboarding PlaceAutocomplete
  (admin can PATCH `google_place_id` and trigger a re-validation outbox
  entry).
- Subscription issue → resolve billing via Stripe, `subscription_status`
  transitions on webhook.

---

## Section B — Daily health check (2 minutes)

Open `/admin/overview`. Confirm every item below is within tolerance.
If anything is red, jump to Section D for the matching incident.

| Metric | Where to look | Green state |
|---|---|---|
| Failed jobs | System Health card | `0` |
| Pending outbox | System Health card | `< 50` |
| Dispatched > 1h old | `/admin/jobs` → failed list (check `created_at`) | `0` |
| Notification failures (24h) | System Health card | `0` |
| Today's cost | System Health card | `< 80%` of `DAILY_COST_LIMIT_USD` |
| Email health card | Overview page | `Green` (delivery ≥95%, no 7d hard bounces/complaints) |

If all six are green, you're done. Total time: 2 minutes.

---

## Section C — Debugging SQL queries

Run these against Supabase via the MCP console or `psql`. All are
read-only except the "Reset stuck outbox entry" query.

### C1. Trace a review end-to-end via correlation ID

Every outbox entry tagged in Sprint 6+ carries a `correlation_id` in
its `payload` JSONB. One review's entire chain (sync → generate →
notify → publish) shares the same ID.

```sql
-- Find the correlation_id from a response
SELECT payload->>'correlation_id' AS correlation_id
FROM job_outbox
WHERE aggregate_id = '<response_id>' AND topic = 'generate_response'
ORDER BY created_at DESC LIMIT 1;

-- Trace every step
SELECT id, topic, status, attempts, created_at, last_error
FROM job_outbox
WHERE payload->>'correlation_id' = '<correlation_id>'
ORDER BY created_at ASC;
```

### C2. Find stuck outbox entries

```sql
-- Dispatched older than 1 hour (poller claimed but worker never finished)
SELECT id, topic, aggregate_id, attempts, updated_at, last_error
FROM job_outbox
WHERE status = 'dispatched' AND updated_at < NOW() - INTERVAL '1 hour'
ORDER BY updated_at ASC;

-- Pending older than 10 minutes (poller is not claiming them)
SELECT id, topic, aggregate_id, created_at
FROM job_outbox
WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes'
ORDER BY created_at ASC;
```

### C3. Check a business's recent activity

```sql
SELECT
  b.name, b.subscription_status, b.last_sync_at, b.owner_email_bounced,
  (SELECT COUNT(*) FROM reviews r WHERE r.business_id = b.id) AS review_count,
  (SELECT COUNT(*) FROM responses resp WHERE resp.business_id = b.id
     AND resp.status = 'pending_approval') AS pending_count,
  (SELECT COUNT(*) FROM responses resp WHERE resp.business_id = b.id
     AND resp.status IN ('approved','edited','posted','awaiting_manual_post')) AS approved_count
FROM businesses b
WHERE b.id = '<business_id>';
```

### C4. Reset a stuck outbox entry

**Only do this after diagnosing why it's stuck** — don't just retry
blindly. The OutboxPoller has a watchdog that auto-recovers
`dispatched` rows older than 30 minutes, so manual reset is rarely
needed.

```sql
UPDATE job_outbox
SET status = 'pending', attempts = 0, last_error = NULL, updated_at = NOW()
WHERE id = '<outbox_id>' AND status IN ('failed', 'dispatched');
```

### C5. Today's cost breakdown

```sql
SELECT provider, SUM(cost_usd)::numeric(10,4) AS total_usd, COUNT(*) AS calls
FROM api_costs
WHERE created_at >= CURRENT_DATE
GROUP BY provider
ORDER BY total_usd DESC;
```

### C6. Find bounced businesses

```sql
SELECT id, name, owner_email, updated_at
FROM businesses
WHERE owner_email_bounced = TRUE
ORDER BY updated_at DESC;
```

### C7. Inspect manual-post backlog

```sql
SELECT
  b.name, resp.id AS response_id, resp.approved_at,
  EXTRACT(DAY FROM NOW() - resp.approved_at)::int AS days_waiting
FROM responses resp
JOIN businesses b ON b.id = resp.business_id
WHERE resp.status = 'awaiting_manual_post'
ORDER BY resp.approved_at ASC;
```

---

## Section D — Incident response

Six scenarios with what the system does automatically vs. what you
need to do by hand.

### D1. Worker crash (Railway worker process down)

**Auto:** BullMQ jobs queue in Redis, outbox entries accumulate in
`status='pending'`. No work is lost. Railway auto-restarts the worker.

**Manual:**
1. Check Railway dashboard → is the worker running?
2. If crashed and not restarting, check Sentry for the crash cause.
3. After worker comes back, OutboxPoller drains the backlog within
   a few minutes. Monitor `/admin/jobs` → pending count should drop.
4. Notification failover poller will retry any stale `send_notification`
   entries that were dispatched but not delivered.

### D2. Redis unavailable (Upstash outage)

**Auto:**
- BullMQ: workers cannot claim new jobs. Outbox entries pile up in
  `pending`. No data loss.
- Rate limiter: falls open in mock mode, fails closed (503) in
  production for demo generation and SerpAPI pre-fill to prevent
  uncapped third-party spend.
- Cost guard: graceful degradation — if Redis is unreachable, LLM
  calls still succeed but pessimistic reservation is skipped. The
  DB `api_costs` audit trail still records actual spend.

**Manual:**
1. Check Upstash dashboard for the outage.
2. When Redis returns, BullMQ + pollers resume automatically.
3. Reconcile `api_costs` audit against today's budget — if spend
   exceeded daily limit due to cost-guard skip, pause workers
   (scale Railway to 0) until next day.

### D3. Supabase unavailable

**Auto:** Every outbox write + API route fails. Workers retry with
backoff. Webhooks (Stripe, Resend) return 5xx — those providers
retry automatically.

**Manual:**
1. Check Supabase status page.
2. When it returns, Stripe and Resend replay failed webhooks within
   their retry windows (Stripe: 3 days, Resend/Svix: 24h).
3. If any webhooks fell outside the retry window, query the source
   dashboard (Stripe events, Resend logs) for the missing events and
   reconstruct manually.

### D4. SerpAPI quota exhausted

**Auto:** `ReviewSyncWorker` records the failure in `review_exceptions`
and skips. Cost guard prevents over-spend. No crashes.

**Manual:**
1. Check SerpAPI dashboard → daily quota status.
2. Top up the plan OR wait for daily reset.
3. When quota returns, ReconciliationPoller picks up backlog
   automatically on the next tick.

### D5. LLM provider down (OpenAI outage)

**Auto:** `ResponseGenerator` falls back to Anthropic Claude Haiku.
Costs are tracked separately in `api_costs.provider`.

**Manual:**
- If both providers are down, `responses.status='failed'` with an
  error message. Retry via outbox reset once a provider is back.

### D6. Cost circuit breaker tripped (daily limit reached)

**Auto:** Cost guard rejects new LLM + SerpAPI calls once the daily
limit is hit. Workers log the rejection, outbox entries fail with
`last_error='cost_limit_exceeded'`.

**Manual:**
1. Verify via `/admin/costs` — confirm today's total is at/over
   `DAILY_COST_LIMIT_USD`.
2. If legitimate traffic, increase `DAILY_COST_LIMIT_USD` env var
   and redeploy. Failed outbox entries will retry after reset.
3. If abuse/runaway loop, find the source (check `api_costs` by
   `business_id` and `created_at`) before raising the limit.

### D7. Resend delivery degraded

**Auto:** Bounces and complaints flow into the Resend webhook and
get classified (`bounced:hard:*` flags business, `bounced:soft:*`
is logged). Notification failover poller retries stale
`send_notification` entries.

**Manual:**
1. Check `/admin/overview` → Email Health card. If `delivery_rate_24h`
   drops below 95%, investigate.
2. Check Resend dashboard for domain reputation, DKIM/SPF/DMARC
   health.
3. See `docs/email-deliverability.md` for the warmup schedule and
   DNS troubleshooting.

---

## Section E — Weekly maintenance tasks

Every Monday morning, 10 minutes total.

- [ ] **Resend dashboard** — domain reputation, bounce rate <2%, open
  rate trending up. If reputation drops, pause marketing sends and
  re-warm.
- [ ] **Stripe dashboard** — check for failed invoices, past-due
  customers. Reconcile against `businesses.subscription_status`
  (should match).
- [ ] **`/admin/costs`** — weekly total vs. budget. Drill into the
  top 3 providers and top 3 businesses. Unexpected spikes are the
  first sign of a runaway loop.
- [ ] **SerpAPI quota** — current plan usage vs. allowance. If
  consistently >80%, upsize the plan before you hit the ceiling.
- [ ] **Outbox/archive health** — confirm ArchivalPoller ran (look
  for `job_outbox` row counts trending flat, not climbing unbounded).
  `api_costs_daily_rollups` should have rows for dates >90 days ago.
```

- [ ] **Step 2: Verify the file exists and passes a basic link/format check**

Run:
```bash
ls -la docs/operational-runbook.md
wc -l docs/operational-runbook.md
```
Expected: file exists, roughly 280-350 lines.

- [ ] **Step 3: Commit**

```bash
git add docs/operational-runbook.md
git commit -m "docs(20e): add operational runbook with 5 sections"
```

---

### Task 2: Write the pre-launch smoke test checklist

**Files:**
- Create: `docs/smoke-test-checklist.md`

- [ ] **Step 1: Create the checklist file**

Write the complete file exactly as below. This is the manual E2E test
gate for Prompt 20e — whoever runs it must physically exercise every
step against real services (Stripe test mode, real Resend, real
SerpAPI, real LLMs) before cutting a production launch.

```markdown
# RepWorth Pre-Launch Smoke Test Checklist

Manual end-to-end verification before the first paid customer. Runs
against real external services in Stripe test mode with real API keys.

**Pre-flight:**
- [ ] `MOCK_EXTERNAL_APIS=false` in the environment
- [ ] Real `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SERPAPI_KEY`,
      `RESEND_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
- [ ] Stripe in **test mode** (`STRIPE_SECRET_KEY` starts with `sk_test_`)
- [ ] `STRIPE_WEBHOOK_SECRET` points at the test-mode webhook endpoint
- [ ] `CSRF_SECRET`, `RESEND_WEBHOOK_SECRET`, `ADMIN_NOTIFICATION_EMAIL` set
- [ ] Railway worker is running; Vercel preview is deployed
- [ ] Three real Google Business Profile place IDs ready (can be
      your own test businesses or partner's — just needs real reviews)
- [ ] Three real email inboxes you can access for each test business

**Test matrix:**

| | Business A | Business B | Business C |
|---|---|---|---|
| Focus | Happy path | Edit + concurrency | Regenerate + correlation |
| Place ID | real | real | real |
| Owner email | inbox-a | inbox-b | inbox-c |

---

## Business A — Full happy path

- [ ] Onboard via `/admin/businesses/new`. Use the PlaceAutocomplete
      input to select the business. Verify the SerpAPI pre-fill
      populates `category`, `phone`, `website`, `hours` within 2
      seconds. Empty fields get filled; fields you already edited
      are preserved.
- [ ] Copy the Payment Link from the success message. Pay via Stripe
      test card `4242 4242 4242 4242` (any future date, any CVC).
- [ ] Confirm `subscription_status` transitions to `active` on
      `/admin/businesses/<id>` within 30s (Stripe webhook).
- [ ] Initial sync fires. Confirm `reviews` rows appear on the
      detail page within 2-3 minutes (SerpAPI rate permitting).
- [ ] Approval email lands in `inbox-a`. Open on a **mobile device**.
- [ ] Page loads in under 2s on a throttled mobile connection (use
      Chrome DevTools → Network → "Slow 3G" throttle).
- [ ] Click **Approve**. Page transitions to a success state.
- [ ] Confirm `responses.status='awaiting_manual_post'` in admin.
- [ ] In the admin detail page's Manual Post Section, copy the approved
      text, paste into Google Business Profile UI, then click
      **Mark as posted**. Confirm `responses.status='posted'` and
      `posted_at` is populated.

## Business B — Edit flow + concurrent onboarding

- [ ] Start onboarding Business B while Business A's sync is still
      running. Verify `/admin/businesses/new` responds normally — no
      interference.
- [ ] After payment + sync, approval email arrives.
- [ ] Click **Edit** on the approval page. Modify the response text
      (change at least 20 characters).
- [ ] Submit the edit. Confirm `responses.status='edited'`,
      `approved_text` contains your edits, and the original
      `response_text` is preserved.
- [ ] Open the same approval link again — should show the "already
      consumed" state.
- [ ] Confirm in admin that Business A's data is untouched (no
      cross-business leakage: `business_id` scoping works).

## Business C — Regeneration + correlation ID tracing

- [ ] Onboard + pay + wait for initial sync.
- [ ] Approval email arrives. Click **Regenerate** on the approval
      page. A new draft generates (may take 10-30s).
- [ ] Confirm the old response row has `status='superseded'` and a
      new response row exists with `status='pending_approval'` and
      `version` incremented.
- [ ] Confirm the **old** approval link now returns a "consumed /
      expired" state when revisited.
- [ ] A **new** approval email arrives with a fresh link. Approve it.
- [ ] Grab the new `response_id` from admin. Run the correlation
      trace from `docs/operational-runbook.md` Section C1. Confirm
      every step (sync_reviews, generate_response, send_notification,
      publish_response) is tagged with the same correlation ID.

## System health across all three businesses

- [ ] `/admin/overview` lists all three businesses.
- [ ] System Health card: pending outbox drops to <10 within 5
      minutes of the last approval. Failed jobs = 0.
- [ ] Email Health card shows green: delivery rate ≥95%, 0 complaints,
      0 hard bounces.
- [ ] `/admin/costs` shows cost entries for every provider used
      (openai, anthropic, serpapi, resend). All three businesses
      appear in the per-business breakdown.
- [ ] `/admin/notifications` lists approval email deliveries for
      all three businesses with `delivered_at` populated.
- [ ] Wait ≥4 hours. Confirm `NotificationFailoverPoller` has not
      fired spurious admin alerts (it should only alert if
      `sent_at` is set but `delivered_at` is NULL for >4h).

## Throughput sanity check (non-production only)

Seed 200 safe outbox entries and confirm OutboxPoller drains them
cleanly. **Do not run this against production.**

- [ ] Point at a staging DB or a throwaway branch of production.
- [ ] Insert 200 `job_outbox` rows with `topic='sync_reviews'` and
      valid `aggregate_id` references (or any safe idempotent topic).
- [ ] Watch `/admin/jobs` → pending count drops, dispatched count
      rises, then both return to 0 as completed grows.
- [ ] Confirm no duplicate side effects: SerpAPI call count should
      match unique `(business_id, review_id)` pairs, not 2× that.
- [ ] Confirm no rows stuck in `dispatched` status after drain.

## Approval performance check

- [ ] Open the approval page from an approval email on a phone OR
      Chrome DevTools Mobile emulation + "Slow 3G" throttle.
- [ ] Page loads (FCP) in under 2 seconds. Record the actual number.
- [ ] Approve button is responsive (tap → feedback within 200ms).

---

## Sign-off

- [ ] All three business flows completed end-to-end
- [ ] No unexpected errors in Sentry during the test run
- [ ] No orphaned/stuck outbox entries
- [ ] Email Health card green at end of run
- [ ] Costs tracked for every external call

**Run date:** ____________
**Run by:** ____________
**Result:** Pass / Fail / Fail-fix-retry
**Notes:**
```

- [ ] **Step 2: Verify the file**

Run:
```bash
ls -la docs/smoke-test-checklist.md
```
Expected: file exists, roughly 120-160 lines.

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-test-checklist.md
git commit -m "docs(20e): add pre-launch smoke test checklist"
```

---

### Task 3: Add Runbook link to AdminNav

**Files:**
- Modify: `src/components/AdminNav.tsx:7-14`

- [ ] **Step 1: Add the `Runbook` link to `navItems`**

Edit `src/components/AdminNav.tsx`. Change the `navItems` array from:

```tsx
const navItems = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/businesses', label: 'Businesses' },
  { href: '/admin/demos', label: 'Demos' },
  { href: '/admin/costs', label: 'Costs' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/jobs', label: 'Jobs' },
] as const;
```

to:

```tsx
const navItems = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/businesses', label: 'Businesses' },
  { href: '/admin/demos', label: 'Demos' },
  { href: '/admin/costs', label: 'Costs' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/jobs', label: 'Jobs' },
  { href: '/admin/runbook', label: 'Runbook' },
] as const;
```

No other changes to this file — the desktop + mobile rendering logic
already iterates over `navItems` and the active-link highlight handles
the new entry automatically.

- [ ] **Step 2: Verify**

```bash
pnpm tsc --noEmit
```
Expected: clean (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/AdminNav.tsx
git commit -m "feat(20e): add Runbook link to admin navigation"
```

---

### Task 4: Create the admin Runbook page

**Files:**
- Create: `src/app/admin/runbook/page.tsx`

- [ ] **Step 1: Create the page**

The page is a static client component (the codebase convention for
admin pages — `src/app/admin/overview/page.tsx` and friends are all
`'use client'`). It renders the five "Customer says X" scenarios as
a quick-reference table and points to `docs/operational-runbook.md`
for the full version.

Auth is handled by `src/middleware.ts` (admin/sales_partner role
required) and `src/app/admin/layout.tsx` provides the nav + providers.

**Important path note:** create the file at
`src/app/admin/runbook/page.tsx`, **NOT**
`src/app/(admin)/runbook/page.tsx`. The live app uses flat
`src/app/admin/...` routes — the admin layout lives at
`src/app/admin/layout.tsx`.

Write the following content:

```tsx
'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface Scenario {
  id: string;
  customerSays: string;
  firstCheck: string;
  fix: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'A1',
    customerSays: 'I never got the approval email.',
    firstCheck:
      '/admin/notifications → filter by business → read failure_reason. If no row, check /admin/jobs for stuck send_notification outbox. Also check owner_email_bounced on the business detail page.',
    fix: 'Verify the owner email address. If wrong, update via Business Profile editor (Edit → Owner Email), then clear the bounce flag via the red banner button. Never clear the flag before verifying.',
  },
  {
    id: 'A2',
    customerSays: "The response doesn't sound like me.",
    firstCheck:
      'Business Profile → check tone, highlight_facts, avoid_facts, staff_names. Review recent owner edits — heavy edits signal a context gap.',
    fix: 'Update tone + facts in Business Profile. Voice learning activates automatically once ≥5 edited+posted responses exist.',
  },
  {
    id: 'A3',
    customerSays: "I approved it but it's not posted on Google.",
    firstCheck:
      'Business detail page → review list → status badge. Expected: awaiting_manual_post after approval in SerpAPI mode. Manual posting is normal for MVP.',
    fix: 'Sales partner copies approved text from Manual Post Section, pastes into Google Business Profile, then clicks "Mark as posted". GBP API auto-post lands in Phase 5.',
  },
  {
    id: 'A4',
    customerSays: "I'm getting too many emails.",
    firstCheck:
      'Owner controls opt-outs on /settings. Check weekly_summary_enabled, monthly_impact_enabled, notification_preference columns.',
    fix: 'Owner logs in → /settings → toggle off unwanted categories. Admins can UPDATE the same columns directly if needed.',
  },
  {
    id: 'A5',
    customerSays: "My reviews aren't being picked up.",
    firstCheck:
      'Business detail → last_sync_at (stale >6h?), subscription_status (cancelled?), place_id_verified (false?). Check /admin/jobs for failed sync_reviews.',
    fix: 'SerpAPI quota exhausted → top up or wait for reset. Place ID unverified → re-enter via PlaceAutocomplete. Billing issue → resolve in Stripe.',
  },
];

export default function RunbookPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Operational Runbook</h1>
        <p className="mt-1 text-sm text-gray-600">
          Quick reference for the five most common customer-facing issues.
          For the full runbook (daily health check, debugging SQL,
          incident response, weekly maintenance), see{' '}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800">
            docs/operational-runbook.md
          </code>{' '}
          in the repo.
        </p>
      </header>

      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-800">
            &quot;Customer says X&quot; — quick reference
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  #
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Customer says
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  First check
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Fix
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {SCENARIOS.map((s) => (
                <tr key={s.id} className="align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {s.id}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {s.customerSays}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{s.firstCheck}</td>
                  <td className="px-4 py-3 text-gray-700">{s.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <p className="font-semibold">Need more?</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            Daily health check, debugging SQL, incident response, weekly
            maintenance →{' '}
            <code className="rounded bg-white px-1 text-xs">
              docs/operational-runbook.md
            </code>
          </li>
          <li>
            Pre-launch verification →{' '}
            <code className="rounded bg-white px-1 text-xs">
              docs/smoke-test-checklist.md
            </code>
          </li>
          <li>
            Email deliverability &amp; DNS →{' '}
            <code className="rounded bg-white px-1 text-xs">
              docs/email-deliverability.md
            </code>
          </li>
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

```bash
pnpm tsc --noEmit
```
Expected: clean.

```bash
pnpm build
```
Expected: build succeeds. Route list should include
`○ /admin/runbook` (static, prerendered).

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/runbook/page.tsx
git commit -m "feat(20e): add admin Runbook quick-reference page"
```

---

### Task 5: Final verification + status doc update

**Files:**
- Modify: `.claude/CLAUDE.md` (Sprint 6 status section)
- Modify: `docs/progresstracking.md`

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test -- --run
```
Expected: all tests pass (this prompt adds no tests and should not
break any — count should match the pre-prompt baseline of 689).

- [ ] **Step 2: Run tsc + build one more time**

```bash
pnpm tsc --noEmit && pnpm build
```
Expected: both clean.

- [ ] **Step 3: Update `.claude/CLAUDE.md` — append Prompt 20e completion entry**

Find the Sprint 6 IN PROGRESS section and add a new bullet after the
Prompt 20d entry:

```markdown
  - Prompt 20e (Launch Readiness Documentation): COMPLETE (2026-04-17) — `docs/operational-runbook.md` (5 sections: customer-says-X, daily 2-min health check, debugging SQL, incident response for 7 scenarios, weekly maintenance). `docs/smoke-test-checklist.md` (3-business pre-launch E2E across happy path / edit+concurrency / regenerate+correlation, throughput sanity check, mobile approval perf check). `/admin/runbook` quick-reference page (static, renders 5 Customer-says-X scenarios as a table, links to full markdown). AdminNav `Runbook` link. No worker or pipeline changes. 689/689 tests passing.
  - New files: `docs/operational-runbook.md`, `docs/smoke-test-checklist.md`, `src/app/admin/runbook/page.tsx`
```

Also flip the Sprint 6 header status to COMPLETE once every prompt
line (20a through 20e) shows COMPLETE. This is the final prompt of
Sprint 6.

- [ ] **Step 4: Update `docs/progresstracking.md`**

Append a brief Prompt 20e completion entry matching the existing
style in that file. (Read the file first to match tone/format.)

- [ ] **Step 5: Commit**

```bash
git add .claude/CLAUDE.md docs/progresstracking.md
git commit -m "docs(20e): mark Prompt 20e + Sprint 6 complete"
```

---

## Self-Review

**1. Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Section A: 5 "customer says X" scenarios | Task 1 |
| Section B: Daily 2-min health check | Task 1 |
| Section C: Debugging SQL (correlation, stuck outbox, activity, reset, costs, bounces, manual-post backlog) | Task 1 |
| Section D: 6 (+1) incident response scenarios | Task 1 |
| Section E: Weekly maintenance tasks | Task 1 |
| `docs/smoke-test-checklist.md` with 3 real businesses, mock=false, real API keys, Stripe test mode | Task 2 |
| Business A happy path: onboard+prefill, Stripe, sync, email, mobile approve, awaiting_manual_post, mark posted | Task 2 |
| Business B: edit + concurrent onboarding, no cross-business interference | Task 2 |
| Business C: regeneration + correlation trace, superseded check, old link rejected | Task 2 |
| System health: all 3 in overview, costs, notifications, email health, failover after 4h | Task 2 |
| Throughput sanity (200 seeded outbox entries, non-prod) | Task 2 |
| Approval performance (<2s on throttled mobile) | Task 2 |
| Runbook link in AdminNav | Task 3 |
| `src/app/admin/runbook/page.tsx` (not `(admin)/`) | Task 4 |
| Render 5 scenarios as quick table, link to full markdown | Task 4 |
| Run `pnpm build` after nav/page change | Task 4 |

All spec items covered.

**2. Placeholder scan:** None — every task shows the exact content,
exact file paths, and exact commands.

**3. Type consistency:** The `Scenario` interface matches all five
`SCENARIOS` entries. `navItems` structure preserved (new entry uses
the same `{ href, label }` shape). No type mismatches.
