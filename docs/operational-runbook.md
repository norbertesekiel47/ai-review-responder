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
   a `review_exceptions` row with `type IN ('place_id_resolution_required',
   'place_id_resolution_failed')`. The first is written by migration 007
   for grandfathered hex-CID businesses; the second is written by
   `PlaceIdValidationWorker` when resolution permanently fails.
4. `/admin/jobs` — any failed `sync_reviews` outbox entries? Read
   `last_error`.

**Fix:**
- SerpAPI quota exhausted → check SerpAPI dashboard. Wait for daily
  reset or top up.
- Place ID not verified → today there is no admin "revalidate" button
  and the business PATCH allowlist does not include `googlePlaceId`.
  Options, in order of preference:
  1. Re-onboard the business via `/admin/businesses/new` using the
     PlaceAutocomplete (cleanest path — creates a fresh validated
     record).
  2. If you already know the canonical Place ID, set it + verified
     flag directly and enqueue `sync_reviews` in one transaction.
     This skips `validate_place_id` entirely (its worker reads
     `google_maps_url` from the payload, not `google_place_id`, and
     will crash on NULL — so you cannot use it as a plain
     "revalidate" hook).
     ```sql
     BEGIN;

     UPDATE businesses
     SET google_place_id = '<canonical_place_id>',
         place_id_verified = TRUE,
         updated_at = NOW()
     WHERE id = '<business_id>';

     INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
     VALUES (
       gen_random_uuid(), 'sync_reviews', 'business', '<business_id>',
       jsonb_build_object(
         'business_id', '<business_id>',
         'google_place_id', '<canonical_place_id>',
         'correlation_id', gen_random_uuid()::text
       ),
       'pending'
     );

     COMMIT;
     ```
  3. If you ONLY have a Google Maps URL and need the worker to resolve
     it, queue `validate_place_id` with a non-null URL (the worker
     will parse the URL and populate the place ID itself):
     ```sql
     INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
     VALUES (
       gen_random_uuid(), 'validate_place_id', 'business', '<business_id>',
       jsonb_build_object(
         'business_id', '<business_id>',
         'google_maps_url', '<full https://maps.google.com/... URL>',
         'correlation_id', gen_random_uuid()::text
       ),
       'pending'
     );
     ```
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
| Today's cost | System Health card | `< 80%` of daily limit (env `GLOBAL_DAILY_COST_LIMIT_CENTS`, in cents; overview shows USD) |
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

**Note the aggregate_id varies by topic:**
- `sync_reviews` → `aggregate_id = business_id`
- `generate_response` → `aggregate_id = review_id`
- `send_notification`, `publish_response` → `aggregate_id = response_id`

So if you have a **response_id** (e.g. from `/admin/businesses/<id>`),
either start from `send_notification`, or join through `responses.review_id`
first. The canonical lookup helper lives at `src/lib/approval/correlation.ts`.

**About the payload extraction form below:** the `payload` column is JSONB,
and the normal form `payload->>'correlation_id'` works when the row contains
a proper JSONB object. Some older rows or rows written through certain
tooling have `payload` stored as a JSONB scalar string (double-encoded);
on those rows, the direct form returns NULL. The queries below use the
resilient form `(payload#>>'{}')::jsonb->>'correlation_id'` which works
for both shapes. It's slightly slower (no index lookup on the correlation
expression index) but correct in all cases — which matters more for ad-hoc
ops queries. Lab note in `.claude/CLAUDE.md` tracks the underlying quirk.

```sql
-- Starting from a response_id — fastest: use send_notification
SELECT (payload#>>'{}')::jsonb->>'correlation_id' AS correlation_id
FROM job_outbox
WHERE aggregate_id = '<response_id>' AND topic = 'send_notification'
ORDER BY created_at DESC LIMIT 1;

-- Or join responses → review → generate_response (matches correlation.ts)
SELECT (jo.payload#>>'{}')::jsonb->>'correlation_id' AS correlation_id
FROM responses r
JOIN job_outbox jo
  ON jo.aggregate_id = r.review_id
 AND jo.topic = 'generate_response'
WHERE r.id = '<response_id>'
ORDER BY jo.created_at DESC LIMIT 1;

-- Starting from a review_id — direct
SELECT (payload#>>'{}')::jsonb->>'correlation_id' AS correlation_id
FROM job_outbox
WHERE aggregate_id = '<review_id>' AND topic = 'generate_response'
ORDER BY created_at DESC LIMIT 1;

-- Once you have the correlation_id, trace every step
SELECT id, topic, status, attempts, created_at, last_error
FROM job_outbox
WHERE (payload#>>'{}')::jsonb->>'correlation_id' = '<correlation_id>'
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
- Cost guard (`reserveCost` in `src/lib/costs/tracker.ts`): uses Redis
  directly and THROWS on Redis failure — so `ResponseGeneratorWorker`
  fails its outbox entry BEFORE making any LLM call. Generation is
  effectively blocked until Redis returns. This is a safety feature
  (no spend without budget accounting), not degraded mode.

**Manual:**
1. Check Upstash dashboard for the outage.
2. When Redis returns, BullMQ + pollers resume automatically.
3. Failed outbox entries from the outage window sit in `status='failed'`
   with `last_error` mentioning the Redis failure. Reset them following
   Section C4 once Redis is stable — OutboxPoller will re-dispatch.
4. If you want to unblock generation during a prolonged Redis outage,
   the only safe option is to raise the code path into DB-only mode
   intentionally — there is no runtime toggle today.

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

**Auto:** The Redis daily cost guard (`src/lib/costs/tracker.ts`)
rejects **response-generation** LLM calls once the per-business or
global limit is hit. `ResponseGeneratorWorker` logs the rejection
and its outbox entry fails with `last_error='cost_limit_exceeded'`.

SerpAPI is **not** behind this same breaker:
- **Review sync** (`ReviewSyncWorker`) calls SerpAPI and records
  cost into `api_costs` after the fact — no pre-reservation.
- **Pre-fill** (`serpapi-prefill.ts`) calls SerpAPI directly, then
  records cost. A `strict` rate limiter (10/min per admin user, 75/day
  global) provides the ceiling.
- **Ranking** (`RankingTrackingWorker`) uses a separate monthly rate
  limit, not the daily cost guard.

So hitting the cost circuit stops new response generation, but
SerpAPI paths have independent quotas. Watch `/admin/costs` to see
aggregate spend across all providers.

**Manual:**
1. Verify via `/admin/costs` — confirm today's total is at/over the
   configured cap. The global default is `GLOBAL_DAILY_COST_LIMIT_CENTS`
   (10000 cents = $100/day). Per-tier overrides:
   `DAILY_COST_LIMIT_CENTS_FOUNDING` / `_STANDARD` / `_PREMIUM`.
2. If legitimate traffic, increase the relevant `*_CENTS` env var and
   redeploy. Failed outbox entries will retry after reset.
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
