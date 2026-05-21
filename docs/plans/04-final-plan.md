# Final Technical Plan (Revised v2)

_Generated: 2026-04-03T05:17:37.205Z_
_Revised: 2026-04-02 (v2 — scale-first architecture)_
_Idea: AI Review Responder — Automated Google review response drafts for SMBs_

---

# AI Review Responder — Final Technical Plan

## 1. Product Overview

AI Review Responder is an automated service for small businesses that monitors Google reviews and generates personalized, multilingual response drafts for owner approval within one hour. Targeting single-location SMBs in review-dependent industries (restaurants, salons, hotels), the service addresses the critical gap where businesses respond to <30% of reviews despite knowing it impacts their Google Maps ranking and customer trust. At $99-149/month, we undercut enterprise competitors (Birdeye at $450/month) while providing superior automation compared to self-serve tools. The core differentiator is the delivery model: done-for-you via notification-based approval, not another dashboard the owner has to learn.

### Hard Constraints (from Product Brief)

These are non-negotiable product rules that the architecture must enforce:

- **No auto-posting.** Every response requires explicit owner approval before publishing. This is a trust constraint, not a feature gap. The system must make it architecturally impossible to bypass approval.
- **Notification-first UX.** If the business owner has to log into a dashboard to make the product work, we've failed. The approval flow must work via email or SMS alone.
- **30-second approval.** The owner's interaction per review should take under 30 seconds: read draft, tap approve/edit/regenerate.
- **Google only for V1.** No Yelp, TripAdvisor, or other platforms until we have 10+ paying customers requesting it.
- **No sentiment analytics dashboards.** No word clouds, NPS scores, or trend graphs in V1. Only operational metrics that prove ROI (response rate, response time).

## 2. Architecture Decision Record

### Go/No-Go Dependency: Google Business Profile API

- **Decision**: Validate Google Business Profile API access, OAuth scopes, reply posting, and Pub/Sub notifications before building production automation
- **Confidence**: CRITICAL — this is the single biggest risk to the entire product
- **Action required**:
  - Apply for GBP API access immediately (review process can take 2-4 weeks)
  - Configure OAuth consent screen and submit for verification
  - Verify review listing works via the API
  - Verify reply posting works via the API
  - Configure Google Pub/Sub topic and verify notification delivery for review changes
  - Confirm the project has usable quota for both reads and writes
- **Fallback**: If Google access is delayed, ship the demo engine and manual posting workflow first. Do not build production automation on top of scraping.

