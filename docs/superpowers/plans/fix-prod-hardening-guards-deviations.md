# Deviations / coordination notes — fix/prod-hardening-guards

- [2026-07-16] **Parallel uncommitted workstream in the parent checkout** touches
  `worker/queues.ts` (adds `llmJobOptions` with `attempts: 5` for the
  `generate_response` queue + `OUTBOX_WATCHDOG_STALE_MS` 15min default),
  `.claude/CLAUDE.md` (same cost-guard gotcha bullet Task 3 edits),
  `scripts/ci/tenant-scope-allowlist.ts`, and several dashboard routes.
  Consequences for this branch:
  - **Task 3 wording:** do NOT hardcode "3 attempts" in the new comment or the
    CLAUDE.md gotcha replacement. Phrase the bound as "bounded by the
    `generate_response` queue's BullMQ attempts budget" so it stays true when
    the parallel 5-attempt change lands. (On this branch's base, code truth is
    `attempts: 3` for all queues — worker/queues.ts:38.)
  - **PR time:** expect a one-line merge conflict on the CLAUDE.md cost-guard
    bullet (it is a single long line and the parallel stream edits it too);
    resolve by combining both edits (their retry/watchdog numbers + our
    guardrail-retry parenthetical).
  - **Task 8:** if `ci:tenant-scope` needs an allowlist entry for the
    `inbound_events` health query, base it on the branch's committed
    allowlist, not the parent's uncommitted version.
- [2026-07-16] `.feature/` is not gitignored repo-wide; all commits must use
  explicit `git add <paths>` (plan already does). Follow-up: add `.feature/` to
  `.gitignore` in a separate change (out of this branch's declared surface).
- [2026-07-16] **Task 4 (P5):** `worker/__tests__/queue-routing.test.ts` mocks
  BullMQ `Queue` as a bare class with no `on` method, so the new module-scope
  `attachEmitterErrorLogger` loop in `worker/queues.ts` crashed that suite at
  import. Fixed by adding a no-op `on()` to the test's Queue mock (test-only
  change; production helper stays non-defensive). Everything else in Tasks 4-6
  matched the plan — `inbound_events` column is `event_type` as assumed, and
  the health-check SQL-text assertions read the recorded template strings off
  the existing `vi.fn` sql mock (no harness extension needed).
- [2026-07-16] **Task 1 (P1) minor adaptations from the plan skeleton:**
  `dispatchIngestExhaustion` drops the unused `job` param (dispatch only needs
  `err` + `state`); `handlePaginationCapExhausted` captures the CAS result in a
  plain `let ownsAttempt` across `sql.begin` (boolean — no literal-narrowing
  pin) so the Sentry trend signal fires post-commit only on ownership; the test
  file's `mockSql` gained reject-on-queued-Error support plus a `begin`
  passthrough mock to exercise the coupled-tx rollback cases. Tasks 1 and 3
  otherwise matched the plan exactly.
- [2026-07-16] **Task 2 (P2):** the fake-timers timeout test hung as the plan
  warned — `AbortSignal.timeout` runs on Node's internal timer list, which
  vitest's fake timers cannot advance (Node 24). Took the plan's sanctioned
  fallback: real-timer test with a small injected timeout, which required
  giving `boundedSupabaseFetch` an optional third `timeoutMs` param defaulting
  to `SUPABASE_FETCH_TIMEOUT_MS` (test-only; production callers never pass it).
  Added a fourth test pinning the constant at 10_000.
- [2026-07-16] **Task 7 (P10) adaptations:** (a) the fatal business query is
  adopted via `Promise.resolve(...)` BEFORE the `allSettled` batch is built —
  thenable-adoption order is what keeps the shared mock-sql FIFO consuming
  results in source order (business first), so every pre-existing dashboard
  test's seed order survives; it also eagerly starts the lazy Postgres.js
  thenable. (b) `aggregate-service.ts` now imports `widgetOrFallback` from
  `./service`, so the existing `aggregate-service.test.ts` mock of
  `@/lib/dashboard/service` was switched to an `importOriginal` spread (plus a
  redis-cache stub so loading the real service module never touches ioredis).
  (c) The bare `[]` fallbacks needed element-typed casts
  (`[] as DashboardRankingRow[]` etc.) exactly as the plan's TypeScript note
  anticipated — Postgres.js `RowList` intersection defeats bare-`[]` inference.
  (d) The aggregate billing query (`locations_included`/`locations_paid`)
  degrades too (widget `accountBillingRows`) — it is an aggregate-own
  account-total query and its `?? 1`/`?? 0` defaults already define the
  fallback shape. Query count matched the plan (13 = 1 fatal + 11 SQL aux +
  1 Redis pending marker).
