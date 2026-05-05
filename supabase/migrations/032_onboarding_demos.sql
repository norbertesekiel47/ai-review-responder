CREATE TABLE onboarding_demos (
  id                   UUID PRIMARY KEY,
  user_id              UUID NOT NULL
                         REFERENCES users(id) ON DELETE CASCADE,
  business_id          UUID NOT NULL
                         REFERENCES businesses(id) ON DELETE CASCADE,

  business_name        TEXT NOT NULL,
  category             TEXT,
  google_place_id      TEXT,
  google_maps_url      TEXT,

  generation_status    TEXT NOT NULL,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  generation_error     TEXT,

  reviews_snapshot     JSONB,
  generated_responses  JSONB,
  source               TEXT,

  correlation_id       UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT onboarding_demos_status_check
    CHECK (generation_status IN ('queued','running','completed','failed','archived')),
  CONSTRAINT onboarding_demos_source_when_completed
    CHECK (generation_status <> 'completed' OR source IS NOT NULL)
);

CREATE UNIQUE INDEX onboarding_demos_one_completed_per_user
  ON onboarding_demos (user_id)
  WHERE generation_status = 'completed';

CREATE INDEX onboarding_demos_user_lookup
  ON onboarding_demos (user_id, created_at DESC);

CREATE INDEX onboarding_demos_business_lookup
  ON onboarding_demos (business_id);

CREATE INDEX onboarding_demos_generation_inflight
  ON onboarding_demos (generation_status)
  WHERE generation_status IN ('queued', 'running');

-- Supports the daily 30-day stale-completed cleanup pass in
-- CleanupAbandonedSignupsPoller. Without this, the poller does a full table
-- scan once per cycle as completed-demo volume grows. Partial index keeps the
-- B-tree small (only completed rows) and the WHERE predicate matches the
-- DELETE byte-for-byte so Postgres uses it.
CREATE INDEX onboarding_demos_completed_for_cleanup
  ON onboarding_demos (completed_at)
  WHERE generation_status = 'completed';
