-- Migration 050: api_costs AI-safety / audit metadata (Wave 3, PR 2)
--
-- Adds per-call prompt-version/hash, latency, and moderation/flag/output
-- metadata to api_costs. PR 2 populates system_prompt_hash, prompt_version,
-- and latency_ms (plus account_id via the existing nullable column from 039).
-- The moderation columns (moderation_score, moderation_categories, flagged,
-- flag_reason, output_excerpt) are added now but populated by Wave 3 PR 3
-- (output filter + flagged queue), so PR 3 needs no further api_costs migration.
--
-- All additions are nullable or defaulted and additive. api_costs already has
-- RLS (api_costs_owner_select, migration 035) and account/date indexes
-- (idx_api_costs_account, migration 034); no RLS or index change is needed here.

ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS system_prompt_hash TEXT;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS moderation_score NUMERIC;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS moderation_categories JSONB;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS output_excerpt TEXT;

COMMENT ON COLUMN api_costs.system_prompt_hash IS 'SHA-256 of the versioned system prompt safety base (prompt-policy.ts) used for this generation.';
COMMENT ON COLUMN api_costs.prompt_version IS 'Human-readable prompt version (PROMPT_VERSION) used for this generation.';
COMMENT ON COLUMN api_costs.latency_ms IS 'End-to-end provider call latency in milliseconds.';
COMMENT ON COLUMN api_costs.flagged IS 'Whether the generated output was flagged by moderation (populated in Wave 3 PR 3).';
