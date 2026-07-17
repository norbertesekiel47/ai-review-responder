-- =============================================================================
-- Ticket #484: scheduler set-based outbox dedup indexes + race-safe preflight
-- Migration: 079_scheduler_outbox_dedup_indexes.sql
--
-- WHY: WeeklySummaryScheduler and MonthlyImpactScheduler are being collapsed
-- (Task 2) from a `1 SELECT + N per-row INSERT` loop into ONE set-based
-- `INSERT…SELECT…ON CONFLICT DO NOTHING`. Their JS-side `WHERE NOT EXISTS`
-- in-flight pre-filter cannot close the concurrent-scheduler / worker-restart
-- race (two cycles both pass the NOT EXISTS between snapshot and INSERT → two
-- rows for the same business+period). These partial unique indexes make the
-- dedup guarantee owned by the database, mirroring `uniq_outbox_track_ranking_run`
-- / `uniq_outbox_onboarding_drip` (migration 014). `ON CONFLICT DO NOTHING`
-- absorbs the racing insert instead of surfacing a 23505.
--
-- PREDICATE — in-flight-only, NOT `<> 'failed'` (deliberate divergence from
-- ranking's index): weekly/monthly have a `sent_at` completion guard. The
-- summary worker `markOutboxCompleted`'s a row WITHOUT setting `sent_at` in
-- three legitimate skip cases (archived location, subscription-not-allowed,
-- bounced owner email — `worker/jobs/summary-report-helpers.ts`); the candidate
-- SELECT keys re-enqueue eligibility off `sent_at IS NOT NULL`, NOT off outbox
-- status. A `<> 'failed'` index would wrongly treat such a `completed`-but-not-
-- sent row as a conflict and permanently block the legitimate re-enqueue. So the
-- index predicate `status IN ('pending','dispatching','dispatched')` EXACTLY
-- mirrors the existing in-flight NOT EXISTS — behavior is preserved, a
-- `completed`/`failed` row never blocks. Ranking keeps `<> 'failed'` because it
-- has no `sent_at` guard: its outbox completion IS its done-record. We do NOT
-- touch `uniq_outbox_track_ranking_run`.
--
-- RACE-SAFE PREFLIGHT — before each CREATE UNIQUE INDEX we collapse any
-- pre-existing in-flight duplicate. It must NEVER fail an actively-running row:
-- a preflight that failed a `dispatched` row while keeping an older `pending`
-- duplicate would no-op the running worker's completion
-- (`src/lib/shared/outbox.ts` updates `WHERE status='dispatched'`) and leave the
-- retained `pending` row re-claimable → double-send. So we KEEP the
-- most-advanced-then-oldest row per key (dispatched > dispatching > pending,
-- then created_at) and fail ONLY `pending` extras. The outer UPDATE's
-- `AND status = 'pending'` is a LIVE compare-and-swap: Postgres re-checks the
-- predicate under EvalPlanQual after taking the row lock, so a row the
-- OutboxPoller concurrently claimed (pending → dispatching) between the CTE
-- snapshot and this UPDATE is skipped, never overwritten. `payload->>'…' IS NOT
-- NULL` excludes malformed rows the (NULLs-distinct) index would not treat as
-- conflicts anyway. If two `dispatching`/`dispatched` duplicates for one key
-- somehow coexist (never observed — the single-flight guarded-poll + hourly
-- window makes it near-impossible), the preflight leaves them and the
-- CREATE UNIQUE INDEX fails LOUDLY rather than silently killing an active job —
-- surfaced staging-first for operator investigation.
--
-- topic literals are the raw QUEUE_NAMES.WEEKLY_SUMMARY ('weekly_summary') /
-- QUEUE_NAMES.SEND_MONTHLY_IMPACT ('send_monthly_impact') string values.
--
-- Migration-safety: non-CONCURRENTLY (runs inside this migration tx) — fine at
-- 100-business scale; the brief ACCESS EXCLUSIVE on job_outbox is sub-second.
-- The preflight removes the build-failure path; staging-first apply is the
-- second safety net. Apply staging-first, then production, both Supabase
-- projects in lockstep.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- weekly_summary — collapse pending in-flight dups (race-safe), then unique index
-- -----------------------------------------------------------------------------
WITH ranked AS (
  SELECT id, status,
    ROW_NUMBER() OVER (
      PARTITION BY aggregate_id, payload->>'week_start_date'
      ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'dispatching' THEN 1 ELSE 2 END, created_at
    ) AS rn
  FROM job_outbox
  WHERE topic = 'weekly_summary'
    AND status IN ('pending','dispatching','dispatched')
    AND payload->>'week_start_date' IS NOT NULL
)
UPDATE job_outbox SET status = 'failed', last_error = 'migration 079: collapsed pending duplicate'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  AND status = 'pending';   -- LIVE CAS (re-checked under EvalPlanQual): never overwrite a concurrently-claimed dispatch

CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_weekly_summary_week
  ON job_outbox(aggregate_id, (payload->>'week_start_date'))
  WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched');

-- -----------------------------------------------------------------------------
-- send_monthly_impact — identical shape, keyed on payload->>'month_start_date'
-- -----------------------------------------------------------------------------
WITH ranked AS (
  SELECT id, status,
    ROW_NUMBER() OVER (
      PARTITION BY aggregate_id, payload->>'month_start_date'
      ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'dispatching' THEN 1 ELSE 2 END, created_at
    ) AS rn
  FROM job_outbox
  WHERE topic = 'send_monthly_impact'
    AND status IN ('pending','dispatching','dispatched')
    AND payload->>'month_start_date' IS NOT NULL
)
UPDATE job_outbox SET status = 'failed', last_error = 'migration 079: collapsed pending duplicate'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  AND status = 'pending';   -- LIVE CAS (re-checked under EvalPlanQual): never overwrite a concurrently-claimed dispatch

CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_monthly_impact_month
  ON job_outbox(aggregate_id, (payload->>'month_start_date'))
  WHERE topic = 'send_monthly_impact' AND status IN ('pending','dispatching','dispatched');

COMMIT;
