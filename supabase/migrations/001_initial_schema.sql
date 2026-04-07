-- =============================================================================
-- AI Review Responder — Initial Database Schema
-- Migration: 001_initial_schema.sql
-- 
-- Sources:
--   04-final-plan.md Section 5 (base schema)
--   Implementation_Phases_SerpAPI_First.md (SerpAPI-mode additions)
--   Final_Implementation_Plan.md (reviewed overrides — authoritative)
--
-- Run this in Supabase SQL Editor or via `npx supabase db push`
-- =============================================================================
--
-- MODIFICATIONS FROM BASE PLAN (04-final-plan.md):
--   1. businesses.subscription_status DEFAULT changed to 'pending_payment' (not 'active')
--      Stripe checkout.session.completed webhook transitions to 'active'.
--      ReconciliationPoller only polls 'active' businesses.
--   2. businesses.last_sync_at added (SerpAPI mode has no google_connections rows)
--   3. Baseline ROI columns added to businesses (initial_review_count, 
--      initial_responded_count, baseline_captured_at)
--   4. responses.status includes 'superseded' and 'awaiting_manual_post'
--      'superseded' is terminal — means the owner regenerated and this draft was replaced
--   5. prospect_demos gets generation lifecycle columns (generation_status, 
--      generation_error, started_at, completed_at) separate from prospect_status
--   6. ranking_snapshots table added (Phase 7 ROI Dashboard)
--   7. approval_audit_log table added (security forensics)
--   8. review_exceptions.type includes 'identity_collision' for SerpAPI dedup edge cases
--   9. job_outbox.topic includes 'generate_demo' for async demo generation
--
-- NOTE ON UUIDs: This schema uses uuidv7() which requires the pg_uuidv7
-- extension. If not available, replace all DEFAULT uuidv7() with
-- DEFAULT gen_random_uuid() and generate UUIDv7 in the application layer
-- via the `uuidv7` npm package.
-- =============================================================================

-- Try to enable UUIDv7 extension
-- pg_uuidv7 not available on Supabase free tier
-- UUIDv7 values will be generated in the application layer via the `uuidv7` npm package
-- All tables use gen_random_uuid() as a database-level fallback

-- =============================================================================
-- USERS TABLE (created first — businesses.onboarded_by references users)
-- =============================================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL DEFAULT 'owner', -- 'owner', 'sales_partner', 'admin'
  business_id UUID, -- FK added after businesses table exists

  -- Authentication via Supabase Auth
  auth_id VARCHAR(255) UNIQUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- CORE TABLES
-- =============================================================================

-- Businesses table (business profile + settings, NOT Google integration state)
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  google_place_id VARCHAR(255), -- kept for display/lookup + SerpAPI polling, NOT the GBP integration key

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
  -- IMPORTANT: starts as 'pending_payment', NOT 'active'
  -- Stripe checkout.session.completed webhook transitions to 'active'
  -- ReconciliationPoller ONLY polls 'active' businesses
  -- NotificationWorker and ResponsePublisherWorker MUST skip 'pending_payment'
  subscription_tier VARCHAR(20) DEFAULT 'standard', -- 'founding', 'standard', 'premium'
  subscription_status VARCHAR(20) DEFAULT 'pending_payment', -- 'pending_payment', 'active', 'past_due', 'cancelled'
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),

  -- SerpAPI polling state (used instead of google_connections in SerpAPI mode)
  -- When GBP API arrives, this column is still used as a fallback sync tracker
  last_sync_at TIMESTAMPTZ,

  -- ROI baseline (captured during first sync, NOT during onboarding)
  -- Powers the "before us vs after us" ROI dashboard in Sprint 5
  initial_review_count INTEGER,      -- total reviews at time of first sync
  initial_responded_count INTEGER,   -- reviews with owner replies at time of first sync
  baseline_captured_at TIMESTAMPTZ,  -- when the baseline was recorded

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  onboarded_by UUID REFERENCES users(id)
);

