# Standards & Maintainability Review — `perf-scheduler-set-based-outbox-inserts` (ticket #484)

Reviewer role: STANDARDS & MAINTAINABILITY (read-only). Review basis: `git diff main...HEAD`.
Strict lens applied: `thermo-nuclear-code-quality-review` skill + RepWorth `.claude/CLAUDE.md`
invariants + `.claude/rules/{repworth,engineering,production,design}.md`.

## Verdict

**APPROVE (with two LOW-severity cleanups).** No blockers. The change is a net
complexity *reduction*, not a rearrangement: each of the three schedulers drops a
`1 SELECT + N per-row INSERT` loop (with a per-row `try/catch` 23505 swallow and a
manual `queued` counter) in favor of one set-based `INSERT…SELECT…ON CONFLICT DO
NOTHING`, with the concurrency-dedup guarantee pushed *down* into the database
(partial unique indexes, migration 079). Fewer moving parts, fewer branches, a
smaller surface for the reader. This is the direction the thermo-nuclear lens
wants: delete complexity rather than shuffle it.

All three files stay ~105–127 lines (no 1k-line concern). No new top-level
directory, no new runtime dependency, no `any` added to production code, enums/
`QUEUE_NAMES` used throughout (no bare string literals for topics/status),
structured logging preserved.

---

## What was verified as CORRECT (not findings — recorded so the next reviewer need not re-derive)

1. **`gen_random_uuid()` (UUIDv4) for `job_outbox.id` + `correlation_id` is safe.**
   The RepWorth-wide "all tables use UUIDv7 time-ordered PK" note has a documented,
   scoped exception here. Verified independently:
   - `supabase/migrations/002_prompt2_fixes.sql:38` — `ALTER TABLE job_outbox
     ALTER COLUMN id DROP DEFAULT;` — the column has no ordering contract at the
     schema level and the INSERT supplies `id` explicitly.
   - `worker/background/pollers/OutboxPoller.ts:195` — claim query is `ORDER BY
     available_at … FOR UPDATE SKIP LOCKED`; it never orders by `id`. Switching
     `id` from time-ordered v7 to random v4 changes no dispatch behavior.
   - `correlation_id` is an opaque trace string; rows are 7-day pruned.
   The deviation is documented in `.claude/reference/migrations-log.md` (079 entry).

2. **Ranking index-predicate comment is now CORRECT.** `main`'s
   `RankingTrackingScheduler.ts` carried a stale comment claiming
   `uniq_outbox_track_ranking_run` was `status NOT IN ('completed','failed')`. The
   real predicate (`supabase/migrations/014_retention_expansion.sql:177-180`) is
   `status <> 'failed'`. The new branch's comments (scheduler + migration 079)
   describe it correctly. Stale comment fixed — an improvement.

3. **Migration 079 divergence is intentional and sound.** The weekly/monthly
   partial indexes use `status IN ('pending','dispatching','dispatched')`
   (in-flight-only), deliberately NOT `<> 'failed'`, because the summary worker
   `markOutboxCompleted`'s a row *without* `sent_at` in three legitimate skip cases
   (archived / subscription-not-allowed / bounced email), and re-enqueue
   eligibility keys off `sent_at IS NOT NULL`. A `<> 'failed'` index would wrongly
   pin a `completed`-but-not-sent row as a permanent conflict. The predicate
   exactly mirrors the pre-existing JS `NOT EXISTS`, so behavior is preserved.

4. **Preflight race-safety reasoning holds.** The `WITH ranked … UPDATE …
   AND status = 'pending'` is a live compare-and-swap (Postgres re-checks the
   predicate under EvalPlanQual after taking the row lock), so a row the
   OutboxPoller concurrently claimed (`pending → dispatching`) between the CTE
   snapshot and the UPDATE is skipped, never overwritten. Keeps
   most-advanced-then-oldest; fails only `pending` extras. If two non-`pending`
   in-flight dups somehow coexist, `CREATE UNIQUE INDEX` fails LOUDLY (whole
   migration tx rolls back) rather than silently killing an active job — good
   production failure semantics (production.md: fail visibly, bounded blast radius).

5. **Migration safety.** Non-CONCURRENTLY inside `BEGIN/COMMIT` is acceptable here:
   brief sub-second ACCESS EXCLUSIVE on `job_outbox` at 100-business scale, the
   preflight removes the build-failure path, staging-first apply is the second net.
   `CREATE UNIQUE INDEX IF NOT EXISTS` + one-shot migration semantics make re-run
   effectively idempotent (with the index present, no 2-in-flight state can exist,
   so the preflight no-ops).

6. **Allowlist updates are correct and complete.**
   `scripts/ci/static-policy-audit.ts` line-number bumps track the moved
   `subscription_status` literals (Monthly 47→60, Ranking 61→82, Weekly 59→71).
   `scripts/ci/tenant-scope-allowlist.ts` verbatim SQL strings updated to the new
   INSERT…SELECT text (these queries are intentionally account-global scheduler
   scans — correctly allowlisted). The cross-account scan is inherent to a
   scheduler and was already allowlisted pre-PR.

