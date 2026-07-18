# Spec & Correctness Review — `perf-scheduler-set-based-outbox-inserts` (#484)

Reviewer: SPEC & CORRECTNESS (read-only). Verdict: **PASS — no findings at ≥80% confidence.**

Scope: `git diff main...HEAD`. Verified field-by-field against `.feature/intake.json`.

---

## 1. Field-by-field intake conformance

### goal
> Collapse the three scheduler per-row outbox insert loops each into one set-based `INSERT…SELECT…ON CONFLICT DO NOTHING`.

**MET.** All three schedulers (`WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts`, `RankingTrackingScheduler.ts`) replaced their `1 SELECT + N per-row INSERT` loop with a single `INSERT INTO job_outbox … SELECT … FROM businesses b JOIN accounts a … ON CONFLICT DO NOTHING`. The per-row `for` loop, the `uuidv7`/`jsonb` imports, the `*Payload` type imports, and the JS-side `23505` catch are all removed. `queued = result.count`.

### user_visible_behavior
- **Same eligible businesses / same payload shape** — MET (see §2 predicate parity and §3 payload parity).
- **Dedup now enforced by partial unique index (079) + ON CONFLICT** — MET. Migration 079 adds `uniq_outbox_weekly_summary_week` and `uniq_outbox_monthly_impact_month`; ranking reuses the existing `uniq_outbox_track_ranking_run` (014).
- **One set-based INSERT per cycle** — MET; asserted by unit tests (`toHaveBeenCalledTimes(1)`).

### non_goals — none violated
- Time-gate / flag / mock-mode / subscription predicates unchanged — CONFIRMED (diff touches only the SELECT/INSERT body; gates above are byte-identical to `main`).
- `OnboardingDripScheduler` / `AutonomyGovernorScheduler` untouched — CONFIRMED (not in diff).
- Consuming workers untouched — CONFIRMED (not in diff).
- No `sql.begin()` / multi-statement tx introduced — CONFIRMED (single INSERT per scheduler).
- Ranking `candidates_checked` log field removed — CONFIRMED and intentional (`logger.log('Queued track_ranking outbox entries', { queued })`; unit test asserts `not.toContain('candidates_checked')`).

### invariants
- **Outbox #2 (single atomic write)** — MET; the one INSERT is the only state write.
- **Idempotency (in-flight NOT EXISTS pre-filter + partial unique index + ON CONFLICT DO NOTHING)** — MET on all three.
- **Tenant scoping (background-global-scan allowlisted)** — MET; `pnpm ci:tenant-scope` passes (393/393). The three `*_CANDIDATES_SQL` constants in `tenant-scope-allowlist.ts` were rewritten in place to the merged statement text.
- **Payload byte-compatibility** — MET (see §3).
- **In-flight index predicate = `status IN ('pending','dispatching','dispatched')`, NOT `<> 'failed'`** — CONFIRMED in migration 079 for weekly/monthly; ranking correctly keeps its `<> 'failed'` (014) index untouched.

### edge_cases
- **gen_random_uuid() deviation** — present, with code comment on all three schedulers + a "Deliberate deviation" lab note in `migrations-log.md` §079. Load-bearing claims independently verified: migration `002_prompt2_fixes.sql:38` DROPs `job_outbox.id` default; `OutboxPoller.ts:195` orders by `available_at`, never `id`.
- **Completed-but-not-sent stays re-enqueueable** — MET; in-flight-only index predicate + the `sent_at IS NOT NULL` completion NOT EXISTS. Proven by integration test `permits a fresh in-flight row once the prior is completed or failed`.
- **Race-safe preflight (most-advanced kept, only pending failed via live CAS, NULL excluded)** — MET (see §4).
- **NULL period excluded** — MET (`payload->>'…' IS NOT NULL` in preflight; integration test `leaves NULL-week rows untouched`).
- **Empty candidate set = 0 rows, no error** — MET; `queued = result.count` → 0, log skipped.
- **Ranking micro-guard removed / runDate computed unconditionally** — CONFIRMED.

### allowed_edit_surface
Every code/docs file changed is within surface: the 3 schedulers, `__tests__/**` (4 files), `079_*.sql`, `tenant-scope-allowlist.ts`, `static-policy-audit.ts`, `migrations-log.md`. The only out-of-surface paths are `.feature/**` orchestration artifacts (intake.json, sessions, deviations/handoff/plan `.md`) — these are `/feature` harness bookkeeping, not production/code, and are expected. No code drift.

### tests_to_add — all present and meaningful
| Promised | Present |
|---|---|
| Parity: set-based INSERT enqueues exactly eligible businesses | `RankingTrackingScheduler.integration.test.ts` (one row/eligible business) |
| In-flight dedup not re-enqueued | integration `is idempotent within a period` + index-semantics `rejects a second in-flight row` |
| ON CONFLICT absorbs dup without 23505 | `migration-079…` `rejects a second in-flight row` (count 0) |
| sent_at / period-marker guard | preserved predicate + `summary-report-schedulers.test.ts` candidate-marker assertions (existing) |
| Payload shape + distinct correlation_ids | integration `enqueues one well-formed … correlation_ids distinct` + unit key assertions |
| queued = inserted.count | `logs queued count reflecting the INSERT row count` |
| Migration preflight + index semantics (blocks in-flight, permits completed/failed) | `migration-079-outbox-dedup.integration.test.ts` (7 scenarios) |