-- Now add the FK from users to businesses
ALTER TABLE users ADD CONSTRAINT fk_users_business
  FOREIGN KEY (business_id) REFERENCES businesses(id);

-- Google connection state (separated from business profile)
-- This table remains EMPTY until GBP API access is approved.
-- The schema is ready for Phase 5 (GBP API Integration).
CREATE TABLE google_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,

  -- Canonical Google identifiers (resource names from the GBP API)
  -- google_location_name is the PRIMARY integration key for all GBP API calls
  google_account_id TEXT NOT NULL,
  google_location_name TEXT NOT NULL UNIQUE, -- e.g. "accounts/123/locations/456"

  -- OAuth tokens (envelope encryption: tokens encrypted with DEK, DEK encrypted with KEK)
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
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
-- provider values:
--   'serpapi_poll' — reviews ingested via SerpAPI polling (current mode)
--   'google'      — reviews ingested via GBP API (Phase 5)
-- provider_review_id identity strategy (SerpAPI mode, per Final_Implementation_Plan.md):
--   PREFERRED: source-provided review ID or review permalink from SerpAPI response
--   FALLBACK:  SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl)
--   LAST RESORT: SHA-256(reviewerName + "|" + reviewDate) — log warning for collision-prone names
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Provider-canonical identifiers
  provider TEXT NOT NULL DEFAULT 'google',
  provider_review_id TEXT NOT NULL,
  provider_review_name TEXT NOT NULL,   -- e.g. "serpapi://{placeId}/reviews/{hash}" or "accounts/123/locations/456/reviews/789"
  provider_location_name TEXT NOT NULL, -- e.g. "serpapi://{placeId}" or "accounts/123/locations/456"

  -- Review content
  reviewer_name VARCHAR(255),
  star_rating INTEGER CHECK (star_rating >= 1 AND star_rating <= 5),
  review_text TEXT,
  review_date TIMESTAMPTZ,
  detected_language VARCHAR(10),
  -- SHA-256 of (star_rating + "|" + review_text) — used for EDIT DETECTION, not identity
  -- Identity is provider_review_id; content hash detects when a reviewer changes their review
  review_content_hash TEXT,

  -- Processing status
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'new',
  -- Valid values: 'new', 'generating', 'pending_approval', 'approved',
  --              'awaiting_manual_post', 'posted', 'failed'

  CONSTRAINT unique_provider_review UNIQUE (provider, provider_review_name)
);

CREATE INDEX idx_reviews_business_status ON reviews(business_id, status);
CREATE INDEX idx_reviews_detected_at ON reviews(detected_at);

-- Responses table (approval tokens live in approval_links, not here)
CREATE TABLE responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Response content
  response_text TEXT NOT NULL,
  response_language VARCHAR(10),
  version INTEGER DEFAULT 1,

  -- Approval workflow (NO auto-post path exists — by design)
  -- Valid values:
  --   'pending_approval'     — draft generated, awaiting owner action
  --   'approved'             — owner approved without edits
  --   'edited'               — owner approved with edits
  --   'superseded'           — owner regenerated; replaced by newer version (TERMINAL)
  --   'awaiting_manual_post' — owner approved, queued for manual posting (SerpAPI mode)
  --   'posted'               — response published to Google
  --   'failed'               — generation failed, posting failed, or review updated by reviewer
  -- INVARIANT: at most one non-terminal response per review at a time.
  --   Terminal statuses: 'superseded', 'failed'
  --   When owner regenerates, old response MUST be set to 'superseded' in same transaction.
  status VARCHAR(20) DEFAULT 'pending_approval',
  approved_at TIMESTAMPTZ,
  approved_text TEXT, -- the final text that was approved (original or edited)

  -- Edit tracking for voice learning
  original_draft_text TEXT NOT NULL,
  edited_text TEXT,       -- NULL if approved without edits
  edit_distance INTEGER,  -- Levenshtein distance, measures AI quality over time

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

