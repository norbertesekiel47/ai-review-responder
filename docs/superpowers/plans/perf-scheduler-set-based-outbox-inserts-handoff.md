# Handoff — Ticket #484 (scheduler set-based outbox inserts)

**Branch/worktree:** `perf-scheduler-set-based-outbox-inserts` at
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/perf-scheduler-set-based-outbox-inserts`
**Lane:** RISK=high · backend · db_touching=true · staging-ride. Ticket-seeded from map #472 (audit item 10).
**Current step:** **step 8 (SHIP)** — implementation done, verify gate GREEN, steps 6 & 7 complete.

## Review verdicts (steps 6–7 — all triaged, gate re-green after each fix)
- **Step 6 codex adversarial (build):** 1 HIGH — migration-080 preflight test seeded pre-index dups into an already-indexed table (would fail CI). FIXED: temp-table pre-index isolation; VERIFIED green against a real bootstrapped Postgres 16 (commit 465d4d52).
- **Step 7 spec & correctness:** no ≥80% findings — faithful to intake (predicate/payload parity confirmed). Report: docs/reviews/perf-scheduler-set-based-outbox-inserts/spec-correctness.md.
- **Step 7 standards & maintainability:** APPROVE + 2 LOW. #1 dead uuid/jsonb mocks → FIXED (commit "drop dead uuid/jsonb mocks"). #2 payload decoupled from typed *Payload contract → REJECTED (inherent to set-based inserts; mitigated by consumer TS types + mocked key-name asserts + DB integration test). Report: docs/reviews/.../standards-maintainability.md.
- Plan gate (step 3): 3 codex rounds, all fixes applied (in-flight predicate, race-safe preflight, live CAS, preflight test).

## Read these (do NOT restate — open on demand)
- Intake contract: `.feature/intake.json` (the drift detector — surface, tests, edit surface).
- Plan: `docs/superpowers/plans/perf-scheduler-set-based-outbox-inserts.md` (tracer tasks + all SQL).
- Task list: TaskCreate #1 (migration+docs) → #2 (schedulers+allowlist+tests, blocked by #1) → #3 (gate+review+ship, blocked by #2).
- Skill: `outbox-pattern` (invariant #2 — here trivially satisfied; the single INSERT is the only write).

## Locked decisions (do not re-litigate)
- **UUIDs:** `gen_random_uuid()` in SQL for `id` + `payload.correlation_id` (prod has no `uuidv7()`; set-based can't call the JS generator; `job_outbox.id` has no ordering contract — OutboxPoller orders by `available_at`; 002 dropped its default so the INSERT must supply it explicitly, which it does).
- **Index predicate (weekly/monthly):** `status IN ('pending','dispatching','dispatched')` (in-flight only, mirrors current NOT EXISTS). Ranking keeps its existing `uniq_outbox_track_ranking_run` (`<> 'failed'`) — UNTOUCHED.
- **Preflight:** race-safe — keep most-advanced-then-oldest per (aggregate_id, period); fail ONLY currently-`pending` extras via a LIVE CAS (`AND status='pending'` on the outer UPDATE); exclude NULL period; two non-pending dups → build fails loudly (near-impossible).
- **ON CONFLICT:** target-less `DO NOTHING` (matches ranking precedent; avoids byte-match footgun). REJECTED codex finding 5 with reasoning.
- **Merge candidate SELECT into INSERT…SELECT;** drop per-row loop + 23505 catch; remove now-unused imports (`uuidv7`, `jsonb`, the payload type). Ranking loses `candidates_checked` log (only `queued`).

## Adversarial-review state (3 codex rounds, cap reached — all fixes applied)
- r1: `<>'failed'` suppression → in-flight predicate; build-fail → preflight.
- r2: preflight could fail an active `dispatched` row → keep-most-advanced/fail-pending-only; intake criterion; NULL guard.
- r3: CTE-snapshot race → **live CAS**; intake `edge_cases` synced; **preflight regression test** added.
- r3 fixes were NOT re-verified by a 4th codex pass (cap). User approved proceeding.

## Execution notes
- Test harness: mocked `sql` (`worker/__tests__/helpers/mock-sql`) — collapse makes it ONE call/cycle; update call-count assertions, drop `candidates_checked`/23505 tests, add shape + payload-key + two-`gen_random_uuid` assertions. Behavioral parity/dedup/distinct-correlation-id + preflight regression go in the DB-gated integration test (RUNS in CI: Postgres 16 + `TEST_DATABASE_POOL_URL`, migrations via `.github/actions/test-db`).
- Allowlist: update the 3 `*_CANDIDATES_SQL` constants in `scripts/ci/tenant-scope-allowlist.ts` to the FULL normalized merged statement; keep the 8 entries; run `pnpm ci:tenant-scope` iteratively.
- **CWD must stay at the worktree root** for hooks (edit-surface guard + stop gate armed; verified). All edits target worktree absolute paths. No Bash writes to repo files.
- Gate: `scripts/verify-gate.sh` (lint/typecheck/test + all ci:* incl. tenant-scope, rls-audit). Then step 6 adversarial (high-risk), step 7 dual review, step 8 staging ride.

## Resume
`/feature-resume perf-scheduler-set-based-outbox-inserts` — re-enter worktree, re-run ARM CHECK, bootstrap from this doc + intake + plan, continue at step 4.
