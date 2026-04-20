-- supabase/migrations/021_channel_enrollments.sql
--
-- channel_enrollments: one row per (business, channel) capturing the owner's
-- notification handle per channel plus its lifecycle (pending_verification ->
-- verified -> disabled -> unsubscribed). Backfills one auto-verified email
-- row per existing business from businesses.owner_email.
--
-- IDs are app-generated UUIDv7 per repo convention (migration 002 dropped
-- DB-side UUID defaults on every other table). No DEFAULT on id. The backfill
-- INSERT below uses gen_random_uuid() one-off — acceptable for a historical
-- data migration since production runtime writes are what must obey the
-- convention; these rows will never be inserted again.
--
-- verification_token is stored as SHA-256 hash. Raw token is returned ONCE
-- to admin UI for QR/deep-link generation, never persisted. Same pattern as
-- approval_links.token_hash.
--
-- See docs/adding-communication-channels.md §2 for the full data-model rationale.

CREATE TABLE IF NOT EXISTS channel_enrollments (
  id                              UUID PRIMARY KEY,
  business_id                     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel                         TEXT NOT NULL,
    -- Accepted values: 'email' | 'sms' | 'telegram' | 'whatsapp'
    -- No CHECK constraint on channel; enforced at app layer (mirrors responses.status convention).
  handle                          TEXT,
    -- Email address, E.164 phone, or telegram chat_id. NULL during
    -- 'pending_verification' for Telegram/WhatsApp (handle only becomes
    -- known when the owner taps the deep link and /start <token> arrives).
    -- CHECK below enforces: handle IS NOT NULL whenever status = 'verified'.
  status                          TEXT NOT NULL DEFAULT 'pending_verification',
    -- Accepted: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed'
  verified_at                     TIMESTAMPTZ,
  disabled_at                     TIMESTAMPTZ,
  unsubscribed_at                 TIMESTAMPTZ,
  unsubscribed_reason             TEXT,
  verification_token_hash         TEXT,
  verification_token_expires_at   TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, channel),
  -- Guardrail: a verified enrollment MUST have a handle (otherwise the
  -- dispatcher has no recipient). pending_verification / disabled /
  -- unsubscribed rows may have NULL handles transiently.
  CHECK (status <> 'verified' OR handle IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_channel_enrollments_business
  ON channel_enrollments(business_id);

CREATE INDEX IF NOT EXISTS idx_channel_enrollments_verify
  ON channel_enrollments(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

-- Backfill: every existing business with an email gets an auto-verified email
-- enrollment. verified_at = created_at treats them as already-verified (no
-- re-verification of live customers). gen_random_uuid() is fine for this
-- one-off historical insert; runtime code uses app-generated UUIDv7.
INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
SELECT gen_random_uuid(), id, 'email', owner_email, 'verified', created_at
FROM businesses
WHERE owner_email IS NOT NULL
ON CONFLICT (business_id, channel) DO NOTHING;

-- Deprecation marker. Legacy column stays for one release cycle so any
-- stray read doesn't crash. Drop in migration 022.
COMMENT ON COLUMN businesses.notification_preference IS
  'DEPRECATED: replaced by channel_enrollments. Do not read from this column; will be dropped in migration 022 once all call sites are migrated.';

-- RLS for owner-scoped reads (future owner dashboard).
ALTER TABLE channel_enrollments ENABLE ROW LEVEL SECURITY;
