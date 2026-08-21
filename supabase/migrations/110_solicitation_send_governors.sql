-- 110_solicitation_send_governors.sql
--
-- Solicitation send governors (#898; wayfinder map #617, child of #630).
-- THREE ADDITIVE CHANGES, NO DATA CHANGE.
--
--   (a) Dispatch-gate withhold vocabulary — two members amendment B6 item 6
--       needs. Item 3 (subscriptionGrantsFullAccess) deliberately gets NO
--       member: a lapsed subscription is recoverable inside the send window,
--       so the child gate DEFERS (the row stays 'rendered') and the existing
--       send_window_elapsed cancellation is the terminal answer. Do not widen
--       this CHECK further than the gate can write.
--   (b) solicitation_outreach.bounce_kind — the hard/soft discriminator the
--       reputation circuit breaker reads. #622 §3.2B counts bounce.type =
--       'Permanent' only, but the Solicitation lane stamps bounced_at for soft
--       bounces too, so bounced_at alone cannot serve.
--   (c) solicitation_send_breaker — the platform-wide latch. Deny-all RLS.
--
-- NO BACKFILL IS NEEDED, and this is a proof rather than an observation: no
-- send worker exists (#899 builds it), so nothing in any environment has ever
-- written solicitation_outreach.sent_at or received a bounce webhook for one.
--
-- ONE TRANSACTION, load-bearing (109's reasoning verbatim): psql autocommits
-- each statement, so an unwrapped DROP that succeeds followed by an ADD that
-- fails would leave solicitation_outreach with NO status/reason constraint at
-- all. lock_timeout bounds the ACCESS EXCLUSIVE acquisition so a long
-- Supavisor session cannot make this migration queue behind it.
--
-- Specs: docs/superpowers/specs/2026-07-28-sender-deliverability-design.md
--        §3.2A/§3.2B/§4; …-send-mode-cross-spec-amendments.md B3/B6.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── (a) Dispatch-time withhold vocabulary ───────────────────────────────────
-- Strict superset of 109's text. Every other arm is reproduced byte-for-byte;
-- the IS TRUE wrapper is 091's NULL-safety idiom and must not be dropped.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed',
        'no_postal_address', 'postal_address_mismatch'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'owner_withdrawn',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 110 added no_postal_address and postal_address_mismatch to the withheld arm for the Dispatch gate (#898, amendment B6 item 6); item 3 (subscriptionGrantsFullAccess) deliberately has NO member because a lapsed subscription defers and send_window_elapsed terminalizes. 109 added owner_withdrawn; 108 added owner_excluded; every other arm is 091 verbatim.';

-- ── (b) bounce_kind ─────────────────────────────────────────────────────────
ALTER TABLE solicitation_outreach
  ADD COLUMN IF NOT EXISTS bounce_kind TEXT;

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_bounce_kind_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_bounce_kind_check
  CHECK ((bounce_kind IS NULL OR bounce_kind IN ('hard', 'soft')) IS TRUE);

-- A kind without a bounce is incoherent, and would let the breaker's numerator
-- count a row its denominator never saw.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_bounce_kind_pairing;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_bounce_kind_pairing
  CHECK ((bounce_kind IS NULL OR bounced_at IS NOT NULL) IS TRUE);

COMMENT ON COLUMN solicitation_outreach.bounce_kind IS
  'hard | soft; NULL until a bounce lands. Written by the Solicitation lane beside bounced_at (#898). The reputation circuit breaker counts hard only (#622 §3.2B: bounce.type = Permanent). provider_error cannot serve as the discriminator because recordFailure COALESCEs failed:<reason> into that same column, so an email.failed arriving before email.bounced would mask a real hard bounce — the fail-OPEN direction on a governor specified to fail closed.';

-- Serves the breaker denominator, which is the only unbounded count in the
-- 7-day window. The bounced_at / complained_at numerators are DELIBERATELY
-- unindexed: at the top ramp stage (5,000/day x 7 days) the window holds ~35k
-- rows and the breaker runs once per 5-minute poll cycle, so a bitmap scan is
-- cheaper than two more indexes to maintain on every send. Revisit at stage 5,
-- not before.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_sent_at
  ON solicitation_outreach (sent_at)
  WHERE sent_at IS NOT NULL;

-- ── (c) solicitation_send_breaker ───────────────────────────────────────────
-- APPEND-ONLY. One row per trip; a trip is OPEN while reset_at IS NULL. Chosen
-- over a mutable singleton because a second breach would otherwise overwrite
-- the first, and a breach is exactly the thing someone reviews after the fact.
-- account_audit_log cannot hold this: it is account-scoped, and this event is
-- platform-wide. This table IS the audit record.
CREATE TABLE IF NOT EXISTS solicitation_send_breaker (
  id           UUID PRIMARY KEY,             -- UUIDv7, app-supplied (repo convention, no DB default)
  tripped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trip_reason  TEXT NOT NULL,
  metrics      JSONB NOT NULL,               -- the snapshot that tripped it
  reset_at     TIMESTAMPTZ,
  reset_by     UUID REFERENCES users(id),    -- NO ACTION on delete: the reset CHECK below forbids NULLing it
  reset_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT solicitation_send_breaker_trip_reason_check
    CHECK (trip_reason IN ('hard_bounce_rate', 'complaint_rate')),

  -- A reset is ONE act: timestamp, actor and note together or none. This is
  -- what makes "who cleared this, and why" unanswerable-by-omission impossible.
  CONSTRAINT solicitation_send_breaker_reset_consistency CHECK (
    (
      (reset_at IS NULL AND reset_by IS NULL AND reset_note IS NULL) OR
      (reset_at IS NOT NULL AND reset_by IS NOT NULL
        AND reset_note IS NOT NULL AND length(btrim(reset_note)) > 0)
    ) IS TRUE
  )
);

-- AT MOST ONE OPEN TRIP, enforced in the database rather than in application
-- code — the same idiom as 091's solicitation_outreach_one_live_per_ask. The
-- expression is (reset_at IS NULL) rather than a bare constant so the index
-- expression is unambiguously IMMUTABLE over a real column.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_send_breaker_one_open
  ON solicitation_send_breaker ((reset_at IS NULL))
  WHERE reset_at IS NULL;

COMMENT ON TABLE solicitation_send_breaker IS
  'Platform-wide reputation circuit breaker trips (#898, #622 §3.2B). Append-only; a trip is open while reset_at IS NULL, and at most one may be open. NEVER self-clears — only an explicit admin reset closes one. Platform-scoped: no account_id, therefore not a TENANT_TABLES member. Admin-only (deny-all RLS).';

ALTER TABLE solicitation_send_breaker ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all (096 precedent).

COMMIT;