-- Idempotency boundary: (review_id, version) must be unique.
ALTER TABLE responses ADD CONSTRAINT unique_review_version UNIQUE (review_id, version);

CREATE INDEX idx_responses_status ON responses(status);
CREATE INDEX idx_responses_business_posted ON responses(business_id, posted_at);
-- Voice learning index: find recent edited+posted responses for few-shot examples
CREATE INDEX idx_responses_voice ON responses(business_id, posted_at DESC)
  WHERE status = 'posted' AND edited_text IS NOT NULL;

-- Approval links (separate from responses for clean lifecycle management)
CREATE TABLE approval_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Token stored as hash only — raw token NEVER persists in the database
  -- Generated in NotificationWorker using node:crypto randomUUID()
  -- Hashed with createHash('sha256').update(rawToken).digest('hex')
  token_hash TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,            -- 'email' or 'sms'

  -- Lifecycle (48h TTL — shorter window reduces exposure)
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
  consumed_at TIMESTAMPTZ,          -- set when owner takes any action
  revoked_at TIMESTAMPTZ,           -- set on regenerate (all sibling links revoked)
  -- Device binding: set on POST /api/approval/session
  -- Device cookie is HMAC-signed with SESSION_COOKIE_SECRET
  -- device_cookie_hash = SHA-256(cookie_value)
  device_cookie_hash TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_al_token ON approval_links(token_hash)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_al_response ON approval_links(response_id);

-- =============================================================================
-- WORKFLOW TABLES
-- =============================================================================

-- Inbound events (deduplication + durability for external webhooks)
-- All webhooks (Stripe, Resend, future Twilio/Pub/Sub) terminate on Railway directly.
-- Each writes here FIRST, deduplicated by external_event_key, BEFORE processing.
CREATE TABLE inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                    -- 'stripe', 'resend', 'google_pubsub', 'twilio'
  external_event_key TEXT NOT NULL UNIQUE, -- idempotency key from the external system
  event_type TEXT NOT NULL,                -- 'subscription_updated', 'email_delivered', 'review_changed', etc.
  aggregate_key TEXT,                      -- routing key: stripe_customer_id, google_location_name, etc.

  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received', -- 'received', 'processing', 'processed', 'failed'
  error_message TEXT
);

CREATE INDEX idx_ie_status ON inbound_events(status) WHERE status != 'processed';
CREATE INDEX idx_ie_source ON inbound_events(source, received_at);

-- Job outbox (transactional outbox pattern)
--
-- Status lifecycle:
--   pending    -> Created in transaction. Awaiting OutboxPoller pickup.
--   dispatched -> Poller sent to BullMQ. Worker is processing.
--   completed  -> Worker confirmed success. Safe to archive after 7 days.
--   failed     -> Exceeded max_attempts. Terminal. Requires manual investigation.
CREATE TABLE job_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,          -- 'generate_response', 'send_notification', 'publish_response',
                                -- 'sync_reviews', 'generate_demo', 'notify_admin_review_exception'
  aggregate_type TEXT NOT NULL, -- 'review', 'response', 'business', 'demo'
  aggregate_id UUID,

  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'dispatched', 'completed', 'failed'
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jo_pending ON job_outbox(available_at) WHERE status = 'pending';
CREATE INDEX idx_jo_topic ON job_outbox(topic, status);

-- =============================================================================
-- OPERATIONAL TABLES
-- =============================================================================

-- Notification deliveries (track every email/SMS sent)
CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  response_id UUID REFERENCES responses(id),

  channel TEXT NOT NULL,       -- 'email' or 'sms'
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,      -- 'approval_request', 'weekly_summary', 'admin_manual_post', 'admin_exception'

  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,    -- from Resend delivery webhook
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  external_message_id TEXT,    -- Resend message ID or Twilio SID

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_nd_business ON notification_deliveries(business_id, created_at);
CREATE INDEX idx_nd_response ON notification_deliveries(response_id);