Unit suites green locally: `RankingTrackingScheduler.test.ts` + `summary-report-schedulers.test.ts` → 27 passed. Integration suites gate on `TEST_DATABASE_POOL_URL` (skip cleanly).

---

## 2. SQL correctness — predicate parity (merged SELECT vs original candidate SELECT)

Compared `main` vs `HEAD` for each scheduler. The merged `INSERT…SELECT` WHERE clause = union of (original candidate SELECT predicates) ∪ (original per-row INSERT's in-flight `WHERE NOT EXISTS`). No predicate dropped or added.

- **Weekly**: `subscription_status IN ('active','past_due','trialing')`, `archived_at IS NULL`, `weekly_summary_enabled = TRUE`, `NOT EXISTS weekly_summaries (…, sent_at IS NOT NULL)`, `NOT EXISTS job_outbox in-flight (payload->>'week_start_date' match)` — all identical.
- **Monthly**: same shape, `monthly_impact_enabled`, `monthly_impact_emails`, `month_start_date` — identical.
- **Ranking**: `subscription_status = 'active'`, `place_id_verified`, `google_place_id IS NOT NULL`, `tracked_keywords <> '[]'::jsonb`, lat/lng-or-`ranking_search_location`, `NOT EXISTS job_outbox in-flight (topic+aggregate_id, no run_date match)` — identical (the in-flight NOT EXISTS was already in the original candidate SELECT).

## 3. Payload parity (jsonb_build_object vs `*Payload` TS types)

`worker-types.ts`: `WeeklySummaryPayload{business_id, week_start_date}`, `SendMonthlyImpactPayload{business_id, month_start_date}`, `TrackRankingPayload{business_id, google_place_id, run_date}`, all `extends BasePayload{correlation_id}`.

- Keys emitted by `jsonb_build_object` match exactly (`business_id`, period key, `correlation_id`, + `google_place_id` for ranking).
- Types: `b.id`(uuid)→JSON string; period `${date}::text`→JSON string `'YYYY-MM-DD'`; `google_place_id`(text)→JSON string; `correlation_id` `gen_random_uuid()`→UUID JSON string. Byte-compatible with the prior `jsonb(payload)` output (jsonb normalizes key order, so ordering is a non-issue). Only value semantics change is v4-vs-v7 for `correlation_id`/`id` — the documented, sanctioned deviation.

## 4. Migration 079 correctness

- **Index names/predicates**: `uniq_outbox_weekly_summary_week` / `uniq_outbox_monthly_impact_month`, both `WHERE topic = … AND status IN ('pending','dispatching','dispatched')` — matches intake exactly. `uniq_outbox_track_ranking_run` NOT touched.
- **Preflight**: `ROW_NUMBER() OVER (PARTITION BY aggregate_id, payload->>'period' ORDER BY CASE status WHEN 'dispatched' THEN 0 WHEN 'dispatching' THEN 1 ELSE 2 END, created_at)` → most-advanced-then-oldest. Outer `UPDATE … WHERE id IN (ranked rn>1) AND status = 'pending'` = live CAS (EvalPlanQual re-checks `status='pending'` under row lock, so a concurrently-claimed dispatch is skipped). `payload->>'…' IS NOT NULL` NULL guard present. Two non-pending in-flight dups → `CREATE UNIQUE INDEX` fails loudly (documented, staging-first). Design matches the intake edge-case narrative and the `migrations-log.md` §079 note verbatim.
- **Transactional, non-CONCURRENTLY** — acceptable at 100-business scale (sub-second ACCESS EXCLUSIVE); acknowledged in the migration header.
- `migrations-log.md` head bumped 078→079, next 080. Entry + deviation note complete.

## 5. CI / audits

- `pnpm ci:tenant-scope` → passed, 393 entries (baseline 393).
- `pnpm ci:static-policy` → passed; subscription-status carve-out line numbers updated to the new SELECT lines (Weekly:71, Monthly:60, Ranking:82 — all verified to sit on the `subscription_status` line).
- Scheduler unit tests → 27 passed.

---

## Appendix — low-confidence / informational (below 80%)

- **A1 (low, ~30%) — knowledge duplication in the preflight integration test.** `migration-079-outbox-dedup.integration.test.ts` re-implements the 079 preflight UPDATE and index-build as verbatim COPIES (flagged `-- SOURCE OF TRUTH: …079….sql`). If the migration SQL is ever edited, the test copy can silently drift and keep passing. Mitigated by the explicit source-of-truth comments; acceptable because the one-time migration statement can't be re-invoked against a pre-index state. Not a defect in this change.
- **A2 (info) — stale comment corrected.** The old ranking code comment claimed the 014 index was `status NOT IN ('completed','failed')`; the actual `014_retention_expansion.sql:180` predicate is `status <> 'failed'`. The new comment states `<> 'failed'` correctly — a fix, not a regression. Runtime behavior identical (a `completed` ranking row for the same `run_date` is still blocked from re-enqueue via the index in both old and new code).
- **A3 (info) — `.feature/**` files outside allowed_edit_surface.** intake.json / sessions / deviations.md / handoff.md / plan.md are `/feature` orchestration metadata, not production code. Expected, benign.
- **A4 (low, documented) — non-CONCURRENTLY index build under concurrent writes.** A new duplicate in-flight row inserted between the preflight UPDATE and the `CREATE UNIQUE INDEX` (same tx) could make the index build fail. This is inherent to non-CONCURRENTLY creation, explicitly accepted as loud-fail + staging-first in the migration header. Not a code defect.
