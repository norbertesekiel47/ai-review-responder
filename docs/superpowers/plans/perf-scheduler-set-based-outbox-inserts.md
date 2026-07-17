# Plan — Ticket #484: collapse scheduler insert loops to set-based INSERT…SELECT…ON CONFLICT

Intake contract: `.feature/intake.json` · Parent map: #472 (audit item 10) · RISK=high · db_touching=true.

## Design orientation (codebase-design)

**Modules touched — all three are DEEPENED, none add a new interface or seam.**
Each scheduler keeps its exact public interface (`start*`/`stop*` + the cycle
function `checkAndSchedule` / exported `runRankingCheck`). We are replacing an
internal `1 SELECT + N per-row INSERT` loop with **one merged set-based
`INSERT…SELECT`**. Complexity is pulled *down* into a single SQL statement:
the candidate predicates, the in-flight dedup pre-filter, the payload
construction (`jsonb_build_object`), and the conflict enforcement all live in
one statement the DB owns. No new module, no widened interface, no new
abstraction. The migration (079) is additive.

**One-owner note:** outbox dedup for these three topics becomes owned by
partial unique indexes on `job_outbox` (mirroring `uniq_outbox_track_ranking_run`
/ `uniq_outbox_onboarding_drip`), replacing the JS-side `WHERE NOT EXISTS`-only
guarantee. The candidate-level `NOT EXISTS` stays as a cheap in-flight
pre-filter (matches RankingTracking's existing structure), not as the
correctness owner.

## Tracer-bullet tasks

### Task 1 — Migration 079 + docs  (blocking edge: none; must land before Task 2)

**File:** `supabase/migrations/079_scheduler_outbox_dedup_indexes.sql`

Mirror migration 015's dedupe-then-index shape. **Predicate is in-flight-only**
(`status IN ('pending','dispatching','dispatched')`), NOT `status <> 'failed'` —
this exactly mirrors the current `WHERE NOT EXISTS` so behavior is preserved.
A `completed`-but-not-sent row must remain able to be re-enqueued: the summary
worker `markOutboxCompleted`'s WITHOUT setting `sent_at` in three skip cases
(archived location, subscription not allowed, bounced owner email —
`worker/jobs/summary-report-helpers.ts`), and the candidate SELECT keys
exclusion off `sent_at IS NOT NULL`; a `<> 'failed'` index would wrongly block
those rows (adversarial-review finding 1). Ranking keeps its EXISTING
`uniq_outbox_track_ranking_run` (`status <> 'failed'`) untouched — it has no
`sent_at` guard, so its outbox completion IS the done-record.

Each index gets a **015-style preflight** collapsing any pre-existing in-flight
duplicate (keep oldest per `(aggregate_id, period)`, mark the rest `'failed'`)
so the build cannot fail on historical rows:

```sql
-- Weekly: collapse in-flight dups, then partial unique index.
UPDATE job_outbox SET status = 'failed', last_error = 'migration 079: collapsed duplicate'
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY aggregate_id, payload->>'week_start_date' ORDER BY created_at ASC
    ) AS rn
    FROM job_outbox
    WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched')
  ) dupes WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_weekly_summary_week
  ON job_outbox(aggregate_id, (payload->>'week_start_date'))
  WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched');
-- send_monthly_impact: identical shape with payload->>'month_start_date'.
```

Comment must state: closes the concurrent-scheduler/restart race the prior
`WHERE NOT EXISTS` could not; the predicate deliberately matches the in-flight
NOT EXISTS (so `completed`-without-sent stays re-enqueueable) and differs from
ranking's `<> 'failed'` for that reason; `topic` literals are the raw
`QUEUE_NAMES.WEEKLY_SUMMARY` / `.SEND_MONTHLY_IMPACT` string values.

**Migration-safety:** non-`CONCURRENTLY` (runs inside the migration tx) — fine
at 100-business scale; brief `ACCESS EXCLUSIVE` on `job_outbox` is sub-second.
The preflight removes the build-failure path; staging-first apply is the second
safety net.

**ON CONFLICT target (adversarial-review finding 5, rejected with reasoning):**
keep target-less `ON CONFLICT DO NOTHING` (matches the existing
`RankingTrackingScheduler` precedent) rather than an explicit
`ON CONFLICT (cols) WHERE …` target — an explicit partial-index target must
match the predicate BYTE-FOR-BYTE (documented CLAUDE.md footgun), while a PK
collision under `gen_random_uuid()` is ~0 probability and DO-NOTHING merely
skips one enqueue that self-heals next cycle.

**Docs:** `.claude/reference/migrations-log.md` — bump head `078 → 079`, add the
079 entry. Add a lab note (this file's log section / lab-notes) recording the
deliberate `gen_random_uuid()` deviation for the set-based path.

### Task 2 — Collapse the three schedulers + allowlist + tests  (blocked by Task 1)

TDD, one scheduler at a time, commit per scheduler. Shared file
`scripts/ci/tenant-scope-allowlist.ts` is edited in this task only (no parallel
agent) to avoid conflicts.

**2a — WeeklySummaryScheduler.ts.** Replace the candidate `SELECT` + per-row
loop with one statement:

```sql
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
SELECT
  gen_random_uuid(),
  ${QUEUE_NAMES.WEEKLY_SUMMARY},
  'business',
  b.id,
  jsonb_build_object(
    'business_id', b.id,
    'week_start_date', ${weekStartDate}::text,
    'correlation_id', gen_random_uuid()
  ),
  'pending'
FROM businesses b
JOIN accounts a ON a.id = b.account_id
WHERE a.subscription_status IN ('active', 'past_due', 'trialing')
  AND b.archived_at IS NULL
  AND a.weekly_summary_enabled = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM weekly_summaries ws
    WHERE ws.business_id = b.id
      AND ws.week_start_date = ${weekStartDate}::date
      AND ws.sent_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM job_outbox jo
    WHERE jo.topic = ${QUEUE_NAMES.WEEKLY_SUMMARY}
      AND jo.aggregate_id = b.id
      AND jo.status IN ('pending', 'dispatching', 'dispatched')
      AND jo.payload->>'week_start_date' = ${weekStartDate}
  )
ON CONFLICT DO NOTHING
```

`queued = result.count`; keep the `if (queued > 0) logger.log(...)`. Remove the
per-row loop, the per-row `try/catch`/`23505` handling, and the now-unused
imports (`v7 as uuidv7`, `jsonb`, `WeeklySummaryPayload`). Keep the outer
`try/catch`, the time gate, `getPreviousMonday`, and the `fallow-ignore`
complexity comment if still warranted (it likely is not — re-evaluate).

**2b — MonthlyImpactScheduler.ts.** Same transformation; `month_start_date` /
`monthly_impact_emails` / `${QUEUE_NAMES.SEND_MONTHLY_IMPACT}` /
`a.monthly_impact_enabled`.

**2c — RankingTrackingScheduler.ts.** Merge the existing candidate `SELECT`
(id, google_place_id) into one `INSERT…SELECT` with `jsonb_build_object(
'business_id', b.id, 'google_place_id', b.google_place_id, 'run_date',
${runDate}::text, 'correlation_id', gen_random_uuid())`, keeping the existing
candidate predicates + in-flight `NOT EXISTS` and `ON CONFLICT DO NOTHING`
(backed by the existing `uniq_outbox_track_ranking_run`). Compute `runDate`
unconditionally; drop the `candidates.length === 0` guard and the
`candidates_checked` log field (log `{ queued }` only). Keep `rankingTrackingEnabled`,
`isMockMode`, time gate, `getIsoWeekNumber`, and the exported surface.

**2d — Allowlist `scripts/ci/tenant-scope-allowlist.ts`.** The audit compares
the FULL normalized tagged-template statement (not just the candidate SELECT —
adversarial-review finding 4). Update each of the three `*_CANDIDATES_SQL`
constants (lines ~96/102/105) to the COMPLETE merged
`INSERT INTO job_outbox … SELECT … FROM businesses … ON CONFLICT DO NOTHING`
text, whitespace-normalized to match the audit's extraction. All 8 scheduler
entries keep their `background-global-scan` category; `job_outbox` is NOT a
tenant table, so no new entries are needed. Run `pnpm ci:tenant-scope`
iteratively until green. **Do NOT** loosen the audit or add entries beyond the
existing 8; if the audit surfaces a genuinely new cross-tenant surface, stop and
surface it to the orchestrator.

**2e — Tests** `worker/background/schedulers/__tests__/`. Split by what each
layer can actually prove (adversarial-review finding 3 — mocked tests must not
masquerade as behavioral coverage):

*Mocked unit tests (statement shape + gating only):*
- `summary-report-schedulers.test.ts`: the archived-exclusion + digest-column
  textual pins survive (merged statement still contains `FROM businesses b` +
  marker + `b.archived_at IS NULL` before `NOT EXISTS`) — verify, adjust the
  `sqlCalls.find` predicate only if needed. Add: single-call assertion
  (`toHaveBeenCalledTimes(1)`), statement contains `INSERT INTO job_outbox`,
  `ON CONFLICT DO NOTHING`, the exact payload KEY NAMES
  (`'business_id'`,`'week_start_date'`/`'month_start_date'`,`'correlation_id'`)
  inside `jsonb_build_object`, TWO distinct `gen_random_uuid()` occurrences (id
  + correlation_id — NOT a shared bound value), dedup `NOT EXISTS`, and `queued`
  reflects `count`.
- `RankingTrackingScheduler.test.ts`: rewrite `creates outbox entries…` (now 1
  merged call, `queued:2`, no `candidates_checked`); replace `handles 23505…`
  with an assertion that the statement carries `ON CONFLICT DO NOTHING` (JS-side
  23505 catch is gone) + payload keys incl. `'google_place_id'`/`'run_date'`.
  Keep all time-gate/flag/mock-mode/lifecycle/getIsoWeek tests unchanged.

*Behavioral integration test (DB-gated — RUNS IN CI: the test job provisions
Postgres 16 + `TEST_DATABASE_POOL_URL`, migrations applied by
`.github/actions/test-db`; self-skips locally without a DB).* This layer owns
the real acceptance criteria the mocks cannot:
- Seed eligible + ineligible businesses; run the merged statement; assert the
  EXACT set of `job_outbox` rows created (parity), each payload's keys AND value
  types (`business_id` = the biz uuid string, date string, `correlation_id` a
  valid UUID), and that `correlation_id` values are DISTINCT across rows.
- Dedup: a second run does not duplicate (in-flight `NOT EXISTS` + unique index);
  a concurrent duplicate insert is absorbed by `ON CONFLICT DO NOTHING` (no
  23505 surfaced).
- Index semantics: a second in-flight row for the same `(aggregate_id, period)`
  is rejected; a fresh row IS allowed once the prior goes `'failed'`; a
  `completed`-but-not-sent row does NOT block re-enqueue (finding-1 regression
  guard).
- sent_at / period-marker guard still excludes already-recorded businesses.
Follow `summary-schedulers-archived.integration.test.ts` for the skip harness;
confirm `.github/actions/test-db` globs `supabase/migrations/*.sql` so 079 is
applied (it does today — verify, don't assume).

## Verify gate (step 5)

`scripts/verify-gate.sh` — `lint`, `typecheck`, `test`, every `ci:*` (incl.
`ci:tenant-scope`, `ci:rls-audit`, `ci:static-policy`, `ci:db-imports`). No UI
surface → no `pnpm build` required by the gate, but it runs the full test suite.

## Ship (step 8, high-risk lane)

Ride `staging` first (apply 079 to staging Supabase FIRST, then push branch →
staging full-stack redeploy), smoke the scheduler path if a runbook applies,
then PR to `main`, CI green, pause for merge approval, apply 079 to prod
Supabase in lockstep at promotion.