-- Prospect demos (sales outreach — separate from production data)
-- Generation runs ASYNC via outbox + DemoGenerationWorker on Railway.
-- API route creates row + outbox entry in one transaction, returns immediately.
CREATE TABLE prospect_demos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name VARCHAR(255) NOT NULL,
  google_place_id VARCHAR(255),
  demo_url_slug VARCHAR(20) UNIQUE NOT NULL,
  review_source TEXT NOT NULL DEFAULT 'serpapi', -- 'serpapi', 'manual', 'csv'

  -- Demo data (snapshot — NULL until generation_status = 'completed')
  reviews_snapshot JSONB,
  generated_responses JSONB,

  -- Generation lifecycle (async via DemoGenerationWorker)
  -- SEPARATE from prospect_status (sales lifecycle)
  generation_status VARCHAR(20) NOT NULL DEFAULT 'queued', -- 'queued', 'running', 'completed', 'failed'
  generation_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Sales lifecycle
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
CREATE INDEX idx_demos_generation ON prospect_demos(generation_status)
  WHERE generation_status IN ('queued', 'running');

-- Weekly summaries
CREATE TABLE weekly_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,

  total_reviews INTEGER NOT NULL DEFAULT 0,
  total_responded INTEGER NOT NULL DEFAULT 0,
  notable_reviews JSONB,
  summary_text TEXT,         -- AI-generated intelligence brief (Sprint 5)

  generated_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,

  CONSTRAINT unique_business_week UNIQUE (business_id, week_start_date)
);

-- API cost tracking (Redis = real-time budget, this = audit trail)
CREATE TABLE api_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id),

  provider VARCHAR(20) NOT NULL, -- 'openai', 'anthropic', 'serpapi', 'resend'
  endpoint VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd DECIMAL(10,6) NOT NULL,

  response_id UUID REFERENCES responses(id),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_costs_business_date ON api_costs(business_id, created_at);
CREATE INDEX idx_costs_daily ON api_costs(created_at, provider);

-- Review exceptions (durable workflow for admin-attention cases)
CREATE TABLE review_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  response_id UUID REFERENCES responses(id) ON DELETE SET NULL,

  type TEXT NOT NULL,        -- 'review_edited_after_post', 'identity_collision'
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'resolved', 'dismissed'
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Only one open exception per review+type
CREATE UNIQUE INDEX idx_review_exceptions_open
  ON review_exceptions(review_id, type)
  WHERE status = 'open';

-- Ranking snapshots (manual Google Maps rank tracking — Sprint 5)
CREATE TABLE ranking_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  keyword VARCHAR(255) NOT NULL,
  rank_position INTEGER,
  search_location VARCHAR(255),
  snapshot_date DATE NOT NULL,
  source VARCHAR(20) DEFAULT 'manual', -- 'manual', 'serpapi', 'api'

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rankings_business ON ranking_snapshots(business_id, snapshot_date DESC);

-- Approval audit log (security — tracks every approval action)
-- Written in the SAME transaction as the approval action.
CREATE TABLE approval_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  approval_link_id UUID REFERENCES approval_links(id),

  action TEXT NOT NULL,           -- 'session_established', 'approved', 'edited', 'regenerated'
  device_cookie_hash TEXT,
  ip_address TEXT,
  user_agent TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_response ON approval_audit_log(response_id);
CREATE INDEX idx_audit_business ON approval_audit_log(business_id, created_at);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_audit_log ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- SEED DATA (uncomment and customize)
-- =============================================================================
--
-- INSERT INTO users (name, email, role)
-- VALUES ('Norbert', 'norbert@yourdomain.com', 'admin');
--
-- INSERT INTO users (name, email, role)
-- VALUES ('SalesPartner', 'partner@yourdomain.com', 'sales_partner');
