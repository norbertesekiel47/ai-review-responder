# Review Generation Engine — Design Spec

**Date:** 2026-05-09
**Branch:** feature/review-generation-engine (to be created)
**Status:** Awaiting implementation plan

---

## Overview

RepWorth currently responds to reviews after they appear on Google. This feature adds a proactive layer: helping businesses *get more reviews* in the first place, and *intercepting unhappy customers* before they publish a 1-star publicly.

The engine has three entry points (QR code, CSV upload, Zapier) that all funnel into a single hosted survey page. The survey routes customers to Google if happy (4–5 stars) or to a private feedback form if unhappy (1–3 stars). Unhappy ratings trigger an owner alert via their existing notification channel — no new preference UI needed.

---

## Goals

- Give SMB owners a passive, low-effort way to generate more Google reviews
- Intercept dissatisfied customers before they post publicly
- Support three contact-capture methods: QR code (walk-in), CSV (bulk), Zapier (automated)
- Reuse all existing infrastructure: outbox pattern, notification channels, worker layout

## Non-Goals

- NFC cards (deferred)
- POS direct integrations (Square, OpenTable, Fresha) — handled via Zapier instead
- Incentivised reviews (prohibited by Google's terms)
- Review gating (preventing any customer from reviewing publicly — not what this does; the intercept page never blocks access to Google, it simply does not redirect them there automatically)

---

## Data Model

### New table: `review_requests` (migration 042)

```sql
CREATE TABLE review_requests (
  id             uuid PRIMARY KEY DEFAULT gen_ulid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('qr_code', 'csv', 'zapier')),
  token          text NOT NULL UNIQUE,           -- URL-safe random 12 chars
  customer_name  text,                           -- null for QR scans
  customer_phone text,                           -- null for QR scans
  sent_at        timestamptz,                    -- null for QR (not "sent", just generated)
  opened_at      timestamptz,                    -- set when survey page loads
  rated_at       timestamptz,
  rating         int CHECK (rating BETWEEN 1 AND 5),
  feedback       text,                           -- only for 1–3 star ratings
  outcome        text CHECK (outcome IN ('pending', 'routed_to_google', 'intercepted')),
  send_after     timestamptz,                    -- used by Zapier delay_minutes; null = send immediately
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON review_requests (business_id, created_at DESC);
CREATE INDEX ON review_requests (account_id, created_at DESC);
CREATE INDEX ON review_requests (business_id, customer_phone) WHERE customer_phone IS NOT NULL;
```

**Notes:**
- `businesses` row = one Google Business Profile location (per multi-location architecture)
- `accounts` row = billing parent. Both IDs stored for efficient scoping.
- Token generated server-side with `randomUUID()` from `node:crypto`, trimmed to 12 chars (collision-safe at expected volumes).
- `sent_at` is null for QR codes — the code exists before any customer scans it.
- **Dedup is enforced at the application layer**, not via a partial unique index with a time predicate. Postgres rejects `now()` in index predicates (STABLE, not IMMUTABLE). Before creating a `review_request`, the worker/API route queries: `SELECT 1 FROM review_requests WHERE business_id = $1 AND customer_phone = $2 AND created_at > now() - interval '30 days' LIMIT 1`. The plain index on `(business_id, customer_phone)` makes this query fast.

---

## Components

### 1. Survey Page — `src/app/(public)/r/[token]/page.tsx`

A stateless public Next.js page. No auth, no session. Renders in under 1s on mobile.

**Stages:**

```
Stage 1: Landing
  → Business name + logo
  → "How was your visit?" 
  → Five tappable stars (large touch targets, mobile-first)

Stage 2a: Happy (4–5 stars)
  → "Thank you! Would you mind sharing on Google?"
  → One button: "Leave a Google review" → opens google.com/maps review URL in new tab
  → Page writes outcome=routed_to_google, rated_at to DB (via POST /api/r/[token]/rate)

Stage 2b: Unhappy (1–3 stars)
  → "We're sorry. What went wrong?"
  → Text area (optional — they can skip)
  → "Send feedback" button
  → Page writes outcome=intercepted, feedback, rated_at to DB
  → Fires intercept notification job via outbox
  → Shows: "Thank you — we'll be in touch shortly"
```

**On page load:** POST `/api/r/[token]/open` sets `opened_at`. Fire-and-forget, non-blocking.

**Token validation:** If token not found or already has an outcome, show a neutral "This link has expired" message — no business info exposed.

**Google review URL format:**
```
https://search.google.com/local/writereview?placeid={businesses.google_place_id}
```
Already stored on the `businesses` table.

---

### 2. API Routes (Next.js, UI-only — no side effects beyond DB writes)

```
POST /api/r/[token]/open     → sets opened_at (idempotent)
POST /api/r/[token]/rate     → writes rating, outcome, feedback; enqueues intercept job if needed
GET  /api/r/[token]/info     → returns business name + logo URL (called by survey page on load)
```

For the intercept case, `POST /api/r/[token]/rate` writes to `job_outbox` in the same transaction as the rating update — outbox pattern, never two separate writes.

---

### 3. QR Code Generator

**Where:** Dashboard → Locations tab → per-location "Get QR code" button.

**What it does:**
1. Creates or retrieves the QR `review_request` row for that location (source=`qr_code`, no phone/name, `sent_at` null, outcome=`pending`)
2. Returns a PNG QR code of `https://repworth.net/r/[token]`
3. Also returns a downloadable print-ready PDF (A6 card with business name, QR code, and "How was your visit?" copy)

**Implementation:**
- QR PNG: `qrcode` npm package, server-side in a Next.js API route
- PDF: `@react-pdf/renderer` or `pdf-lib` — simple A6 layout, no complex design
- One stable token per location — reuse the same QR code forever (don't regenerate on each click)
- If the owner wants to "reset" (e.g., location changed Google page), they can regenerate — this marks the old token expired and creates a new one

---

### 4. CSV Upload

**Where:** Dashboard → "Review Requests" section → "Send requests" → "Upload contacts" tab.

**Owner flow:**
1. Uploads a `.csv` file (accepts common column names: `name`, `phone`, `Name`, `Phone`, `mobile`, etc.)
2. RepWorth previews: "Found 143 contacts. 12 skipped (already contacted in last 30 days). 131 will be sent."
3. Owner picks channel (SMS or WhatsApp) and delay (send now / send tonight at 7pm)
4. Confirms → batch `review_request` rows created + outbox jobs queued

**CSV parsing (server-side):**
- Library: `papaparse` (already likely available, or add it)
- Accepts: name + phone columns in any order, with or without headers
- Phone normalisation: strip spaces/dashes/brackets, add country code if missing (default to owner's business country)
- Validation: skip rows with unparseable phones, skip rows where phone already has a `review_request` in this business within 30 days (dedup index handles this at DB level too)
- Max rows per upload: 500 (rate-limit safety)

**Outbox job per contact:**
```json
{
  "topic": "send_review_request",
  "payload": { "review_request_id": "..." }
}
```

---

### 5. Zapier Webhook Endpoint

**Endpoint:** `POST /api/integrations/zapier/review-request`

**Auth:** Owner-scoped API key (new `api_keys` table or reuse any existing key mechanism). Key passed as `Authorization: Bearer <key>` header.

**Request body:**
```json
{
  "customer_name": "Maria",
  "customer_phone": "+447911123456",
  "delay_minutes": 120
}
```

**Response:**
```json
{ "id": "<review_request_id>", "status": "queued" }
```

**Behaviour:**
- Validates API key → resolves to `account_id` + `business_id`
- Dedup check: if same phone sent within 30 days for this business → returns `{ "status": "skipped", "reason": "recently_contacted" }` (200, not 4xx — Zapier handles this cleanly)
- Creates `review_request` row + outbox job
- `delay_minutes` schedules when the worker should actually send (worker checks a `send_after` column)

**Zapier app config (published on Zapier developer platform):**
- One Action: "Send Review Request"
- Fields: Customer Name (optional), Customer Phone (required), Delay in minutes (optional, default 120)
- Authentication: API key

---

### 6. ReviewRequestWorker — `worker/jobs/review-request/`

Picks up `send_review_request` outbox jobs.

**Steps:**
1. Fetch `review_request` row + `businesses` row (for location name, Google place ID) + `accounts` row (for subscription status)
2. Subscription guard: if `cancelled` → mark outbox complete, no-op. `past_due` → 7-day grace (same as other workers).
3. Check `send_after` (if set and in the future) → snooze job with BullMQ `delay`
4. Render message from template:
   ```
   Hi {name}! Thanks for visiting {business_name}. 
   How was your experience? {short_url}
   ```
   Name omitted gracefully if null: "Hi there! Thanks for visiting..."
5. Send via SMS (Twilio) or WhatsApp based on owner's `notification_preference` on the account
6. Write `sent_at` on the `review_request` row
7. Mark outbox job complete

**Short URL:** `repworth.net/r/{token}` — already short enough, no URL shortener needed.

---

### 7. Intercept Notification Job — `worker/jobs/review-request/intercept-notify.ts`

Fires when a customer submits a 1–3 star rating.

**Steps:**
1. Fetch `review_request` row + `businesses` + `accounts`
2. Resolve owner's notification channel (same logic as `NotificationWorker`)
3. Send alert:
   ```
   ⚠️ {business_name} — new feedback
   {customer_name or "A customer"} left {rating} star(s).
   "{feedback_text}" (or "No written feedback left.")
   ```
4. Mark outbox job complete

No approval link needed — this is just an alert. The owner resolves it however they choose (call, email, in-person). A future iteration could add a "Mark as resolved" button but that's out of scope here.

---

## Dashboard UI

New section in the owner dashboard: **"Review Requests"** tab (alongside Dashboard, Past Replies, Settings).

### Stats row (top)
- Sent this month
- Open rate (opened / sent × 100)
- Happy rate (routed_to_google / rated × 100)
- Intercepts needing attention (intercepted and not yet resolved — for now, just a count)

### Intercept feed (main content)
A list of recent intercepts with:
- Star rating
- Customer name (or "Anonymous")
- Feedback text
- Time ago
- No action buttons in v1 — just visibility

### Send requests (secondary action)
- "Upload CSV" tab
- "Get QR code" tab (per location, for multi-location accounts)

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Token not found on survey page | Show "This link has expired" — no business info |
| Token already rated | Show "You've already submitted feedback — thank you!" |
| Twilio/WhatsApp send failure | BullMQ retries up to 3× with backoff; after exhaustion, log to Sentry, mark outbox failed |
| CSV phone parse failure | Skip row, include in preview count as "skipped (invalid)" |
| Zapier duplicate phone | Return `{ status: "skipped" }` 200 — not an error |
| Google place ID missing | Log warning; still route happy customers to `google.com/search?q={business_name}` as fallback |

---

## Testing

**Unit:**
- CSV parser: valid headers, missing headers, duplicate phones, invalid phones, >500 rows
- Token validation: missing, expired, already-rated
- Rating routing logic: 1–3 → intercept, 4–5 → google redirect

**Integration:**
- `POST /api/r/[token]/rate` happy path: DB row updated, outbox job created
- `POST /api/r/[token]/rate` intercept path: DB row updated, intercept notification job created
- Dedup guard: second request to same phone within 30 days returns skipped

**Worker:**
- ReviewRequestWorker: subscription guard (cancelled, past_due, active)
- ReviewRequestWorker: `send_after` delay respected
- InterceptNotifyWorker: sends correct channel based on notification preference

---

## Migration Summary

| # | What |
|---|---|
| 042 | `review_requests` table + indexes + dedup partial unique index |

No changes to existing tables. No new env vars (reuses existing Twilio/WhatsApp credentials).

---

## Open Questions (resolved)

| Question | Decision |
|---|---|
| NFC cards? | Deferred — QR only |
| POS direct integrations? | CSV + Zapier covers this without partner approval overhead |
| Happy threshold | 4–5 stars → Google. 1–3 → intercept. Not configurable in v1. |
| Intercept alert channel | Owner's existing `notification_preference` — no new settings |
| One QR per location or per account? | One per location (business_id) |
| Zapier auth mechanism | Owner-scoped API key, new endpoint |