### Database & Infrastructure
- **Decision**: PostgreSQL via Supabase with connection pooling enabled from day one
- **Confidence**: HIGH
- **Reasoning**: Real-time subscriptions, row-level security, managed infrastructure. Connection pooling (Supabase's built-in PgBouncer) prevents hitting connection limits as workers and API routes scale.
- **Scale consideration**: At 50+ businesses, monitor connection utilization. At 200+, evaluate dedicated Postgres with PgBouncer or move to Supabase Pro tier.

### Backend Runtime & Framework
- **Decision**: Next.js 14 with App Router for the web application. Background processing and external ingress (Pub/Sub, webhooks) run in a dedicated worker service on Railway.
- **Confidence**: HIGH
- **Reasoning**: Next.js handles all UI pages and short-lived API routes. Queue workers, Pub/Sub ingestion, and long-running integrations are operationally cleaner in a dedicated service. This keeps the codebase unified without forcing integration-heavy workloads into serverless route handlers.
- **Scale consideration**: If API routes hit Vercel's function timeout limits (default 10s, max 300s on Pro), extract long-running operations to Railway workers.

### Frontend Framework
- **Decision**: Next.js with SSR, deployed on Vercel
- **Confidence**: HIGH
- **Reasoning**: SEO-critical for prospect demo pages, unified full-stack development
- **Scale consideration**: Vercel costs increase with traffic. At $500+/month Vercel spend, evaluate self-hosting on Railway or Fly.io.

### Job Queue System
- **Decision**: BullMQ with dedicated Redis instance for background jobs
- **Confidence**: HIGH
- **Reasoning**: Enterprise-grade reliability for the 1-hour SLA. Persistent queues, built-in retry logic, dead letter queues for failed jobs.
- **Scale consideration**: Separate Redis instances for cache vs. job queue from the start. BullMQ queue operations and cache reads compete for throughput on shared Redis.

### Review Ingestion Strategy
- **Decision**: Google Business Profile notifications via Pub/Sub as primary ingestion path. Polling as scheduled reconciliation fallback.
- **Confidence**: HIGH
- **Reasoning**:
  - Notifications reduce latency (near-real-time vs 30-min polling intervals) and eliminate wasted API quota on quiet businesses.
  - Polling remains necessary as a repair path for missed notifications, token refresh gaps, or sync drift.
  - At higher customer counts, notification-driven ingestion scales better than polling every location continuously.
- **Implementation**: Google Pub/Sub topic receives review change notifications. Worker ingress handler writes to `inbound_events`, then triggers a sync job that fetches the full review data from the GBP API.
- **Scale consideration**: Pub/Sub handles throughput natively. Reconciliation polling uses adaptive intervals (60/120/240 min) since it's no longer the primary path.

### Review Data Source (Demo Engine)
- **Decision**: SerpAPI behind a pluggable `ReviewSource` interface for the demo engine only. Not used in production monitoring or posting.
- **Confidence**: MEDIUM
- **Reasoning**: SerpAPI is a scraping layer that works for generating one-off prospect demos where the business has not connected via OAuth. The pluggable interface means the demo engine can later switch to manual paste, CSV upload, or another compliant review import source without changing the rest of the demo pipeline. Note: Google Places API is NOT a drop-in replacement — it returns ~5 reviews max, insufficient for the 10-15 review demo the product brief requires.
- **Scale consideration**: If SerpAPI becomes unreliable or undesirable, swap the implementation behind `ReviewSource`. No production review-monitoring code is affected.
- **V1 demo sources**: SerpAPI (primary), manual paste, CSV upload.
- **ReviewSource contract**: The `ReviewSource` interface must normalize output to ONLY the fields guaranteed by the GBP API review resource (reviewer name, star rating, review text, review date, language). No demo-only metadata in the prompt builder. This prevents "demo looks better than production" drift where SerpAPI provides richer data than GBP, creating sales promises engineering can't match. Add contract tests that verify every `ReviewSource` implementation produces the same DTO shape.

### LLM Provider
- **Decision**: OpenAI GPT-4o-mini as primary, Anthropic Claude Haiku as fallback
- **Confidence**: MEDIUM
- **Reasoning**: 60% cost savings vs GPT-4o with acceptable quality. Multilingual support proven. Human approval requirement catches quality variance.
- **Scale consideration**: At 1,000+ responses/month, evaluate fine-tuning a smaller model on approved response pairs to reduce cost and improve voice consistency.

### Security Architecture
- **Decision**: Hard cost limits, server-side API keys, per-business daily spend caps
- **Confidence**: HIGH
- **Reasoning**: One cost attack could bankrupt the company. Security is existential from day one.
- **Implementation**: Redis-based atomic cost reservation with circuit breaker.
  - **Why not DB-based**: If 30 reviews arrive simultaneously (viral 1-star attack), all 30 workers query `api_costs`, all 30 see $0 spent today, all 30 pass the check, all 30 fire LLM calls. The DB-based check has a TOCTOU race — cost is checked before the call but recorded after. By the time tracking catches up, the daily budget is 30x exceeded.
  - **Fix**: Use a Redis `INCRBY` on `cost:daily:{business_id}:{date}` BEFORE the LLM call (pessimistic reservation of estimated cost). If the call fails, `DECRBY` to release the reservation. Redis atomic operations eliminate the race. The `api_costs` DB table remains the audit trail for billing and reporting, reconciled hourly.
  - **Tier-aware daily limits**: `DAILY_COST_LIMIT_CENTS_PER_BUSINESS` must scale with subscription tier, not be a flat constant. Suggested defaults: founding ($99/mo) = 500 cents/day, standard ($149/mo) = 1000 cents/day, premium ($199/mo) = 2000 cents/day. These are safety caps, not expected spend — actual per-request cost with GPT-4o-mini is ~$0.001, so a 500-cent daily cap allows ~500 generations before halting.
  - **Global circuit breaker**: Redis key `cost:global:{date}` tracks total platform spend. If it exceeds a hard cap, ALL generation halts and admin is paged. This prevents a single compromised business from bankrupting the platform.

### Secret Management & Token Encryption
- **Decision**: Envelope encryption for OAuth tokens with key rotation support from day one.
- **Confidence**: HIGH
- **Reasoning**: A single `ENCRYPTION_KEY` env var with no rotation strategy means a key leak (compromised deploy, departed employee, accidental log) exposes all customer OAuth tokens with no safe recovery path.
- **Production requirement**: GCP Secret Manager is mandatory in production for the Key Encryption Key (KEK) and Google OAuth client secret. The architecture already depends on GCP for Pub/Sub, so the incremental cost is near-zero.
- **Dev mode**: Environment variables are allowed for local development only.
- **Implementation**:
  - Generate a random Data Encryption Key (DEK) per `google_connections` row.
  - Encrypt OAuth tokens with the DEK using AES-256-GCM.
  - Encrypt the DEK with the KEK stored in GCP Secret Manager or backed by Cloud KMS.
  - Store `encrypted_dek` and `key_version` in Postgres.
  - Rotate KEKs by re-encrypting only DEKs (small, fast), not the underlying OAuth tokens.

### Caching Strategy
- **Decision**: Dedicated Redis instance (Upstash) for caching, rate limits, and API quota tracking. Separate from BullMQ Redis.
- **Confidence**: HIGH
- **Reasoning**: Separation from job queue prevents cache eviction under queue pressure.
- **What to cache**: Idempotent retries for the same review+version, language detection results, prompt fragments, rate limit counters.
- **What NOT to cache**: Final generated responses across businesses. Cross-business caching trades away response quality and voice isolation for modest cost savings — not worth it.

### Workflow Reliability
- **Decision**: Use Postgres transactional outbox for all asynchronous work. Every state change and its follow-up work are written in the same database transaction.
- **Confidence**: HIGH
- **Reasoning**:
  - Approval, publishing, notification, and review-sync workflows must be durable. The current approval flow (update Postgres, then queue job) has a failure gap: if the database update succeeds but the queue write fails, the workflow stalls silently.
  - Writing state changes and outbox entries in the same transaction eliminates lost work.
  - All queue consumers are idempotent, so replaying an outbox entry is safe.
- **Implementation**:
  - `inbound_events` table for Pub/Sub, Stripe, and Twilio webhook events (deduplicated on arrival)
  - `job_outbox` table for follow-up work (generate response, send notification, publish to Google)
  - Outbox poller reads pending entries and dispatches to BullMQ
  - Workers are idempotent: processing the same job twice produces the same result

### Approval Token Security
- **Decision**: Approval tokens stored as SHA-256 hashes in a dedicated `approval_links` table, separate from the `responses` table. Approval actions are device-bound and short-lived.
- **Confidence**: HIGH
- **Reasoning**:
  - If the database leaks, raw tokens would let an attacker approve/edit any pending response. Hashing eliminates this.
  - Separate table enables clean token lifecycle: revocation on regenerate, multiple tokens per response (email + SMS), full audit trail.
  - Migrating tokens from a column on `responses` to a separate table later would mean a data migration on the most critical user-facing flow. Building it right from day one avoids that.
- **Hardening** (approval links are "keys to the castle" since there's no login):
  - **48-hour TTL** (not 7 days). The brief says approval should happen quickly. 48h covers a weekend; longer windows just increase exposure.
  - **Device binding via deliberate POST, not GET.** Email security scanners (Gmail, Outlook, corporate proxies) prefetch GET URLs before the owner opens the email. If the first GET bound the session, a scanner could hijack it. Instead:
    1. `GET /approve/:token` is read-only — validates the token for display, renders the approval page with a "Continue" button, sets a temporary CSRF cookie. It NEVER writes to `approval_links`.
    2. Owner taps "Continue" → `POST /api/approval/session` with raw token + CSRF. This binds `device_cookie_hash` (if not yet bound) and establishes the action session.
    3. `POST /approve/:token/approve|edit|regenerate` requires raw token + device-bound session cookie + CSRF token. All three must match.
  - Scanners stop at GET, so binding on POST preserves the 30-second UX while removing the silent hijack risk.
  - **Rate limit on approval POST endpoints.** 3 actions per token per minute. Prevents automated abuse if a link leaks.
  - **Impact scope**: worst case of a compromised link is one unauthorized response posted to Google, which the owner can delete manually. Embarrassing, not catastrophic — but the above mitigations make it unlikely.

### Architecture Pattern
- **Decision**: Monolithic Next.js app with clear module boundaries, separate worker service
- **Confidence**: HIGH
- **Reasoning**: Module boundaries (reviews/, responses/, notifications/, admin/) make future extraction to microservices straightforward if needed.
- **Scale consideration**: If any single module becomes a bottleneck (e.g., response generation), extract it to a dedicated service. The module boundaries make this a mechanical refactor, not an architectural rewrite.
- **Architectural invariant — enforce from day one**:
  - Vercel is a **UI-serving surface only**: renders pages, handles short authenticated reads/writes, serves approval pages.
  - Vercel MUST NOT run: review sync, response generation, Google posting, token refresh, or any operation that depends on external API latency.
  - ALL SLA-critical compute lives in Railway workers.
  - This prevents "architectural drift" where future engineers move workflow logic into Next.js route handlers, causing cold start and timeout issues that are hard to diagnose.

## 3. Technology Stack

### Core Infrastructure
- **Runtime**: Node.js v20 LTS
- **Framework**: Next.js 14 with App Router (web app + API routes)
- **Worker Service**: Standalone Node.js process on Railway (queue consumers, Pub/Sub ingress, cron jobs)
- **Database**: PostgreSQL 15 via Supabase (connection pooling enabled)
- **Cache**: Redis 7 via Upstash (dedicated instance for caching)
- **Job Queue**: BullMQ 5 with Redis (dedicated instance, separate from cache)
- **Event Ingestion**: Google Cloud Pub/Sub (review change notifications)

### Frontend
- **UI Framework**: React 18
- **Styling**: Tailwind CSS 3.4
- **State Management**: Zustand 4
- **Forms**: React Hook Form 7
- **Data Fetching**: TanStack Query 5

### Backend Services
- **Authentication**: Supabase Auth
- **Email**: Resend SDK
- **SMS**: Twilio SDK
- **LLM Primary**: OpenAI SDK (GPT-4o-mini)
- **LLM Fallback**: Anthropic SDK (Claude Haiku)
- **Review Data (demos)**: SerpAPI client (behind pluggable `ReviewSource` interface)
- **Review Data (production)**: Google Business Profile API + Pub/Sub notifications
- **Payments**: Stripe SDK

### Development & Operations
- **Language**: TypeScript 5 (strict mode)
- **Package Manager**: pnpm
- **Testing**: Vitest, Playwright
- **Monitoring**: PostHog (analytics), Better Stack (errors/uptime)
- **Deployment**: Vercel (web app), Railway (worker service)

## 4. System Architecture

### Data Flow

```
1. Review Detection — Primary (Notifications):
   Google Business Profile -> Pub/Sub notification -> Worker ingress endpoint ->
   inbound_events (deduplicated) -> Outbox: sync_reviews ->
   Worker fetches full review data from GBP API -> PostgreSQL (reviews table)

   Review Detection — Fallback (Reconciliation Polling):
   Scheduled cron (BullMQ) -> GBP API list reviews -> Deduplicate against existing ->
   PostgreSQL (reviews table)

   Review Detection — Demo Engine:
   Sales partner request -> ReviewSource interface (SerpAPI / manual / CSV) ->
   Demo page with AI responses (no production tables touched)

2. Response Generation:
   New review inserted -> Outbox: generate_response -> Worker picks up ->
   Cost guard check -> Cache check -> LLM API -> Response draft ->
   Transaction: insert response + outbox: send_notification

3. Approval Flow:
   Notification sent (email/SMS with approval link) -> Owner taps link ->
   Approval page looks up approval_links by hash(token) ->
   Owner action (approve/edit/regenerate) ->
   Transaction: update response status + insert outbox entry (publish or regenerate)

4. Publishing:
   Outbox: publish_response -> Worker picks up ->
   GBP API reply using google_location_name + provider_review_name ->
   Transaction: update response status to posted
   (Notification delivery tracking happens earlier via NotificationWorker + provider webhooks)
```

### Component Architecture

```
                    VERCEL                              RAILWAY
┌──────────────────────────────┐     ┌──────────────────────────────┐
│        Next.js App           │     │       Worker Service         │
├──────────────────────────────┤     ├──────────────────────────────┤
│ Public:                      │     │ Ingress:                     │
│  • Landing page              │     │  • Pub/Sub push endpoint     │
│  • /demo/:slug               │     │  • Stripe webhook handler    │
│  • /approve/:token           │     │  • Twilio webhook handler    │
│                              │     │                              │
│ Authenticated:               │     │ Queue Consumers:             │
│  • /dashboard (owner)        │     │  • ReviewSyncWorker          │
│  • /admin (sales partner)    │     │  • ResponseGeneratorWorker   │
│                              │     │  • NotificationWorker        │
│ API Routes:                  │     │  • ResponsePublisherWorker   │
│  • /api/approve/*            │     │  • WeeklySummaryWorker       │
│  • /api/business/*           │     │  • CostMonitorWorker         │
│  • /api/approval/session     │     │  • AdminExceptionWorker      │
│  • /api/admin/*              │     │                              │
│  • /api/webhooks/stripe      │     │ Cron:                        │
│                              │     │  • OutboxPoller (10s)        │
│                              │     │  • ReconciliationPoller      │
│                              │     │    (60-240 min, adaptive)    │
└──────────┬───────────────────┘     └──────────┬───────────────────┘
           │                                    │
           ▼                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Supabase PostgreSQL                             │
│                    (PgBouncer pooling enabled)                     │
├────────────────────────────────────────────────────────────────────┤
│ Core:     businesses | google_connections | reviews | responses    │
│ Workflow: inbound_events | job_outbox | approval_links             │
│ Ops:     notification_deliveries | weekly_summaries | api_costs    │
│ Sales:   users | prospect_demos                                   │
│ Real-time subscriptions for admin dashboard                       │
└────────────────────────────────────────────────────────────────────┘
           │
     ┌─────┴──────────────────────┐
     ▼                            ▼
┌──────────────┐      ┌──────────────────┐
│ Redis: Cache │      │ Redis: Job Queue │
│  (Upstash)   │      │   (Upstash)      │
├──────────────┤      ├──────────────────┤
│ • Rate limits│      │ • BullMQ queues  │
│ • API quotas │      │ • Scheduled cron │
│ • Retry cache│      │ • Dead letters   │
└──────────────┘      └──────────────────┘

           External Services
┌──────────────────────────────────┐
│ • Google Business Profile API    │
│ • Google Cloud Pub/Sub           │
│ • SerpAPI (demo engine only)     │
│ • OpenAI API (primary LLM)      │
│ • Anthropic API (fallback LLM)   │
│ • Resend (email)                 │
│ • Twilio (SMS)                   │
│ • Stripe (payments)              │
│ • PostHog (analytics)            │
│ • Better Stack (monitoring)      │
└──────────────────────────────────┘
```

## 5. Data Model

### UUID Strategy

All tables use **UUIDv7** (time-ordered) instead of UUIDv4 (random). UUIDv4's random distribution fragments B-tree indexes on write-heavy tables — inserts scatter across random pages. UUIDv7 is time-ordered, so inserts always append to the end of the index, keeping it compact and fast. This matters well before the 500K partitioning threshold. Supabase doesn't have native UUIDv7, so generate them in the application layer via the `uuidv7` npm package and pass them explicitly, or install the `pg_uuidv7` extension if available. The `uuidv7()` calls in the schema below assume the extension is installed; replace with application-generated values if not.

### Core Tables

```sql
-- Businesses table (business profile + settings, NOT Google integration state)
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  google_place_id VARCHAR(255), -- kept for display/lookup, NOT the integration key

  -- Business context for AI voice matching
  tone VARCHAR(100) DEFAULT 'professional and friendly',
  products_services TEXT,
  staff_names TEXT[],
  highlight_facts TEXT[],
  avoid_facts TEXT[],
  sample_responses TEXT[],

  -- Notification settings
  notification_preference VARCHAR(20) DEFAULT 'email', -- 'email', 'sms', 'both'
  owner_name VARCHAR(255) NOT NULL,
  owner_email VARCHAR(255) NOT NULL,
  owner_phone VARCHAR(20),

  -- Subscription (Stripe-managed)
  subscription_tier VARCHAR(20) DEFAULT 'standard', -- 'founding', 'standard', 'premium'
  subscription_status VARCHAR(20) DEFAULT 'active',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  onboarded_by UUID REFERENCES users(id)
);

-- Google connection state (separated from business profile)
-- This is the canonical integration record for a connected Google Business Profile.
CREATE TABLE google_connections (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,

  -- Canonical Google identifiers (resource names from the GBP API)
  -- google_location_name is the PRIMARY integration key for all API calls
  -- google_account_id is retained for reporting, debugging, and account-level API operations
  google_account_id TEXT NOT NULL,
  google_location_name TEXT NOT NULL UNIQUE, -- e.g. "accounts/123/locations/456"

  -- OAuth tokens (envelope encryption: tokens encrypted with DEK, DEK encrypted with KEK)
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,            -- DEK encrypted with the current KEK
  key_version INTEGER NOT NULL DEFAULT 1, -- which KEK version encrypted the DEK
  token_expires_at TIMESTAMPTZ,

  -- Pub/Sub notification state
  notifications_enabled_at TIMESTAMPTZ,
  last_notification_at TIMESTAMPTZ,

  -- Sync state (for reconciliation polling)
  last_full_sync_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'connected', -- 'connected', 'token_expired', 'disconnected', 'error'

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gc_sync ON google_connections(sync_status, last_full_sync_at);

-- Reviews table
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Provider-canonical identifiers (supports future multi-platform)
  provider TEXT NOT NULL DEFAULT 'google',
  provider_review_id TEXT NOT NULL,          -- Google's review ID
  provider_review_name TEXT NOT NULL,        -- e.g. "accounts/123/locations/456/reviews/789"
  provider_location_name TEXT NOT NULL,      -- e.g. "accounts/123/locations/456"

  -- Review content
  reviewer_name VARCHAR(255),
  star_rating INTEGER CHECK (star_rating >= 1 AND star_rating <= 5),
  review_text TEXT,
  review_date TIMESTAMPTZ,
  detected_language VARCHAR(10),
  review_content_hash TEXT, -- SHA-256 of (star_rating || review_text), used to detect edits

  -- Processing status
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'new', -- 'new', 'generating', 'pending_approval', 'approved', 'posted', 'failed'

  CONSTRAINT unique_provider_review UNIQUE (provider, provider_review_name)
);

CREATE INDEX idx_reviews_business_status ON reviews(business_id, status);
CREATE INDEX idx_reviews_detected_at ON reviews(detected_at);
-- Partition-ready: when reviews exceed 500K rows, partition by detected_at (yearly)

-- Responses table (approval tokens live in approval_links, not here)
CREATE TABLE responses (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Response content
  response_text TEXT NOT NULL,
  response_language VARCHAR(10),
  version INTEGER DEFAULT 1,

  -- Approval workflow (NO auto-post path exists — by design)
  status VARCHAR(20) DEFAULT 'pending_approval', -- 'pending_approval', 'approved', 'edited', 'posted', 'failed'
  approved_at TIMESTAMPTZ,
  approved_text TEXT, -- the final text that was approved (original or edited)

  -- Edit tracking for voice learning
  original_draft_text TEXT NOT NULL,
  edited_text TEXT,       -- NULL if approved without edits
  edit_distance INTEGER,  -- Levenshtein distance, used to measure AI quality over time

  -- Publishing
  posted_at TIMESTAMPTZ,
  posting_error TEXT,

  -- LLM metadata
  llm_provider VARCHAR(20), -- 'openai' or 'anthropic'
  llm_model VARCHAR(50),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency boundary: (review_id, version) must be unique. Prevents duplicate
-- drafts from replayed outbox entries or concurrent generation jobs.
-- The generation worker must treat a conflict here as "already generated, skip".
ALTER TABLE responses ADD CONSTRAINT unique_review_version UNIQUE (review_id, version);

CREATE INDEX idx_responses_status ON responses(status);
CREATE INDEX idx_responses_business_posted ON responses(business_id, posted_at);
CREATE INDEX idx_responses_voice ON responses(business_id, posted_at DESC)
  WHERE status = 'posted' AND edited_text IS NOT NULL;
-- Partition-ready: same strategy as reviews table

-- Approval links (separate from responses for clean lifecycle management)
CREATE TABLE approval_links (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Token stored as hash only — raw token never persists in the database
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the raw token
  channel TEXT NOT NULL,            -- 'email' or 'sms'

  -- Lifecycle (48h TTL, not 7 days — shorter window reduces exposure)
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
  consumed_at TIMESTAMPTZ,          -- set when owner takes any action
  revoked_at TIMESTAMPTZ,           -- set when a newer version is generated
  device_cookie_hash TEXT,          -- set on POST /api/approval/session, required for POST actions

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_al_token ON approval_links(token_hash) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_al_response ON approval_links(response_id);

-- Users table (business owners + sales partners + admins)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL DEFAULT 'owner', -- 'owner', 'sales_partner', 'admin'
  business_id UUID REFERENCES businesses(id), -- NULL for sales partners and admins

  -- Authentication via Supabase Auth
  auth_id VARCHAR(255) UNIQUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Workflow Tables

```sql
-- Inbound events (deduplication + durability for external webhooks and Pub/Sub)
CREATE TABLE inbound_events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  source TEXT NOT NULL,                  -- 'google_pubsub', 'stripe', 'twilio'
  external_event_key TEXT NOT NULL UNIQUE, -- idempotency key from the external system
  event_type TEXT NOT NULL,              -- 'review_changed', 'subscription_updated', 'sms_delivered'
  aggregate_key TEXT,                    -- e.g. google_location_name, for routing

  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received', -- 'received', 'processing', 'processed', 'failed'
  error_message TEXT
);

CREATE INDEX idx_ie_status ON inbound_events(status) WHERE status != 'processed';
CREATE INDEX idx_ie_source ON inbound_events(source, received_at);

-- Job outbox (transactional outbox pattern — state change + follow-up work in one transaction)
CREATE TABLE job_outbox (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  topic TEXT NOT NULL,                   -- 'generate_response', 'send_notification', 'publish_response', 'sync_reviews', 'notify_admin_review_exception'
  aggregate_type TEXT NOT NULL,          -- 'review', 'response', 'business'
  aggregate_id UUID,                     -- FK to the relevant record

  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,             -- set when outbox poller sends to BullMQ
  completed_at TIMESTAMPTZ,              -- set when worker confirms completion
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'dispatched', 'completed', 'failed'
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jo_pending ON job_outbox(available_at) WHERE status = 'pending';
CREATE INDEX idx_jo_topic ON job_outbox(topic, status);

-- Outbox status lifecycle:
--   pending    -> Created in transaction. Awaiting outbox poller pickup.
--   dispatched -> Poller sent to BullMQ. Worker is processing.
--   completed  -> Worker confirmed success. Safe to archive after 7 days.
--   failed     -> Exceeded max_attempts. Terminal. Requires manual investigation.
-- Transition rules:
--   If dispatch fails and attempts < max_attempts: reset to 'pending' for retry.
--   If dispatch fails and attempts >= max_attempts: transition to 'failed' (terminal).
--   If a 'dispatched' entry has no progress after 1 hour, the poller resets it to 'pending'.
```

### Operational Tables

```sql
-- Notification deliveries (track every email/SMS sent for troubleshooting)
CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  response_id UUID REFERENCES responses(id),

  channel TEXT NOT NULL,       -- 'email' or 'sms'
  recipient TEXT NOT NULL,     -- email address or phone number
  template TEXT NOT NULL,      -- 'approval_request', 'weekly_summary', 'confirmation'

  -- Delivery tracking
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,    -- from webhook callback (Resend/Twilio)
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  external_message_id TEXT,    -- Resend message ID or Twilio SID

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_nd_business ON notification_deliveries(business_id, created_at);
CREATE INDEX idx_nd_response ON notification_deliveries(response_id);

-- Prospect demos table (for sales outreach)
CREATE TABLE prospect_demos (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_name VARCHAR(255) NOT NULL,
  google_place_id VARCHAR(255),
  demo_url_slug VARCHAR(20) UNIQUE NOT NULL,
  review_source TEXT NOT NULL DEFAULT 'serpapi', -- 'serpapi', 'manual', 'csv', 'connected'

  -- Demo data (snapshot, not live)
  reviews_snapshot JSONB NOT NULL,
  generated_responses JSONB NOT NULL,

  -- Sales tracking
  created_by UUID REFERENCES users(id),
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  prospect_status VARCHAR(20) DEFAULT 'sent', -- 'sent', 'viewed', 'converted', 'expired'
  view_count INTEGER DEFAULT 0,
  last_viewed_at TIMESTAMPTZ
);

CREATE INDEX idx_demos_slug ON prospect_demos(demo_url_slug);
CREATE INDEX idx_demos_expires ON prospect_demos(expires_at);
CREATE INDEX idx_demos_sales ON prospect_demos(created_by, prospect_status);

-- Weekly summaries (simple email summaries, not analytics engine)
CREATE TABLE weekly_summaries (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,

  total_reviews INTEGER NOT NULL DEFAULT 0,
  total_responded INTEGER NOT NULL DEFAULT 0,
  notable_reviews JSONB,
  summary_text TEXT,

  generated_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,

  CONSTRAINT unique_business_week UNIQUE (business_id, week_start_date)
);

-- API cost tracking (critical for financial safety)
CREATE TABLE api_costs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID REFERENCES businesses(id),

  provider VARCHAR(20) NOT NULL, -- 'openai', 'anthropic', 'serpapi', 'twilio', 'resend'
  endpoint VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd DECIMAL(10,6) NOT NULL,

  response_id UUID REFERENCES responses(id),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_costs_business_date ON api_costs(business_id, created_at);
CREATE INDEX idx_costs_daily ON api_costs(created_at, provider);

-- Review exceptions (durable workflow for cases that need admin attention)
-- Replaces log-only warnings that are invisible at scale.
CREATE TABLE review_exceptions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  response_id UUID REFERENCES responses(id) ON DELETE SET NULL,

  type TEXT NOT NULL,        -- 'review_edited_after_post'
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'resolved', 'dismissed'
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Only one open exception per review+type (prevents notification storms from
-- repeated Google notifications about the same edit)
CREATE UNIQUE INDEX idx_review_exceptions_open
  ON review_exceptions(review_id, type)
  WHERE status = 'open';

-- Row-Level Security policies (Supabase)
-- Owners see only their own business data
-- Sales partners see all businesses they onboarded
-- Admins see everything
```

### Scale Notes on Data Model

| Table | Growth rate | Action trigger |
|---|---|---|
| reviews | ~5/week/business | At 500K rows: partition by `detected_at` yearly |
| responses | ~5/week/business | Same as reviews |
| inbound_events | ~10/week/business (notifications) | At 1M rows: archive `processed` rows older than 30 days |
| job_outbox | ~15/week/business | At 1M rows: archive `completed` rows older than 7 days |
| api_costs | ~20/week/business | At 1M rows: partition by `created_at` monthly, archive >90 days |
| notification_deliveries | ~10/week/business | Archive rows older than 90 days |
| prospect_demos | Low (sales-driven) | Expire and delete demos past 30 days via cron |

## 6. API Specification

### Public Endpoints (no auth, token-based)

```typescript
// Approval flow — the core owner interaction
GET    /api/approve/:token          // Read-only: validate token, render page, set CSRF cookie. NEVER writes to DB.
POST   /api/approval/session        // Bind device cookie hash on first deliberate user action ("Continue" button)
POST   /api/approve/:token/approve  // Requires session cookie + CSRF. Mark consumed, write outbox: publish_response
POST   /api/approve/:token/edit     // Requires session cookie + CSRF. Mark consumed, write outbox: publish_response (edited text)
POST   /api/approve/:token/regenerate // Requires session cookie + CSRF. Revoke old links, write outbox: generate_response

// Demo pages (for sales outreach)
GET    /demo/:slug                  // View prospect demo page (SSR)

// Webhooks (handled by worker service on Railway)
POST   /api/webhooks/stripe        // Subscription events (verified via Stripe signature)
POST   /api/webhooks/twilio        // SMS delivery status -> notification_deliveries
POST   /api/webhooks/resend        // Email delivery status -> notification_deliveries
POST   /api/webhooks/google-pubsub // Review change notifications -> inbound_events
```

### Authenticated Endpoints — Business Owner

```typescript
// Dashboard (optional — product works without this)
GET    /api/business/profile       // Get business profile + settings
PATCH  /api/business/profile       // Update tone, staff names, notification prefs
GET    /api/business/reviews       // List reviews with response status
GET    /api/business/stats         // Simple operational stats: response rate, avg time

// Response history
GET    /api/responses              // Paginated list of all responses
GET    /api/responses/:id          // Single response detail
```

### Authenticated Endpoints — Sales Partner (Admin View)

```typescript
// Client management
GET    /api/admin/businesses                 // All businesses with status summary
POST   /api/admin/businesses                 // Onboard new business (assisted flow)
PATCH  /api/admin/businesses/:id             // Update business settings
GET    /api/admin/businesses/:id/health      // Single business health: pending reviews, last response, SLA compliance

// Client overview (the "single screen" from the brief)
GET    /api/admin/overview                   // Aggregated view: businesses with pending reviews, SLA breaches, recent activity

// Demo management
GET    /api/admin/demos                      // All demos with conversion status
POST   /api/admin/demos/generate             // Generate demo via ReviewSource interface

// System health
GET    /api/admin/costs                      // API cost breakdown by provider, by business, by day
GET    /api/admin/costs/alerts               // Any businesses exceeding cost thresholds
GET    /api/admin/jobs                       // Outbox + BullMQ queue health: pending, active, failed jobs
GET    /api/admin/notifications              // Recent notification deliveries + failures
```

### Request/Response Shapes

```typescript
// Approval view — what the owner sees when they tap the notification link
interface ApprovalViewResponse {
  review: {
    reviewerName: string;
    starRating: number;
    reviewText: string;
    reviewDate: string;
  };
  response: {
    responseText: string;
    version: number;
    status: 'pending_approval';
  };
  business: {
    name: string;
  };
  expiresAt: string;
}

// Sales partner overview — the "single screen" CRM view
interface AdminOverviewResponse {
  businesses: Array<{
    id: string;
    name: string;
    category: string;
    subscriptionStatus: string;
    connectionStatus: string; // from google_connections.sync_status
    stats: {
      totalReviews: number;
      pendingApproval: number;
      responseRate: number;
      avgResponseTimeMinutes: number;
      slaBreaches: number;
    };
    lastActivityAt: string;
  }>;
  systemHealth: {
    outboxPending: number;
    queueDepth: number;
    failedJobs: number;
    todaysCostUsd: number;
    notificationFailures24h: number;
  };
}

// Business owner stats — simple operational metrics (not analytics dashboards)
interface BusinessStatsResponse {
  responseRate: {
    last30Days: number;
    allTime: number;
  };
  averageResponseTimeMinutes: number;
  totalReviewsHandled: number;
  pendingApproval: number;
}
```

## 7. Core Logic Design

### Response Generation Pipeline

```typescript
class ResponseGenerator {
  private openai: OpenAI;
  private anthropic: Anthropic;
  private cache: Redis;
  private costTracker: CostTracker;

  async generateResponse(
    review: Review,
    business: Business,
    version: number = 1
  ): Promise<GeneratedResponse> {
    // Pre-LLM input sanitization: defense-in-depth before text reaches the prompt.
    // The human approval step is the strongest guardrail, but sanitizing early
    // reduces the attack surface for prompt injection via adversarial reviews.
    const MAX_REVIEW_CHARS = 2000;
    const sanitizedText = this.sanitizeReviewText((review.reviewText ?? '').slice(0, MAX_REVIEW_CHARS));
    const normalizedReview = { ...review, reviewText: sanitizedText };

    // Check idempotent cache BEFORE acquiring any resources (avoids leaking
    // cost reservations and concurrency slots on cache hits)
    const cacheKey = `gen:${review.id}:v${version}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // --- Acquire resources: cost reservation + concurrency slot ---
    const dateKey = `cost:daily:${business.id}:${todayDateString()}`;
    const globalKey = `cost:global:${todayDateString()}`;
    const concurrencyKey = `gen:active:${business.id}`;
    // Reserve WORST-CASE cost, not average. Accounts for: long review text,
    // fallback to Anthropic (higher pricing), and guardrail retry (2x generation).
    const estimatedCostCents = 15;

    await this.reserveCost(dateKey, globalKey, estimatedCostCents, business.id);
    await this.acquireConcurrency(concurrencyKey, dateKey, globalKey, estimatedCostCents, business.id);

    // --- All resource-consuming work inside try/catch/finally ---
    // Two-phase cost accounting:
    //   Phase 1: pessimistic reservation (reservedCents) before any LLM call
    //   Phase 2: finalization — reconcile reservation to actual spend
    // Once finalized, the reservation must NEVER be refunded again, even if
    // later steps (costTracker.record, cache.setex) fail. Those are retryable;
    // the Redis budget counters are not allowed to drift backward.
    let actualSpentCents = 0;
    let reservationFinalized = false;

    try {
      if (version > 1) {
        await this.assertRegenerateBudget(review.id);
      }

      const language = this.detectLanguage(normalizedReview.reviewText);
      const voiceExamples = await this.getApprovedResponsePairs(business.id, { limit: 5 });
      const prompt = this.buildPrompt(normalizedReview, language, business, voiceExamples);

      // Generate with guardrails — returns total cost across ALL provider calls
      // (including guardrail retry if avoid_facts violation triggers a second call)
      const { response: finalResponse, totalSpentCents } = await this.generateWithGuardrails(prompt, language, business);
      actualSpentCents = totalSpentCents;

      // Finalize: adjust reservation to actual spend. After this point, no refund.
      // Use MULTI/EXEC or Lua script in production to make both keys update atomic.
      const costDelta = actualSpentCents - estimatedCostCents;
      if (costDelta !== 0) {
        await this.cache.incrby(dateKey, costDelta);
        await this.cache.incrby(globalKey, costDelta);
      }
      reservationFinalized = true;

      // Write to DB as audit trail (retryable — Redis is source of truth for budget)
      await this.costTracker.record({
        businessId: business.id,
        provider: finalResponse.provider,
        inputTokens: finalResponse.usage.promptTokens,
        outputTokens: finalResponse.usage.completionTokens,
        costUsd: actualSpentCents / 100,
      });

      await this.cache.setex(cacheKey, 3600, JSON.stringify(finalResponse));
      return finalResponse;

    } catch (error) {
      // Only refund if reservation was NOT yet finalized to actual spend.
      // After finalization, Redis accurately reflects real cost — never roll it back.
      if (!reservationFinalized) {
        const refundCents = Math.max(estimatedCostCents - actualSpentCents, 0);
        if (refundCents > 0) {
          await this.cache.decrby(dateKey, refundCents);
          await this.cache.decrby(globalKey, refundCents);
        }
      }
      throw error;
    } finally {
      await this.cache.decr(concurrencyKey);
    }
  }

  /** Reserve worst-case cost atomically. Throws if budget exceeded. */
  private async reserveCost(
    dateKey: string, globalKey: string, cents: number, businessId: string
  ): Promise<void> {
    const newTotal = await this.cache.incrby(dateKey, cents);
    if (newTotal === cents) await this.cache.expire(dateKey, 86400);
    if (newTotal > DAILY_COST_LIMIT_CENTS_PER_BUSINESS) {
      await this.cache.decrby(dateKey, cents);
      await this.costTracker.alertAdmin(businessId, newTotal);
      throw new CostLimitExceeded(businessId, newTotal);
    }
    const globalTotal = await this.cache.incrby(globalKey, cents);
    if (globalTotal === cents) await this.cache.expire(globalKey, 86400);
    if (globalTotal > GLOBAL_DAILY_COST_LIMIT_CENTS) {
      await this.cache.decrby(globalKey, cents);
      await this.cache.decrby(dateKey, cents);
      throw new GlobalCostLimitExceeded(globalTotal);
    }
  }

  /** Acquire per-business concurrency slot. Releases cost on failure. */
  private async acquireConcurrency(
    concurrencyKey: string, dateKey: string, globalKey: string,
    reservedCents: number, businessId: string
  ): Promise<void> {
    const activeCount = await this.cache.incr(concurrencyKey);
    if (activeCount === 1) await this.cache.expire(concurrencyKey, 300);
    if (activeCount > MAX_CONCURRENT_GENERATIONS_PER_BUSINESS) {
      await this.cache.decr(concurrencyKey);
      await this.cache.decrby(dateKey, reservedCents);
      await this.cache.decrby(globalKey, reservedCents);
      throw new ConcurrencyLimitExceeded(businessId, activeCount);
    }
  }

  /** Enforce max 3 regenerations per review per day. */
  private async assertRegenerateBudget(reviewId: string): Promise<void> {
    const regenKey = `regen:${reviewId}:${todayDateString()}`;
    const count = await this.cache.incr(regenKey);
    if (count === 1) await this.cache.expire(regenKey, 86400);
    if (count > MAX_REGENERATIONS_PER_REVIEW_PER_DAY) {
      throw new RegenerateLimitExceeded(reviewId, count);
    }
  }

  /**
   * Generate response, run avoid_facts guardrail, retry once if violated.
   * Returns total cost across ALL provider calls (including retries) so the
   * caller can reconcile the Redis cost reservation accurately.
   */
  private async generateWithGuardrails(
    prompt: string, language: string, business: Business
  ): Promise<{ response: GeneratedResponse; totalSpentCents: number }> {
    const response = await this.generateWithFallback(prompt, language);
    let totalSpentCents = Math.ceil(this.calculateCost(response) * 100);

    const violation = this.checkAvoidFacts(response.text, business.avoid_facts);
    if (!violation) return { response, totalSpentCents };

    logger.warn('LLM output contained avoided term, retrying', {
      businessId: business.id, term: violation,
    });
    const retryResponse = await this.generateWithFallback(
      prompt + `\n\nCRITICAL: Your previous response contained "${violation}" which the business has explicitly forbidden. Do NOT include this term.`,
      language
    );
    totalSpentCents += Math.ceil(this.calculateCost(retryResponse) * 100);

    const retryViolation = this.checkAvoidFacts(retryResponse.text, business.avoid_facts);
    if (retryViolation) {
      retryResponse.flaggedForReview = true;
      retryResponse.flagReason = `Contains avoided term: "${retryViolation}"`;
    }
    return { response: retryResponse, totalSpentCents };
  }

  private async generateWithFallback(
    prompt: string,
    language: string
  ): Promise<LLMResponse> {
    try {
      return await this.callOpenAI(prompt);
    } catch (error) {
      logger.warn('OpenAI failed, falling back to Anthropic', { error });
      return await this.callAnthropic(prompt);
    }
  }

  /**
   * Post-generation guardrail: simple case-insensitive keyword check against
   * the business's avoid_facts list. This is defense-in-depth — the LLM prompt
   * already says "don't mention X", but prompting is leaky. A regex check
   * costs microseconds and catches the exact failure mode.
   */
  private checkAvoidFacts(responseText: string, avoidFacts: string[]): string | null {
    if (!avoidFacts?.length) return null;
    const lowerText = responseText.toLowerCase();
    for (const fact of avoidFacts) {
      if (lowerText.includes(fact.toLowerCase())) {
        return fact;
      }
    }
    return null;
  }

  /**
   * Pre-LLM input sanitization. Strips characters and patterns that serve no
   * legitimate purpose in a review but could manipulate LLM behavior.
   * This is defense-in-depth — the human approval step is the primary guardrail.
   */
  private sanitizeReviewText(text: string): string {
    return text
      // Strip Unicode control characters (zero-width joiners, direction overrides, etc.)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
      // Strip null bytes
      .replace(/\0/g, '')
      // Collapse excessive whitespace (>3 consecutive newlines)
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
    // NOTE: We intentionally do NOT strip phrases like "ignore previous instructions"
    // because the LLM system prompt uses role separation, and aggressive text filtering
    // would corrupt legitimate non-English reviews. The human approval step catches
    // any LLM misbehavior before it reaches Google.
  }

  /**
   * Voice learning: uses the owner's past approved/edited responses as few-shot
   * examples so the AI learns their voice over time. Prioritizes edited responses
   * (where the owner corrected the AI) as these are the strongest signal.
   *
   * SCALE NOTE: This query runs on every generation. At <200 businesses, the
   * partial index makes it fast enough. At 500+, add a durable
   * `business_voice_profiles` table populated asynchronously when edited
   * responses are posted. Redis `voice:{business_id}` caches that snapshot
   * for fast reads. DB remains source of truth — Redis only accelerates.
   * Never make Redis the sole source for voice context (eviction, deploy
   * resets, and TTL mistakes cause "replies suddenly got generic" bugs).
   *
   * Required partial index (add to schema):
   *   CREATE INDEX idx_responses_voice ON responses(business_id, posted_at DESC)
   *   WHERE status = 'posted' AND edited_text IS NOT NULL;
   */
  private async getApprovedResponsePairs(
    businessId: string,
    opts: { limit: number }
  ): Promise<VoiceExample[]> {
    return await db.query(`
      SELECT r.review_text, resp.edited_text, resp.original_draft_text
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      WHERE resp.business_id = $1
        AND resp.status = 'posted'
        AND resp.edited_text IS NOT NULL
      ORDER BY resp.posted_at DESC
      LIMIT $2
    `, [businessId, opts.limit]);
  }
}

// System prompt
const SYSTEM_PROMPT = `You are a review response writer for a local business.
Your responses must:
1. Be specific to the review content — reference exact dishes, services, staff names mentioned
2. Match the business's tone (provided in context)
3. Be concise: under 80 words for positive reviews, up to 120 for negative
4. Never make promises not authorized by the business
5. For negative reviews: acknowledge the specific issue, empathize, don't argue or make excuses
6. Use the reviewer's name naturally if provided
7. Respond in the same language as the review
8. Never include placeholder text like [email] — if a resolution needs contact info, say "please reach out to us directly"

If example responses from the business owner are provided, match their style closely.`;
```

### Review Monitoring (Notification-First)

```typescript
/**
 * PRIMARY PATH: Google Pub/Sub notifications
 *
 * When a review is created/updated on a connected business, Google sends a
 * notification to our Pub/Sub topic. The worker ingress handler receives it,
 * deduplicates via inbound_events, and triggers a sync job.
 */
class PubSubIngress {
  async handleNotification(message: PubSubMessage): Promise<void> {
    const eventKey = message.messageId;
    const locationName = message.attributes?.location_name;

    // Deduplicate: if we've already processed this notification, skip
    const inserted = await db.query(`
      INSERT INTO inbound_events (source, external_event_key, event_type, aggregate_key, payload)
      VALUES ('google_pubsub', $1, 'review_changed', $2, $3)
      ON CONFLICT (external_event_key) DO NOTHING
      RETURNING id
    `, [eventKey, locationName, message.data]);

    if (!inserted.rows.length) {
      // Already processed, acknowledge and skip
      return;
    }

    // Write sync job to outbox and mark event processed in the same transaction.
    // IMPORTANT: only mark 'processed' if a sync job was actually created.
    // If no google_connections row matches (onboarding race, token disconnected),
    // mark 'failed' so the issue is observable and retryable — not silently dropped.
    await db.transaction(async (tx) => {
      const queued = await tx.query(`
        INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
        SELECT 'sync_reviews', 'business', gc.business_id,
               jsonb_build_object('google_location_name', gc.google_location_name, 'trigger', 'notification')
        FROM google_connections gc
        WHERE gc.google_location_name = $1 AND gc.sync_status = 'connected'
        RETURNING id
      `, [locationName]);

      if (!queued.rows.length) {
        await tx.query(`
          UPDATE inbound_events
          SET status = 'failed',
              error_message = 'No connected google_connections row matched Pub/Sub location_name'
          WHERE external_event_key = $1
        `, [eventKey]);
        return;
      }

      await tx.query(`
        UPDATE inbound_events
        SET status = 'processed', processed_at = NOW(), error_message = NULL
        WHERE external_event_key = $1
      `, [eventKey]);
    });
  }
}

/**
 * FALLBACK PATH: Reconciliation polling
 *
 * Runs on a slow cadence (60-240 min adaptive) to catch any reviews missed
 * by notifications. This handles: missed Pub/Sub deliveries, token refresh
 * windows, initial sync after onboarding, and general sync drift.
 */
class ReconciliationPoller {
  async pollDueBusinesses(): Promise<void> {
    const businesses = await db.query(`
      SELECT gc.business_id, gc.google_location_name
      FROM google_connections gc
      JOIN businesses b ON b.id = gc.business_id
      WHERE gc.sync_status = 'connected'
        AND b.subscription_status = 'active'
        AND (gc.last_full_sync_at IS NULL
             OR gc.last_full_sync_at < NOW() - make_interval(mins := $1))
    `, [this.getAdaptiveIntervalMinutes()]);

    for (const biz of businesses.rows) {
      await db.query(`
        INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
        VALUES ('sync_reviews', 'business', $1,
                jsonb_build_object('google_location_name', $2, 'trigger', 'reconciliation'))
      `, [biz.business_id, biz.google_location_name]);
    }
  }

  /**
   * Adaptive interval: since notifications are primary, polling is slower.
   * - Businesses with recent notification activity: 120 min
   * - Businesses without notification in 24h: 60 min (more aggressive, may indicate notification gap)
   * - Businesses without notification in 7d: 240 min (likely just quiet)
   */
  private getAdaptiveIntervalMinutes(): number {
    // Simplified — actual implementation queries per-business
    return 120;
  }
}

/**
 * Shared review sync worker — used by both notification and reconciliation paths.
 * Fetches full review data from GBP API, deduplicates, and writes outbox entries
 * for new reviews.
 */
class ReviewSyncWorker {
  async syncReviews(job: Job): Promise<void> {
    const { google_location_name, trigger } = job.data;

    const connection = await db.query(`
      SELECT * FROM google_connections WHERE google_location_name = $1
    `, [google_location_name]);

    if (!connection.rows.length) return;

    const conn = connection.rows[0];

    // Token refresh with distributed lock — prevents thundering herd.
    // When multiple workers hit refreshTokenIfNeeded() for the same business
    // simultaneously, Google invalidates the old refresh token on first use.
    // Worker B's refresh then fails because its refresh token is already dead.
    // Fix: Redis lock ensures only one worker refreshes at a time.
    const accessToken = await this.withRefreshLock(conn.business_id, async () => {
      return await this.refreshTokenIfNeeded(conn);
    });

    // Quota guard: two-level check (per-location backoff + project-wide quota).
    // One noisy location should degrade itself before throttling the whole platform.

    // Level 1: Per-location error rate backoff. If this location has had recent
    // rate-limit errors, back off before trying again.
    const locationErrorKey = `gbp:errors:${google_location_name}`;
    const recentErrors = await this.cache.get(locationErrorKey);
    if (recentErrors !== null && parseInt(recentErrors) >= 3) {
      logger.warn('Location has recent GBP errors, backing off', { google_location_name });
      throw new LocationBackoff(); // BullMQ retries with exponential backoff
    }

    // Level 2: Project-wide quota check. Only halt if the entire project is near exhaustion.
    const projectQuota = await this.cache.get('gbp:quota:project');
    if (projectQuota !== null && parseInt(projectQuota) < 10) {
      logger.warn('GBP project quota critically low', { projectQuota });
      throw new QuotaExhausted();
    }

    // Fetch reviews from GBP API using the canonical location name
    let reviews: GoogleReview[];
    let rateLimitRemaining: number | undefined;
    try {
      const result = await this.gbpClient.listReviews(google_location_name, accessToken);
      reviews = result.reviews;
      rateLimitRemaining = result.rateLimitRemaining;
      // Clear location error count on success
      await this.cache.del(locationErrorKey);
    } catch (error) {
      // Track per-location errors for adaptive backoff
      await this.cache.incr(locationErrorKey);
      await this.cache.expire(locationErrorKey, 600); // 10 min decay window
      throw error;
    }

    // Track project-wide quota from response headers
    if (rateLimitRemaining !== undefined) {
      await this.cache.setex('gbp:quota:project', 60, String(rateLimitRemaining));
    }

    for (const review of reviews) {
      const contentHash = sha256(`${review.starRating}|${review.comment}`);
      const detectedLang = this.detectLanguage(review.comment);

      // CRITICAL: review upsert + outbox entry MUST be in the same transaction.
      // If the worker crashes between them, the review sits in 'new' status forever
      // with no generation job queued. This is the #1 silent data loss vector.
      //
      // Google notifications can represent both new AND updated reviews. The upsert
      // compares review_content_hash to distinguish: new review, unchanged replay,
      // updated review before posting, updated review after posting.
      await db.transaction(async (tx) => {
        // Read existing review FIRST to compare hash BEFORE the upsert overwrites it.
        // (The upsert's RETURNING would return the NEW hash, making comparison useless.)
        const existing = await tx.query(`
          SELECT id, review_content_hash FROM reviews
          WHERE provider = 'google' AND provider_review_name = $1
          FOR UPDATE
        `, [review.name]);

        const isNew = !existing.rows.length;
        const contentChanged = !isNew && existing.rows[0].review_content_hash !== contentHash;

        const result = await tx.query(`
          INSERT INTO reviews (business_id, provider, provider_review_id, provider_review_name,
                               provider_location_name, reviewer_name, star_rating, review_text,
                               review_date, detected_language, review_content_hash)
          VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (provider, provider_review_name) DO UPDATE
          SET reviewer_name = EXCLUDED.reviewer_name,
              star_rating = EXCLUDED.star_rating,
              review_text = EXCLUDED.review_text,
              review_date = EXCLUDED.review_date,
              detected_language = EXCLUDED.detected_language,
              review_content_hash = EXCLUDED.review_content_hash
          RETURNING id
        `, [conn.business_id, review.reviewId, review.name, google_location_name,
            review.reviewer.displayName, review.starRating, review.comment,
            review.createTime, detectedLang, contentHash]);

        const reviewId = result.rows[0].id;

        if (isNew) {
          // New review — queue response generation
          await tx.query(`
            INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
            VALUES ('generate_response', 'review', $1,
                    jsonb_build_object('review_id', $1::text, 'business_id', $2::text))
          `, [reviewId, conn.business_id]);

        } else if (contentChanged) {
          // Review was edited by the reviewer on Google. Check response status.
          const existingResponse = await tx.query(`
            SELECT id, status FROM responses
            WHERE review_id = $1 ORDER BY version DESC LIMIT 1
          `, [reviewId]);

          if (!existingResponse.rows.length || existingResponse.rows[0].status === 'pending_approval') {
            // No response yet or still pending — supersede and regenerate
            if (existingResponse.rows.length) {
              await tx.query(`UPDATE responses SET status = 'failed', posting_error = 'Review updated by reviewer' WHERE id = $1`, [existingResponse.rows[0].id]);
            }
            await tx.query(`
              INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
              VALUES ('generate_response', 'review', $1,
                      jsonb_build_object('review_id', $1::text, 'business_id', $2::text, 'reason', 'review_updated'))
            `, [reviewId, conn.business_id]);
          } else {
            // Response already posted — create a durable exception for admin review.
            // Do NOT auto-regenerate or re-post. This must be a human decision.
            // ON CONFLICT DO NOTHING prevents a notification storm if Google
            // sends repeated notifications for the same edited review.
            await tx.query(`
              INSERT INTO review_exceptions (business_id, review_id, response_id, type, payload)
              VALUES ($1, $2, $3, 'review_edited_after_post',
                      jsonb_build_object(
                        'google_location_name', $4,
                        'response_status', $5,
                        'reason', 'Reviewer edited review after public reply was posted'
                      ))
              ON CONFLICT DO NOTHING
            `, [conn.business_id, reviewId, existingResponse.rows[0].id,
                google_location_name, existingResponse.rows[0].status]);

            await tx.query(`
              INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
              VALUES ('notify_admin_review_exception', 'review', $1,
                      jsonb_build_object(
                        'review_id', $1::text,
                        'business_id', $2::text,
                        'exception_type', 'review_edited_after_post'
                      ))
            `, [reviewId, conn.business_id]);
          }
        }
        // If !isNew && !contentChanged: unchanged replay, no action needed
      });
    }

    // Update sync timestamp
    await db.query(`
      UPDATE google_connections SET last_full_sync_at = NOW() WHERE id = $1
    `, [conn.id]);
  }
}
```

### Outbox Poller

```typescript
/**
 * Runs every 10 seconds. Reads pending outbox entries and dispatches them
 * to BullMQ queues. This is the bridge between transactional writes and
 * async processing.
 */
class OutboxPoller {
  async poll(): Promise<void> {
    // Watchdog recovery: if a worker crashed after BullMQ accepted the job,
    // the outbox row stays stuck in 'dispatched'. Reset stale entries —
    // but respect max_attempts so poison jobs reach terminal 'failed' instead
    // of being revived forever and burning worker capacity.
    // Note: attempts counts BOTH dispatch failures AND watchdog recoveries.
    await db.query(`
      UPDATE job_outbox
      SET status = CASE
            WHEN attempts >= max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          dispatched_at = NULL,
          last_error = CASE
            WHEN attempts >= max_attempts
              THEN 'Watchdog: terminal failure after repeated worker crashes'
            ELSE 'Watchdog reset: no completion after 1 hour'
          END,
          available_at = CASE
            WHEN attempts >= max_attempts THEN available_at
            ELSE NOW()
          END
      WHERE status = 'dispatched'
        AND completed_at IS NULL
        AND dispatched_at < NOW() - INTERVAL '1 hour'
    `);

    const pending = await db.query(`
      UPDATE job_outbox
      SET status = 'dispatched', dispatched_at = NOW(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM job_outbox
        WHERE status = 'pending' AND available_at <= NOW()
        ORDER BY available_at
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    for (const entry of pending.rows) {
      try {
        await this.dispatch(entry);
      } catch (error) {
        // If dispatch fails, check whether max_attempts is reached.
        // If so, transition to 'failed' (terminal — requires manual investigation).
        // Otherwise, reset to 'pending' for retry on next poll cycle.
        await db.query(`
          UPDATE job_outbox
          SET status = CASE
                WHEN attempts >= max_attempts THEN 'failed'
                ELSE 'pending'
              END,
              last_error = $2
          WHERE id = $1
        `, [entry.id, error.message]);
      }
    }
  }

  private async dispatch(entry: OutboxEntry): Promise<void> {
    await this.bullmq.add(entry.topic, {
      ...entry.payload,
      outbox_id: entry.id, // Workers use this to complete the exact outbox row
    }, {
      jobId: entry.id, // Idempotent: BullMQ deduplicates by jobId
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
}
```

### Approval & Publishing Flow

```typescript
class ApprovalService {
  /**
   * All approval operations follow the same pattern:
   * 1. Validate token by hashing and looking up in approval_links
   * 2. Write state change + outbox entry in a single transaction
   * 3. Worker picks up outbox entry and does the async work
   */
  /**
   * All approval operations acquire a row lock (FOR UPDATE) on the approval_links
   * row INSIDE the transaction to prevent concurrent double-processing.
   */
  async approve(rawToken: string, deviceCookieHash: string): Promise<void> {
    const tokenHash = sha256(rawToken);

    await db.transaction(async (tx) => {
      const link = await this.lockValidLink(tx, tokenHash, deviceCookieHash);

      // Consume this link
      await tx.query(`
        UPDATE approval_links SET consumed_at = NOW() WHERE id = $1
      `, [link.id]);

      // Revoke sibling links (e.g., SMS link when email link is used)
      await tx.query(`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = $1 AND id <> $2
          AND consumed_at IS NULL AND revoked_at IS NULL
      `, [link.response_id, link.id]);

      // Update response — RETURNING guards against already-processed race
      const updated = await tx.query(`
        UPDATE responses
        SET status = 'approved', approved_at = NOW(), approved_text = response_text
        WHERE id = $1 AND status = 'pending_approval'
        RETURNING id
      `, [link.response_id]);

      if (!updated.rows.length) throw new AlreadyProcessed(link.response_id);

      await tx.query(`
        INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
        VALUES ('publish_response', 'response', $1,
                jsonb_build_object('response_id', $1::text, 'business_id', $2::text))
      `, [link.response_id, link.business_id]);
    });
  }

  async edit(rawToken: string, editedText: string, deviceCookieHash: string): Promise<void> {
    const tokenHash = sha256(rawToken);

    await db.transaction(async (tx) => {
      const link = await this.lockValidLink(tx, tokenHash, deviceCookieHash);

      const response = await tx.query(`
        SELECT original_draft_text FROM responses WHERE id = $1
      `, [link.response_id]);
      const editDistance = levenshtein(response.rows[0].original_draft_text, editedText);

      // Consume this link
      await tx.query(`
        UPDATE approval_links SET consumed_at = NOW() WHERE id = $1
      `, [link.id]);

      // Revoke sibling links
      await tx.query(`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = $1 AND id <> $2
          AND consumed_at IS NULL AND revoked_at IS NULL
      `, [link.response_id, link.id]);

      // Update response — RETURNING guards against already-processed race
      const updated = await tx.query(`
        UPDATE responses
        SET status = 'edited', approved_at = NOW(), edited_text = $2,
            edit_distance = $3, approved_text = $2
        WHERE id = $1 AND status = 'pending_approval'
        RETURNING id
      `, [link.response_id, editedText, editDistance]);

      if (!updated.rows.length) throw new AlreadyProcessed(link.response_id);

      await tx.query(`
        INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
        VALUES ('publish_response', 'response', $1,
                jsonb_build_object('response_id', $1::text, 'business_id', $2::text))
      `, [link.response_id, link.business_id]);
    });
  }

  async regenerate(rawToken: string, deviceCookieHash: string): Promise<void> {
    const tokenHash = sha256(rawToken);

    await db.transaction(async (tx) => {
      const link = await this.lockValidLink(tx, tokenHash, deviceCookieHash);

      const response = await tx.query(`
        SELECT review_id, version, response_text FROM responses WHERE id = $1
      `, [link.response_id]);
      const resp = response.rows[0];

      await tx.query(`
        UPDATE approval_links SET consumed_at = NOW() WHERE id = $1
      `, [link.id]);

      // Revoke ALL outstanding links for this response
      await tx.query(`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
      `, [link.response_id]);

      await tx.query(`
        INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
        VALUES ('generate_response', 'review', $1,
                jsonb_build_object('review_id', $1::text, 'business_id', $2::text,
                                   'version', $3, 'previous_draft', $4))
      `, [resp.review_id, link.business_id, resp.version + 1, resp.response_text]);
    });
  }

  /**
   * Establishes the device-bound session. Called when the owner taps "Continue"
   * on the approval page (POST /api/approval/session). This is the first
   * state-changing step — GET is always read-only.
   *
   * Email security scanners prefetch GET but never POST, so binding here
   * prevents scanners from hijacking the session before the real user.
   */
  async establishApprovalSession(
    rawToken: string,
    deviceCookieHash: string
  ): Promise<void> {
    const tokenHash = sha256(rawToken);

    await db.transaction(async (tx) => {
      const result = await tx.query(`
        SELECT id, device_cookie_hash
        FROM approval_links
        WHERE token_hash = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE
      `, [tokenHash]);

      if (!result.rows.length) throw new TokenInvalid();
      const link = result.rows[0];

      if (link.device_cookie_hash === null) {
        // First session establishment — bind to this device
        await tx.query(`
          UPDATE approval_links SET device_cookie_hash = $2 WHERE id = $1
        `, [link.id, deviceCookieHash]);
        return;
      }

      // Already bound — verify it matches
      if (link.device_cookie_hash !== deviceCookieHash) {
        throw new TokenBoundToAnotherSession();
      }
    });
  }

  /**
   * Validates and locks the approval link row inside a transaction.
   * FOR UPDATE prevents concurrent requests from double-processing the same token.
   *
   * Flow:
   * - GET /approve/:token is read-only and never writes to the DB.
   * - POST /api/approval/session binds device_cookie_hash on the first deliberate user action.
   * - All approval POST actions require raw token + bound device cookie + CSRF token.
   * - The raw token alone is only sufficient for read-only access.
   */
  private async lockValidLink(
    tx: Transaction,
    tokenHash: string,
    deviceCookieHash: string
  ): Promise<ApprovalLink> {
    const result = await tx.query(`
      SELECT * FROM approval_links
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND device_cookie_hash = $2
      FOR UPDATE
    `, [tokenHash, deviceCookieHash]);

    if (!result.rows.length) throw new TokenInvalid();
    return result.rows[0];
  }
}

/**
 * Publishes approved responses to Google using the canonical resource names.
 */
class ResponsePublisherWorker {
  async postResponse(job: Job): Promise<void> {
    const { response_id, business_id, outbox_id } = job.data;

    const response = await db.get('responses', response_id);

    // Idempotency: if already posted, complete outbox and exit
    if (response.status === 'posted') {
      await this.completeOutbox(outbox_id);
      return;
    }

    const review = await db.get('reviews', response.review_id);
    const connection = await db.query(`
      SELECT * FROM google_connections WHERE business_id = $1
    `, [business_id]);

    if (!connection.rows.length || connection.rows[0].sync_status !== 'connected') {
      await db.update('responses', response_id, {
        status: 'failed',
        posting_error: 'Google Business Profile not connected.',
      });
      // Terminal failure — mark outbox as failed, don't retry
      await this.failOutbox(outbox_id, 'Google Business Profile not connected.');
      return;
    }

    const conn = connection.rows[0];
    // Same distributed lock as ReviewSyncWorker — prevents token refresh thundering herd
    const accessToken = await this.withRefreshLock(business_id, async () => {
      return await this.refreshTokenIfNeeded(conn);
    });

    try {
      // Post using Google review resource name, not internal IDs
      await this.gbpClient.updateReply({
        reviewName: review.provider_review_name,
        comment: response.approved_text,
        accessToken,
      });

      await db.update('responses', response_id, {
        status: 'posted',
        posted_at: new Date(),
      });

      await this.completeOutbox(outbox_id);

    } catch (error) {
      await db.update('responses', response_id, {
        posting_error: error.message,
      });
      throw error; // Let BullMQ retry (outbox stays dispatched until retry succeeds or max_attempts)
    }
  }

  private async completeOutbox(outboxId: string): Promise<void> {
    await db.query(`
      UPDATE job_outbox SET completed_at = NOW(), status = 'completed' WHERE id = $1
    `, [outboxId]);
  }

  private async failOutbox(outboxId: string, reason: string): Promise<void> {
    await db.query(`
      UPDATE job_outbox SET status = 'failed', last_error = $2 WHERE id = $1
    `, [outboxId, reason]);
  }
}

/**
 * Consumes 'notify_admin_review_exception' outbox entries.
 * Sends an email to the admin/sales partner when a reviewer edits their review
 * after a response was already posted. This requires human judgment — the system
 * does NOT auto-regenerate or re-post.
 */
class AdminExceptionWorker {
  async notify(job: Job): Promise<void> {
    const { review_id, business_id, exception_type, outbox_id } = job.data;

    const exception = await db.query(`
      SELECT * FROM review_exceptions
      WHERE review_id = $1 AND status = 'open' AND type = $2
      ORDER BY created_at DESC LIMIT 1
    `, [review_id, exception_type]);

    if (!exception.rows.length) {
      // Exception was resolved before worker picked it up — complete and skip
      await this.completeOutbox(outbox_id);
      return;
    }

    await this.emailAdmin({
      subject: `Review edited after reply was posted`,
      businessId: business_id,
      payload: exception.rows[0].payload,
    });

    await this.completeOutbox(outbox_id);
  }

  private async completeOutbox(outboxId: string): Promise<void> {
    await db.query(`
      UPDATE job_outbox SET status = 'completed', completed_at = NOW() WHERE id = $1
    `, [outboxId]);
  }
}
```

### Notification Reliability & Failover

```typescript
/**
 * Notification is a customer-trust surface, not just an ops detail.
 * If the owner never receives the approval prompt, the review never gets
 * responded to — a silent SLA failure that directly causes churn.
 *
 * Two safeguards:
 * 1. Channel failover: if primary channel fails, try secondary
 * 2. Stale draft alerting: flag responses stuck in pending_approval
 */
class NotificationFailover {
  /**
   * Runs as a cron job every 2 hours. Checks for responses that have been
   * pending_approval for longer than the threshold with no successful delivery
   * on any channel. Triggers fallback channel or admin alert.
   */
  async checkStaleDrafts(): Promise<void> {
    const stale = await db.query(`
      SELECT r.id AS response_id, r.business_id, b.notification_preference,
             b.owner_email, b.owner_phone
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      WHERE r.status = 'pending_approval'
        AND r.created_at < NOW() - INTERVAL '4 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = r.id AND nd.delivered_at IS NOT NULL
        )
    `);

    for (const draft of stale.rows) {
      // Try the alternate channel
      const primaryChannel = draft.notification_preference === 'sms' ? 'sms' : 'email';
      const fallbackChannel = primaryChannel === 'email' ? 'sms' : 'email';

      // Only try fallback if the business has the alternate contact info
      const canFallback = fallbackChannel === 'sms' ? !!draft.owner_phone : !!draft.owner_email;

      if (canFallback) {
        await db.query(`
          INSERT INTO job_outbox (topic, aggregate_type, aggregate_id, payload)
          VALUES ('send_notification', 'response', $1,
                  jsonb_build_object('response_id', $1::text, 'business_id', $2::text,
                                     'channel', $3, 'is_fallback', true))
        `, [draft.response_id, draft.business_id, fallbackChannel]);
      }

      // Alert admin regardless — stale drafts need visibility
      logger.warn('Stale draft detected', {
        responseId: draft.response_id,
        businessId: draft.business_id,
        fallbackAttempted: canFallback,
      });
    }
  }
}
```

### Weekly Summary (Simple, Not an Intelligence Engine)

```typescript
class WeeklySummaryWorker {
  async generateForBusiness(businessId: string): Promise<void> {
    const weekStart = getLastMonday();
    const reviews = await this.getWeeklyReviews(businessId, weekStart);

    if (reviews.length === 0) return;

    const responded = reviews.filter(r => r.status === 'posted').length;
    const notable = reviews.filter(r => r.starRating <= 2);

    const summaryText = this.formatSummary({
      totalReviews: reviews.length,
      totalResponded: responded,
      notableReviews: notable,
    });

    await this.saveSummary(businessId, weekStart, {
      totalReviews: reviews.length,
      totalResponded: responded,
      notableReviews: notable.map(r => ({ reviewId: r.id, reason: `${r.starRating}-star review` })),
      summaryText,
    });

    await this.emailService.sendWeeklySummary(businessId, summaryText);
  }

  private formatSummary(data: WeeklySummaryData): string {
    let text = `This week: ${data.totalReviews} new reviews, ${data.totalResponded} responded to.`;
    if (data.notableReviews.length > 0) {
      text += `\n\n${data.notableReviews.length} review(s) rated 2 stars or below may need your attention.`;
    }
    return text;
  }
}
```

## 8. Frontend Structure

### Page Structure

```
app/
├── (public)/
│   ├── page.tsx                    // Landing page
│   ├── demo/[slug]/
│   │   └── page.tsx                // Prospect demo viewer (SSR)
│   └── approve/[token]/
│       └── page.tsx                // Approval interface (mobile-first, no login)
│
├── (authenticated)/
│   ├── dashboard/
│   │   └── page.tsx                // Business owner: review list + simple stats
│   └── settings/
│       └── page.tsx                // Business owner: tone, staff names, notification prefs
│
└── (admin)/                         // Sales partner + admin views
    ├── overview/
    │   └── page.tsx                // CRM-like overview of all businesses
    ├── businesses/
    │   ├── page.tsx                // Business list with health indicators
    │   └── [id]/
    │       └── page.tsx            // Single business detail + onboarding form
    ├── demos/
    │   └── page.tsx                // Demo generation + tracking
    ├── notifications/
    │   └── page.tsx                // Notification delivery log (for troubleshooting)
    └── costs/
        └── page.tsx                // Cost monitoring + alerts
```

### Key UI Components

```typescript
// Approval page — the most important screen in the product
// Must work perfectly on mobile, load fast, require zero authentication
//
// EMAIL PREVIEW PROTECTION: The initial HTML (returned by SSR) must NOT contain
// review text or draft response. Gmail, Outlook, and Slack pre-fetch GET URLs
// to generate link previews — this would cache sensitive review data on their servers.
// Instead, SSR returns a minimal shell (business name + "Review a draft response")
// that sets the device-binding cookie. Actual content loads via client-side fetch
// AFTER the page mounts and cookie is set. Preview bots don't execute JS.
function ApprovalPage({ token }: { token: string }) {
  const { data, isLoading } = useApprovalData(token); // Client-side fetch, not SSR

  if (isLoading) return <ApprovalSkeleton />;
  if (!data) return <TokenExpired />;

  return (
    <div className="min-h-screen bg-gray-50 p-4 max-w-lg mx-auto">
      <ReviewCard
        reviewerName={data.review.reviewerName}
        starRating={data.review.starRating}
        reviewText={data.review.reviewText}
        reviewDate={data.review.reviewDate}
      />

      <ResponseDraft
        responseText={data.response.responseText}
        onApprove={() => approve(token)}
        onEdit={(text) => edit(token, text)}
        onRegenerate={() => regenerate(token)}
      />

      <p className="text-xs text-gray-400 mt-6 text-center">
        Powered by {data.business.name} AI Review Responder
      </p>
    </div>
  );
}

// Sales partner overview — the "single screen" CRM from the product brief
function AdminOverview() {
  const { data } = useAdminOverview();

  return (
    <div>
      <SystemHealthBar
        outboxPending={data.systemHealth.outboxPending}
        queueDepth={data.systemHealth.queueDepth}
        failedJobs={data.systemHealth.failedJobs}
        todaysCost={data.systemHealth.todaysCostUsd}
        notificationFailures={data.systemHealth.notificationFailures24h}
      />

      <BusinessTable
        businesses={data.businesses}
        columns={['name', 'connectionStatus', 'pendingApproval', 'responseRate', 'slaBreaches', 'lastActivity']}
        sortBy="pendingApproval"
        onRowClick={(id) => navigate(`/admin/businesses/${id}`)}
      />
    </div>
  );
}
```

## 9. Three User Experiences (Mapped to Architecture)

### A. Business Owner Experience
| Step | What they do | What the system does |
|---|---|---|
| Onboarding | 20-min call with sales partner | Sales partner fills `/admin/businesses/new` form, triggers Google OAuth, configures tone/staff/highlights |
| Day-to-day | Receives email/SMS, taps approval link | Pub/Sub notification -> ReviewSyncWorker -> ResponseGenerator -> NotificationWorker sends link |
| Approval | Reads draft, taps Approve/Edit/Regenerate | ApprovalService writes transaction + outbox -> PublisherWorker posts to Google |
| Weekly | Reads Monday summary email | WeeklySummaryWorker generates and sends |
| Optional | Checks `/dashboard` for stats | Next.js page queries `business/stats` endpoint |

### B. Sales Partner Experience
| Step | What they do | What the system does |
|---|---|---|
| Prospect demo | Enters Google Maps URL in `/admin/demos` | ReviewSource (SerpAPI) fetches reviews, LLM generates sample responses, creates `/demo/:slug` |
| Onboarding client | Fills form in `/admin/businesses/new` | Creates business + google_connections, enables Pub/Sub notifications, triggers initial sync |
| Monitoring | Checks `/admin/overview` daily | Real-time view of all businesses: connection status, pending reviews, SLA breaches, notification failures |
| Troubleshooting | Checks `/admin/notifications` | Sees delivery log: which emails/SMS were sent, delivered, or failed |

### C. Engineer Experience
| Concern | How it's handled |
|---|---|
| Add new customer | Sales partner self-serves via admin UI (< 5 min) |
| System health | `/admin/costs` for spend, `/admin/jobs` for outbox + queue health, Better Stack for errors |
| Lost work investigation | Check `inbound_events` for missed notifications, `job_outbox` for stuck entries, `notification_deliveries` for failed sends |
| Incident response | Outbox entries are durable — replay by resetting status to `pending`. BullMQ dead letter queue for worker crashes. |
| Scaling up | Add Railway worker instances, increase Supabase tier, separate Redis if needed |

## 10. Implementation Plan

### Pre-Week 1: Google Business Profile API Validation (Days 1-5)

This is the go/no-go gate. Do this before writing any production code.

- [ ] Apply for Google Business Profile API access
- [ ] Set up OAuth consent screen and submit for verification
- [ ] Test API access: can we read reviews? Can we post replies?
- [ ] Configure Google Cloud Pub/Sub topic for review change notifications
- [ ] Verify notification delivery: create a test review, confirm Pub/Sub message arrives
- [ ] Confirm project quota is sufficient for planned volume
- [ ] If access is denied or delayed: design "manual posting" fallback where we generate the response but the owner copy-pastes it
- [ ] **Go/No-Go decision**: if posting + notifications work, proceed with full automation. If not, proceed with generation-only MVP.

### Week 1: Demo Engine (The First Milestone)

**Goal**: Sales partner can generate a demo for any business and show it to a prospect.

- **Day 1-2**: Project scaffolding
  - Initialize Next.js project with TypeScript strict mode
  - Set up Supabase project, run all schema migrations (including workflow tables), enable connection pooling
  - Provision two Upstash Redis instances (cache + queue)
  - Deploy skeleton to Vercel + Railway
  - **Done when**: Empty app is live at production URL, all tables exist

- **Day 3-4**: Demo generation pipeline
  - `ReviewSource` interface with SerpAPI implementation (pluggable for future swap)
  - OpenAI integration with cost tracking (per-call cost recording to `api_costs`)
  - Language detection
  - Response generation with the system prompt
  - Demo page: SSR page showing reviews + AI responses side-by-side, mobile-responsive
  - **Done when**: You can paste a Google Maps URL and get a demo page with AI responses

- **Day 5**: Demo polish
  - Shareable slug generation
  - Demo expiration (30 days)
  - View tracking
  - Admin page for sales partner to generate and manage demos
  - **Done when**: Sales partner can independently generate and share demo links

### Week 2: Notification Ingress + Outbox Foundation

**Goal**: The system receives Google notifications and processes them durably through the outbox.

- **Day 6-7**: Pub/Sub ingress + outbox infrastructure
  - Google Cloud Pub/Sub subscription pointing to Railway worker endpoint
  - PubSubIngress handler: verify OIDC token on every request (day-one, not deferred — the endpoint is public), deduplicate via `inbound_events`, write to `job_outbox`
  - OutboxPoller: 10-second cron that reads pending outbox entries and dispatches to BullMQ
  - BullMQ queue setup (review_sync, generate_response, send_notification, publish_response, notify_admin_review_exception)
  - **Done when**: A Pub/Sub test message creates an `inbound_events` row and an `job_outbox` entry that gets dispatched to BullMQ

- **Day 8-9**: Review sync + response generation
  - ReviewSyncWorker: fetches reviews from GBP API using `google_location_name`, deduplicates, writes new reviews + outbox entries
  - ResponseGeneratorWorker: picks up `generate_response` jobs, generates draft via LLM, saves response + outbox entry for notification
  - Idempotency on both workers (safe to replay)
  - Cost circuit breaker (per-business daily limit)
  - **Done when**: New Google review -> notification -> sync -> draft generated, all via outbox

- **Day 10**: Reconciliation poller
  - ReconciliationPoller: slow cron that writes `sync_reviews` outbox entries for businesses due for a sync
  - Adaptive intervals (60/120/240 min based on notification activity)
  - **Done when**: Businesses without recent notifications get polled on schedule

### Week 3: Approval Flow + Publishing + Notifications

**Goal**: Owner approves from a notification link, response gets posted to Google. All durable via outbox.

- **Day 11-12**: Approval link system
  - Token generation: `crypto.randomUUID()`, stored as `sha256(token)` in `approval_links`
  - ApprovalService: approve/edit/regenerate all write state + outbox in single transaction
  - Revocation: regenerate revokes all outstanding links for that response
  - Approval page UI (mobile-first, no login)
  - **Done when**: Owner can complete full approve/edit/regenerate flow from phone

- **Day 13**: Notification system
  - NotificationWorker: picks up `send_notification` outbox entries
  - Email via Resend with approval link, SMS via Twilio with approval link
  - Write delivery records to `notification_deliveries`
  - Twilio/Resend webhook handlers update `notification_deliveries` with delivery status
  - **Done when**: Owner receives notification, delivery is tracked end-to-end

- **Day 14**: Google posting
  - ResponsePublisherWorker: picks up `publish_response` outbox entries
  - Posts via GBP API using `review.provider_review_name` (not internal IDs)
  - OAuth token refresh handling
  - Idempotent: checks `response.status === 'posted'` before posting
  - Failure handling: updates `posting_error`, BullMQ retries with backoff
  - **Done when**: Approved response appears on Google within 5 minutes

- **Day 15**: End-to-end testing
  - Full loop: review posted -> Pub/Sub notification -> sync -> draft -> notification -> approve -> posted to Google
  - All via outbox — verify no work is lost when Redis is temporarily unavailable
  - Failure scenarios: LLM timeout, Google API down, token expired, Pub/Sub replay
  - **Done when**: Complete loop works reliably, outbox replay recovers from failures

### Week 4: Sales Partner Admin + Security

**Goal**: Sales partner can manage all clients from one screen. System is hardened.

- **Day 16-17**: Sales partner admin dashboard
  - Admin overview page (CRM view with connection status, pending reviews, SLA compliance, notification failures)
  - Business onboarding form (creates business + google_connections, triggers OAuth + Pub/Sub setup)
  - Demo management page
  - Notification delivery log page
  - **Done when**: Sales partner can onboard a client and monitor all clients without engineering help

- **Day 18-19**: Security hardening
  - Per-business daily LLM cost limits with circuit breaker
  - Rate limiting on all public endpoints (approval, demo, webhooks)
  - Rate limiting on regenerate (prevent spam)
  - Pub/Sub message verification (verify message authenticity)
  - Stripe webhook signature verification
  - Input sanitization (review text in UI, prevent XSS)
  - Audit logging for all approval actions
  - **Done when**: System survives simulated cost attack, token enumeration, and regenerate spam

- **Day 20**: Stripe integration
  - Payment flow for new businesses (founding tier $99, standard $149)
  - Subscription events via Stripe webhook -> `inbound_events` -> outbox-driven status updates
  - Access control based on subscription status
  - **Done when**: New business can sign up and pay

### Week 5-6: Production Hardening + First 10 Customers

**Goal**: System is reliable enough for 10 paying customers.

- PostHog analytics integration (track approval rates, edit rates, response times)
- Better Stack error tracking and uptime monitoring
- Alerting: Better Stack alerts for failed outbox entries, cost overruns, SLA breaches, notification failures
- Weekly summary email worker
- Outbox monitoring: alert if any entry is stuck in `pending` for > 5 minutes or `dispatched` for > 1 hour
- Bug fixes from early customer feedback
- Performance optimization (approval page must load in < 2 seconds on 3G)
- Load testing: simulate 10 businesses, 50 reviews/week each, verify outbox throughput
- **Done when**: 10 businesses running with zero manual intervention required

### Week 7-8: Retention + Scale Preparation

**Goal**: Prove value to existing customers, prepare architecture for growth.

- Simple ROI stats on dashboard (response rate before/after, avg response time)
- Onboarding improvements based on first 10 customers' friction points
- Voice learning quality improvements (analyze edit patterns, tune prompts)
- Connection pooling monitoring and tuning
- Outbox archival job (clean up completed entries older than 7 days, processed inbound_events older than 30 days)
- Document runbook for common operational tasks
- **Done when**: All 10 customers have < 5% churn signal (measured by approval engagement rate)

### Future (Week 9+, only if demand warrants)

These are explicitly deferred per the product brief:

- Multi-platform (Yelp, TripAdvisor) — Premium tier upsell (reviews table already has `provider` column)
- Review generation via SMS — Premium tier
- Advanced analytics / intelligence engine — only if customers request it
- Multi-location support — only if enterprise prospects appear
- Database partitioning — trigger: reviews table exceeds 500K rows
- Worker horizontal scaling — trigger: outbox backlog consistently > 100 entries
- Dedicated Postgres (off Supabase) — trigger: connection pool saturation at peak

## 11. Testing Strategy

### Unit Testing (Vitest, target 80% coverage on critical paths)

```
Priority 1 — Business logic:
  - Response generation prompt building
  - Cost calculation and limit enforcement
  - Approval token hashing + validation
  - Adaptive poll interval calculation
  - Outbox entry creation logic

Priority 2 — Data integrity:
  - Review deduplication (by provider_review_name)
  - Inbound event deduplication (by external_event_key)
  - Edit distance calculation
  - Weekly summary aggregation
  - Token revocation on regenerate

Not worth unit testing:
  - API route handlers (covered by integration tests)
  - UI components (covered by Playwright)
```

### Integration Testing (Vitest + test database)

```
Critical flows to test end-to-end:
  1. Pub/Sub notification -> inbound_events -> outbox -> sync -> generation -> notification -> approval -> posting
  2. Reconciliation poll -> outbox -> sync (same downstream as #1)
  3. Outbox replay: simulate Redis failure after Postgres commit, verify outbox poller recovers
  4. Demo generation via ReviewSource interface -> view tracking -> expiration
  5. Stripe webhook -> inbound_events -> subscription status update
  6. Cost limit exceeded -> circuit breaker -> admin alert
  7. LLM primary failure -> fallback to secondary -> success
  8. Token revocation: regenerate revokes old links, new link works
  9. Idempotency: replaying any outbox entry produces same result
```

### E2E Testing (Playwright)

```
User journeys:
  - Owner: click approval link -> approve -> confirmation
  - Owner: click approval link -> edit text -> save -> confirmation
  - Owner: click approval link -> regenerate -> new draft (old link invalid) -> approve new
  - Owner: click expired link -> see expiration message
  - Sales partner: generate demo -> copy link -> demo loads
  - Sales partner: onboard business -> verify in overview with connection status
  - Sales partner: check notification log for a business
```

### Load Testing (before accepting customer #10)

```
Scenarios:
  - 50 concurrent demo page loads
  - 100 Pub/Sub notifications in 1 minute (burst of reviews)
  - 100 approval page loads per minute
  - Outbox poller processing 200 entries in under 30 seconds
  - Verify no outbox entries are lost under concurrent load
```

### Security Testing

```
Attack scenarios:
  - Prompt injection via review text (adversarial reviews)
  - Cost amplification (regenerate spam — verify rate limiting)
  - Token enumeration (hash prevents brute-force lookup)
  - Pub/Sub message forgery (verify message authenticity)
  - XSS via review text rendered in approval page
  - Rate limit bypass attempts
  - Webhook replay attacks (verify idempotency via inbound_events)
```

## 12. Deployment & Operations

### Environment Variables

```env
# Database (Supabase)
DATABASE_URL=               # Direct connection (for migrations only)
DATABASE_POOL_URL=          # Pooled connection (for application use)
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=

# Redis — TWO separate instances
REDIS_CACHE_URL=            # For rate limits, retry cache
REDIS_QUEUE_URL=            # For BullMQ job queue

# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GCP_PROJECT_ID=             # For Pub/Sub
GCP_PUBSUB_TOPIC=           # e.g. "projects/myproject/topics/review-notifications"
GCP_PUBSUB_SUBSCRIPTION=    # e.g. "projects/myproject/subscriptions/review-worker"
GCP_SERVICE_ACCOUNT_KEY=    # JSON key for Pub/Sub authentication

# LLM
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Review data (demo engine only)
SERPAPI_API_KEY=

# Notifications
RESEND_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Payments
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Security (envelope encryption — see Secret Management ADR)
ENCRYPTION_KEY=             # KEK: encrypts per-record DEKs, NOT tokens directly
ENCRYPTION_KEY_VERSION=1    # Increment on rotation; old versions kept until all DEKs re-encrypted

# Monitoring
POSTHOG_API_KEY=
BETTERSTACK_SOURCE_TOKEN=

# App
NEXT_PUBLIC_APP_URL=        # e.g., https://app.yourproduct.com
WORKER_SERVICE_URL=         # Railway worker URL (for Pub/Sub push endpoint)
```

### Deployment Steps

```bash
# 1. Initial setup
git clone <repo-url> && cd ai-review-responder
pnpm install

# 2. Environment
cp .env.example .env.local
# Fill in all values

# 3. Database
pnpm db:migrate    # Run Supabase migrations (all tables including workflow tables)
pnpm db:seed       # Seed admin user + test business (dev only)

# 4. Google Cloud setup
gcloud pubsub topics create review-notifications
gcloud pubsub subscriptions create review-worker \
  --topic=review-notifications \
  --push-endpoint=https://worker.yourapp.com/api/webhooks/google-pubsub

# 5. Deploy web app
vercel --prod

# 6. Deploy worker service
railway up

# 7. Verify
curl https://app.yourproduct.com/api/health
curl https://worker.yourapp.com/api/health
pnpm test:e2e:prod
```

### Operational Runbook

| Scenario | Action |
|---|---|
| Outbox entries stuck in `pending` | Check OutboxPoller logs on Railway. If poller is running, check Redis connection. If Redis is down, entries are safe in Postgres — they'll process when Redis recovers. |
| Outbox entries stuck in `dispatched` | Worker likely crashed. Reset entry status to `pending` via admin query: `UPDATE job_outbox SET status = 'pending' WHERE status = 'dispatched' AND dispatched_at < NOW() - INTERVAL '1 hour'` |
| Pub/Sub notifications not arriving | Check `google_connections.sync_status`. If `token_expired`, trigger token refresh. Verify Pub/Sub subscription is active in GCP console. Reconciliation poller will catch missed reviews. |
| BullMQ queue backing up | Check Railway worker logs. If workers are healthy, scale horizontally (add instance). If unhealthy, check Redis connection. |
| Cost alert fires | Check `/admin/costs`. Identify which business is over-spending. If legitimate (viral review spike), increase limit temporarily. If suspicious, disable notifications for that business. |
| Google API posting fails | Check `google_connections.sync_status`. If token expired, trigger refresh. If API is down, outbox entries retry automatically via BullMQ backoff. |
| Notification not delivered | Check `/admin/notifications` for the business. Look at `notification_deliveries` for failure_reason. Common issues: invalid email, phone number format, Twilio quota. |
| Supabase connection pool exhausted | Check active connections in Supabase dashboard. Reduce worker concurrency or upgrade Supabase tier. |
| LLM quality complaints | Check edit distance trends for that business. If edits are increasing, review their business context and sample responses. Tune prompt or add more voice examples. |

### Observability Note: Correlation IDs

All requests that span Vercel → Railway → Pub/Sub should carry a `x-correlation-id` header (generated at the entry point, propagated through outbox payloads and BullMQ job data). This enables tracing a single review's journey from notification through generation to posting across service boundaries. Not a launch blocker, but add during Week 5-6 hardening — debugging distributed failures without it is painful.

### Scaling Triggers

| Metric | Threshold | Action |
|---|---|---|
| Active businesses | > 50 | Upgrade Supabase to Pro, monitor connection pool |
| Active businesses | > 200 | Evaluate dedicated Postgres, add read replicas |
| Outbox backlog | > 100 consistently | Add Railway worker instance. OutboxPoller uses `FOR UPDATE SKIP LOCKED`, so multiple poller instances are safe to run concurrently. Make batch size configurable via `OUTBOX_BATCH_SIZE` env var (default 50). |
| Reviews table rows | > 500K | Implement yearly partitioning on `detected_at` |
| inbound_events rows | > 1M | Archive processed rows older than 30 days |
| job_outbox rows | > 1M | Archive completed rows older than 7 days |
| api_costs rows | > 1M | Partition by `created_at` monthly, archive >90 days |
| Vercel monthly bill | > $500 | Evaluate self-hosting on Railway or Fly.io |
| Redis memory | > 80% of plan | Upgrade Upstash plan or tune TTLs |
| LLM cost per response | Need to reduce | Fine-tune smaller model on approved response pairs |

---

## Future Improvements (When Scaling Past 10 Businesses)

_These are ideas discussed during Sprint 5 design that were intentionally deferred. They aren't needed for the first 10 customers but become valuable as you scale._

### Retention & Engagement

- **Churn prediction with ML**: Replace the heuristic churn risk score (5-signal weighted model) with a trained model once you have enough churn/retention data (~50+ businesses, 6+ months). The heuristic scoring in `src/lib/shared/churn-score.ts` is designed to be swappable — same input metrics, different scoring function.

- **Historical churn risk snapshots**: Store weekly risk scores per business to track risk trends over time (e.g., "this customer has been trending from healthy → watch over 3 weeks"). Currently scores are computed on-demand and not persisted.

- **Automated re-engagement sequences**: The current system alerts the sales partner when engagement drops, but the sales partner decides what to do. At 50+ businesses, consider automated email sequences (e.g., "We noticed you haven't approved reviews in a while — here's what's waiting") with configurable escalation paths that don't require sales partner intervention for every case.

- **NPS surveys**: At <50 customers, the satisfaction pulse (great/ok/not great) is sufficient. At scale, consider quarterly NPS surveys with benchmarking against industry averages.

### Ranking & Analytics

- **Daily ranking tracking**: Currently biweekly to conserve SerpAPI credits. At higher revenue, increase to weekly or daily for more granular trend data. Requires upgrading SerpAPI plan.

- **Competitor ranking tracking**: Track where competitors rank for the same keywords. Show "You: #4, Top competitor: #2" in the dashboard. Useful data for the sales pitch too.

- **Automated ranking alerts**: Notify the owner or sales partner when ranking drops by 3+ positions. Currently the weekly value report shows the trend, but there's no proactive alert.

- **Sentiment analytics dashboard**: Word clouds, topic clustering, NPS-style sentiment scoring across all reviews. Explicitly excluded from V1 (hard constraint in Product Brief), but becomes valuable when businesses want deeper insights. Could be a Premium tier ($199/mo) feature.

### Operational Scale

- **Multi-worker instances**: OutboxPoller uses `FOR UPDATE SKIP LOCKED`, so multiple instances are safe. At 50+ businesses with high review volume, deploy 2-3 Railway worker instances. Make batch sizes configurable via env vars.

- **Dedicated notification service**: At scale, notification logic (email routing, SMS fallback, delivery tracking, failover) becomes complex enough to justify extraction from the monolithic worker into its own service.

- **Webhook delivery queuing**: If adding more external integrations (Slack notifications, Zapier, customer CRM webhooks), add a generic webhook delivery queue rather than point-to-point integrations.

- **Read replicas**: At 200+ businesses, add Supabase read replicas. Dashboard queries and admin overview queries hit the replica; writes stay on primary.

### Product Expansion

- **Multi-platform reviews**: Yelp, TripAdvisor, Facebook reviews. Each needs its own ReviewSource implementation + data source. The `NormalizedReview` DTO and outbox pattern support this by design — new source, same pipeline.

- **Review solicitation via SMS**: After a customer visit, send an SMS asking them to leave a Google review. Premium tier feature. Requires Twilio integration (already in the stack for SMS notifications).

- **White-label / agency model**: Resell to marketing agencies who manage multiple businesses. Requires: multi-tenant admin, per-agency billing, agency-level reporting. Significant auth/billing rework.

- **Mobile app**: If owners consistently want a richer mobile experience than email + responsive web dashboard, build a React Native app. The API layer already exists. Consider PWA first as a lower-cost alternative.

- **AI-powered review request timing**: Use review velocity data to suggest optimal times for requesting reviews (e.g., "Your reviews spike on Fridays — send solicitation SMS on Friday afternoons").