7. **Integration tests assert real behavior, correctly isolated.**
   - `migration-079-outbox-dedup.integration.test.ts` isolates the preflight
     against a session-local `CREATE TEMP TABLE … (LIKE public.job_outbox INCLUDING
     DEFAULTS)` with `ON COMMIT DROP` (copies NO indexes, so dups seed freely;
     `pg_temp` shadows `public` so unqualified `job_outbox` resolves to the copy).
     This is the fix for the codex adversarial finding (seeding dups into the real,
     already-indexed table would 23505 before the preflight could run). Each
     scenario asserts real status transitions AND rebuilds the real 079 index to
     prove a conflict-free residual state. Index-semantics scenarios run against the
     real table under a private `aggregate_id` namespace with scoped `afterEach`
     cleanup — no global-count assertions, safe on a shared DB.
   - `RankingTrackingScheduler.integration.test.ts` drives the real exported
     `runRankingCheck()`, asserts payload key/value types, distinct
     `correlation_id` per row, and within-period idempotency. Meaningful, not
     tautological.

---

## Findings (≥80% confidence)

### LOW-1 — Dead `uuid`/`jsonb` mocks left behind in the two unit test files
`worker/background/schedulers/__tests__/RankingTrackingScheduler.test.ts:21`
`worker/background/schedulers/__tests__/summary-report-schedulers.test.ts:14` (and the `jsonb: (v)=>v` arm at `:13`/`:20`)

Both files still declare `vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }))`
and mock `jsonb` on the `db/server` mock. After the collapse, none of the three
schedulers import `uuid` or `jsonb` — id + correlation_id are produced by SQL
`gen_random_uuid()`, and the payload is built by `jsonb_build_object` in-statement.
These mocks are now inert leftovers from the pre-collapse per-row path. They no
longer influence any assertion. Per the thermo-nuclear lens (dead code /
leftover-after-refactor) and `.claude/rules/repworth.md` "leave touched areas
better," delete both stale mock declarations. Cost: trivial; risk: none.

### LOW-2 — Producer payload shape decoupled from the typed consumer contract
`worker/background/schedulers/WeeklySummaryScheduler.ts:63-67`
`worker/background/schedulers/MonthlyImpactScheduler.ts:52-56`
`worker/background/schedulers/RankingTrackingScheduler.ts:73-78`

`main` built each payload as a typed object (`const payload: WeeklySummaryPayload =
{…}`), giving a compile-time link from the *producer* (scheduler) to the *consumer*
(`worker/jobs/*Worker.ts`, typed via `WeeklySummaryPayload` /
`SendMonthlyImpactPayload` / `TrackRankingPayload` in
`src/lib/shared/worker-types.ts`). The set-based rewrite builds the payload as
inline `jsonb_build_object('business_id', …, 'week_start_date', …, …)` SQL string
literals. The produced shape is now checked only at runtime (by the integration
tests), no longer by `tsc`: a future rename/typo of a payload key in the SQL —
e.g. `week_start_date` → `week_start` — would compile clean and only surface as a
consumer-side runtime failure. This is the type-boundary erosion the thermo-nuclear
lens (rule 5) and `design.md` warn about.

This is an inherent tradeoff of collapsing to set-based SQL (you cannot run the JS
generator per row), so it is not a blocker and the integration tests do guard the
key names. Recorded as LOW so the ownership is explicit. If a cheap mitigation is
wanted, a single Vitest assertion that pins the exact `jsonb_build_object` key set
against `keyof WeeklySummaryPayload` (or a shared key-name constant referenced by
both the SQL builder and the worker) would restore a static link. Optional.

---

## Low-confidence appendix (NOT in the findings table — judgment calls, deliberate tradeoffs)

- **Preflight SQL duplicated verbatim into the integration test** (`migration-079…
  test.ts:128-170`, the `runWeeklyPreflight` / `runMonthlyPreflight` helpers).
  This is real knowledge duplication (`engineering.md`: one authoritative owner per
  fact) — the migration's UPDATE is copied byte-for-byte into the test. **Verdict:
  acceptable.** The test explicitly labels each copy `-- SOURCE OF TRUTH:
  supabase/migrations/079_…`, migrations are immutable one-shot files that cannot
  be cleanly imported/parametrized into a Vitest run, and the alternative
  (extracting the preflight to a shared `.sql` fragment executed by both the
  migration and the test) would add machinery disproportionate to a one-time
  migration. The duplication is bounded (it can never legitimately change — 079 is
  frozen once applied) and the ownership is documented. Leaving as-is is the right
  call; not worth a finding.

- **WeeklySummaryScheduler and MonthlyImpactScheduler remain two near-identical
  ~105-line files** (same interval-parse, same guarded-poll wiring, same
  INSERT…SELECT shape differing only in topic/date-key/opt-in column). The unit
  test already parametrizes them as one harness (`summary-report-schedulers.test.ts`
  `describe.each`), which highlights the structural twinning. A code-judo move
  exists — a `createSummaryScheduler({topic, dateKey, optInColumn, windowGate})`
  factory would delete one whole file's worth of duplicated wiring. **Verdict: out
  of scope, do not block.** The duplication is *pre-existing* (both files were
  already parallel on `main`) and this PR does not worsen it; extracting the factory
  now risks the speculative-abstraction trap `design.md` / `.claude/rules/repworth.md`
  warn against, and would balloon the diff well beyond ticket #484. Worth a
  fast-follow ticket, not a change request here.

- **`ON CONFLICT DO NOTHING` is target-less** in all three inserts. A PK (`id`)
  collision from `gen_random_uuid()` would be silently absorbed rather than raised.
  Astronomically unlikely, and consistent with the pre-existing ranking insert on
  `main`. Not worth flagging.
