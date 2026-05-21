# Sprint 6 Design Spec: Scale to $1K MRR

_Generated: 2026-04-16_
_Status: Approved by user, pending implementation plan_

---

## Context

Sprint 5B is complete (570/570 tests, 39 files). The system has 12 BullMQ workers, 9 pollers/schedulers, and covers the full review lifecycle: SerpAPI polling, response generation, approval flow, manual posting, engagement alerts, ranking tracking, satisfaction pulse, onboarding drips, and churn scoring.

Zero paying customers today, but potential to onboard 10-20 in the first month. Sprint 6 prepares the system for that burst.

## Goals

60/40 split between reliability and sales velocity:

- **Reliability (60%):** Correlation IDs for end-to-end traceability, archival expansion for database health, email deliverability for inbox placement, operational runbook for incident response
- **Sales velocity (40%):** Onboarding automation via SerpAPI pre-fill to reduce onboarding time from 20 to 10 minutes

## Explicit Non-Goals

- No PostHog analytics (add after customer #5)
- No formal load testing (architecture has built-in throttling; smoke test with real businesses instead)
- No new workers or pollers (12 workers + 9 pollers is sufficient for 20 businesses)
- No Better Stack / uptime monitoring (Sentry + admin dashboard sufficient at this scale)

---

## Architecture Overrides

These override any conflicting guidance in individual prompts:

1. **No new workers or pollers.** Sprint 6 enhances existing infrastructure. 12 workers + 9 pollers is sufficient for 20 businesses.
2. **No PostHog in Sprint 6.** Add product analytics only after customer #5 is live.
3. **Correlation IDs use `outbox_id` as the natural trace key.** Every outbox entry already has a UUIDv7 that travels through BullMQ job data. Propagate through all log output and cross-outbox chains (where one worker creates a new outbox entry, carry the original correlation ID forward).
4. **Archival uses the existing CTE + LIMIT 5000 pattern.** New archival targets follow the identical ArchivalPoller pattern.
5. **Onboarding pre-fill is a SerpAPI call in the admin API route, not a worker job.** Single fast lookup (<2s), needed synchronously for form pre-fill. One of the rare justified Vercel API route external calls.
6. **Email warmup is a process, not code.** The deliverability prompt produces a warmup schedule and Resend configuration checklist, not new application code.
7. **The operational runbook is a Markdown document, not application code.** References existing admin pages, SQL queries, and worker behaviors.

---

## Prompt Breakdown

### Prompt 20a — Correlation IDs + Structured Logging

**Goal:** Every async workflow is traceable end-to-end through a single ID.

**Changes:**

1. **New `BasePayload` in `src/lib/shared/worker-types.ts`:**
   - `correlation_id?: string` — optional for backward compat with existing outbox rows
   - All 11 payload types extend BasePayload

2. **Correlation ID generation at entry points:**
   - All 9 pollers/schedulers generate a new UUIDv7 per outbox entry they create
   - Webhook ingress (stripe.ts, resend.ts) uses the external event ID as correlation ID
   - Approval API routes use the response_id as correlation ID

3. **Cross-outbox chain propagation:**
   - When a worker creates a new outbox entry (e.g., ResponseGeneratorWorker creates `send_notification`), it carries forward `correlation_id` from the incoming job payload
   - OutboxPoller passes through `correlation_id` from outbox payload into BullMQ job data
   - Chain: `sync_reviews [corr-abc]` -> ReviewSyncWorker -> `generate_response [corr-abc]` -> ResponseGeneratorWorker -> `send_notification [corr-abc]` -> NotificationWorker

4. **Shared logger: `src/lib/shared/logger.ts`:**
   - `createWorkerLogger(prefix: string, correlationId?: string)` returns `{ log, warn, error }`
   - Output format: `[WorkerName] [corr-id] message` (or `[WorkerName] message` if no correlation ID)
   - Replaces raw `console.log` across all 12 workers

5. **No migration needed.** Correlation ID lives in outbox `payload` JSONB field.

6. **Queryability:** `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = ? ORDER BY created_at` shows any workflow's full chain.

**Tests:**
- Unit: createWorkerLogger formats correctly with and without correlation ID
- Unit: correlation ID propagates through mock outbox -> worker -> new outbox chain
- All existing tests pass unchanged

**Done when:**
- All 12 workers use createWorkerLogger
- All 9 pollers/schedulers set correlation IDs on outbox entries
- Cross-outbox chains carry the same correlation ID end-to-end

---

### Prompt 20b — Archival Expansion + Performance Indexes

**Goal:** Database stays healthy under 20 businesses.

**Changes:**

1. **Extend ArchivalPoller with two new targets:**

   a. `api_costs` > 90 days — aggregate then delete:
   - Aggregate into new `api_costs_daily_rollups` table: one row per (business_id, provider, date) with SUM(cost_usd), SUM(input_tokens), SUM(output_tokens), COUNT(*) as call_count
   - Then delete detailed rows older than 90 days
   - Same CTE + LIMIT 5000 pattern

   b. `notification_deliveries` > 90 days — straight delete:
   - No aggregation needed
   - Cooldown dedup checks use much shorter windows (24h, 3-7 days) so safe

2. **Migration 017 — `api_costs_daily_rollups` + `businesses.website` + `businesses.owner_email_bounced`:**
   ```sql
   CREATE TABLE api_costs_daily_rollups (
     id UUID PRIMARY KEY,
     business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
     provider VARCHAR(20) NOT NULL,
     rollup_date DATE NOT NULL,
     total_cost_usd DECIMAL(10,6) NOT NULL,
     total_input_tokens INTEGER NOT NULL DEFAULT 0,
     total_output_tokens INTEGER NOT NULL DEFAULT 0,
     call_count INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (business_id, provider, rollup_date)
   );

   ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website TEXT;
   ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_email_bounced BOOLEAN NOT NULL DEFAULT FALSE;
   ```

3. **Admin costs page update:**
   - For date ranges > 90 days, query `api_costs_daily_rollups` instead of `api_costs`
   - Union the two sources transparently

4. **Archival logging enhancement:**
   - Warn if any batch saturated (5000 = more pending)

**Tests:**
- Unit: rollup produces correct sums
- Unit: archival skips rows newer than 90 days
- Admin costs API works with mixed detail + rollup sources

**Done when:**
- ArchivalPoller handles 5 targets (outbox, events, demos, api_costs, notification_deliveries)
- api_costs > 90 days rolled up into daily aggregates
- notification_deliveries > 90 days deleted
- Migration 017 applied

---

### Prompt 20c — Onboarding Automation + SerpAPI Pre-fill

**Goal:** Reduce onboarding from 20 to 10 minutes.

**Changes:**

1. **New API: `GET /api/admin/businesses/prefill?place_id=ChIJ...`:**
   - Requires admin/sales_partner role
   - Calls SerpAPI `engine=google_maps` with Place ID
   - Returns: `{ category, phone, website, hours, fullAddress }`
   - Rate limited: 10/min per user
   - Mock mode returns canned data
   - Justified Vercel external call — single fast lookup, synchronous UX need

2. **New module: `src/lib/reviews/serpapi-prefill.ts`:**
   - `fetchBusinessDetails(placeId): Promise<BusinessPrefill>`
   - Extracts: category (from `type`), phone, website, operating_hours
   - Records cost to api_costs table
   - Graceful failure — partial/empty data, never throws to caller

3. **Onboarding form upgrade:**
   - After PlaceAutocomplete fires, auto-trigger prefill API
   - Loading spinner on pre-fillable fields
   - Fields editable (not locked) after pre-fill
   - Graceful degradation — empty fields on failure
   - Add `website` field

4. **Schema: `businesses.website` column** (in migration 017, shared with 20b)

5. **Update Zod schemas** for onboarding + settings to accept optional `website`

**Tests:**
- Unit: SerpAPI pre-fill normalizes fixture data correctly
- Unit: graceful handling of partial/missing SerpAPI response
- Unit: rate limit enforcement on prefill endpoint

**Done when:**
- PlaceAutocomplete selection auto-fills category, phone, website
- Pre-fill fields editable, failure degrades gracefully
- website column exists and is editable
- SerpAPI calls cost-tracked

---

### Prompt 20d — Email Deliverability + Resend Warmup

**Goal:** Approval emails land in inboxes, not spam.

**Changes:**

1. **DNS authentication (manual, documented):**
   - SPF, DKIM records via Resend domain verification
   - DMARC record: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
   - Document all DNS records in operational runbook

2. **Warmup schedule (process document):**
   - Week 1: 5-10 emails/day (internal tests)
   - Week 2: 20-30 emails/day (first 2-3 customers)
   - Week 3+: organic volume
   - Mitigation: stagger onboarding 2-3 customers/week

3. **Code changes:**

   a. `List-Unsubscribe` header on marketing emails:
   - Weekly value report, monthly impact, onboarding drips, owner nudge
   - NOT on: approval emails (transactional), internal partner alerts
   - Format: `List-Unsubscribe: <mailto:unsubscribe@yourdomain.com>`

   b. Email category tagging in Resend:
   - Add `tags` parameter: `transactional`, `marketing`, `internal`
   - Add `category` parameter to send functions

   c. Hard bounce handling:
   - On hard bounce (email.bounced type='hard'): set `businesses.owner_email_bounced = true`
   - NotificationWorker + EngagementMonitorPoller skip bounced addresses
   - Alert sales partner on hard bounce
   - Schema: `businesses.owner_email_bounced` (in migration 017)

   d. Admin overview email health card:
   - Emails sent (24h), delivery rate, bounce count (7d), complaint count (7d)
   - Red badge if delivery rate < 95% or any complaints

**Tests:**
- Unit: List-Unsubscribe present on marketing, absent on transactional
- Unit: category tags set correctly per email type
- Unit: hard bounce flags business, subsequent sends skip

**Done when:**
- SPF/DKIM/DMARC verified and documented
- Marketing emails have List-Unsubscribe headers
- Hard bounces prevent further sends
- Admin overview shows email health metrics
- Warmup schedule documented

---

### Prompt 20e — Operational Runbook + Smoke Test Checklist

**Goal:** Diagnose and fix problems without debugging from first principles.

**Deliverables:**

1. **`docs/operational-runbook.md`** with 5 sections:
   - Section A: "Customer says X" troubleshooting (5 common complaints with Check/Fix steps)
   - Section B: Daily system health checks (2-minute admin dashboard review)
   - Section C: Common SQL debugging queries (trace review, find stuck outbox, check costs)
   - Section D: Incident response playbook (worker crash, Redis down, Supabase down, SerpAPI exhausted, LLM provider down, cost breaker tripped)
   - Section E: Weekly maintenance tasks (Resend dashboard, Stripe dashboard, cost review, SerpAPI quota)

2. **`docs/smoke-test-checklist.md`** — 14-step pre-launch verification with 3 real businesses:
   - Onboard with pre-fill, Stripe checkout, review sync, approval flow (approve/edit/regenerate), admin dashboard verification, notification failover, correlation ID trace

3. **Admin nav runbook link** — single link addition to AdminNav component

**Tests:** None (documentation). The smoke test checklist IS the test.

**Done when:**
- Runbook covers 5 most common complaints with step-by-step fixes
- Smoke test checklist exists with 14 verification steps
- Admin nav includes runbook link

---

## Sprint 6 Done-When Criteria

- [ ] Correlation IDs trace any review from ingestion to posting in a single query
- [ ] api_costs archived to daily rollups after 90 days; notification_deliveries deleted after 90 days
- [ ] Onboarding form pre-fills category, phone, website from SerpAPI in under 2 seconds
- [ ] All customer marketing emails have List-Unsubscribe headers; hard bounces prevent further sends
- [ ] SPF/DKIM/DMARC verified; warmup schedule documented
- [ ] Operational runbook covers 5 most common customer complaints with step-by-step fixes
- [ ] 3-business smoke test completed successfully before accepting first paying customer

## Migration Summary

Single migration 017 covers all Sprint 6 schema needs:
- `api_costs_daily_rollups` table (Prompt 20b)
- `businesses.website` column (Prompt 20c)
- `businesses.owner_email_bounced` column (Prompt 20d)

## Dependencies

| Prompt | Depends on |
|---|---|
| 20a (correlation IDs) | None — can start immediately |
| 20b (archival + indexes) | Migration 017 |
| 20c (onboarding pre-fill) | Migration 017 (website column) |
| 20d (email deliverability) | Migration 017 (bounced column), DNS setup (manual) |
| 20e (runbook + smoke test) | 20a (correlation IDs referenced in runbook SQL queries) |

Prompts 20a, 20b, 20c can run in parallel after migration. 20d can run in parallel with 20c. 20e is last (references all prior work).
