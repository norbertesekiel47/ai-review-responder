# Spec & Correctness Review — fix/prod-hardening-guards

Reviewed: `git diff origin/main...HEAD -- worker/ src/ scripts/` (23 branch commits, rebased onto main)
against `.feature/intake.json` and the sanctioned deviations in
`docs/superpowers/plans/fix-prod-hardening-guards-deviations.md`.
Reviewer: spec/correctness subagent, 2026-07-19.

Verification run in this worktree: all 9 touched test files pass (83 tests),
neighboring suites pass (26 files / 309 tests across `src/lib/dashboard`,
`worker/jobs/zernio`, `worker/jobs/response-generation`,
`worker/background/pollers/health-alert`), `tsc --noEmit` clean,
`pnpm ci:tenant-scope` passes at the bumped baseline (395/395).

---

## 1. `user_visible_behavior` — all 3 implemented ✓

| Contract entry | Verdict | Evidence |
|---|---|---|
| Dashboard degrades per-widget instead of 500; business lookup keeps error semantics | ✓ | `src/lib/dashboard/service.ts` — `widgetOrFallbackFor` + 13-slot `Promise.allSettled` batch; fatal business lookup awaited separately (`businessPromise`), `BusinessNotFoundError` preserved. Aggregate path (`aggregate-service.ts`) degrades its two independent queries (`accountBillingRows`, `accountRecentReviews`); locations list + atomic slice wave stay fatal per the sanctioned rebase adaptation (deviations 2026-07-19). Tests: `service.degradation.test.ts`, `aggregate-service.degradation.test.ts`. |
| Transient failure during avoid-facts guardrail regen retries instead of dropping the draft | ✓ | `worker/jobs/response-generation/generate-draft.ts:186-189` (outer) + `:277` (inner) re-throw via `isTransientGenerationError`; matrix test in `generate-draft.test.ts` covers all three classes. |
| Operational: emitter-error survival, new health alerts, bounded ingress | ✓ | `worker/emitter-errors.ts` + wiring in `worker/queues.ts:85-89` (queues), `worker/index.ts:381-383` (all Workers, keyed by queue name), `worker/index.ts:474-477` (probe Redis). `checkFailedOutboxByTopic` now includes `GENERATE_RESPONSE`; new `checkFailedInboundEvents` registered in the sequential core bundle of `runHealthChecks`. `buildFastifyOptions` wired at `worker/index.ts:164`. |

## 2. `invariants` — all 6 preserved ✓

1. **Outbox semantics** — `markOutboxFailed`/`markOutboxCompleted` call sites keep their
   meaning. The P1 refactor moves the three typed-error paths to a CAS-first coupled
   transaction (`withOwnedTerminalTransition`), which is the plan-R3 sanctioned CAS-ownership
   change, not a drift: `markOutboxFailed` (`src/lib/shared/outbox.ts:107`) returns the
   ownership boolean it documents, and the generic-error branch keeps the bare
   single-statement call.
2. **Budget/cost-cap TERMINAL** — verified precedence: `isCostCapError` is checked *before*
   `isTransientGenerationError` in the primary catch (`generate-draft.ts:136/141`), the
   guardrail outer catch (`:181/186`), and the guardrail inner catch (`:268/277`).
   `CostLimitExceededError`/`GlobalCostLimitExceededError`/`RegenBudgetExceededError` all
   extend `Error` directly (`src/lib/costs/tracker.ts:12-26`) — no hierarchy leak into the
   transient classes. `RegenBudgetExceededError` in the guardrail lane falls through to the
   terminal `guardrail_failed` wrap (still terminal). A transient cannot be wrapped terminal:
   the only wrap site (`:280-281`) is behind both transient guards.
3. **No silent degradation** — every `widgetOrFallback` miss calls `reportCaughtError` with
   `{widget, degraded: true}` (asserted in both degradation suites); `readPendingMarker`'s
   console-only degrade was upgraded to `reportCaughtError`; emitter errors log + Sentry-warn
   with per-source throttling that surfaces the suppressed count when the next window opens.
4. **No raw review/response text in logs** — new log payloads carry only IDs, widget names,
   error messages of infra errors, and counts.
5. **Listeners/last-resort catches never throw** — emitter listener body fully wrapped
   (`emitter-errors.ts:26-46`, tested against a throwing Sentry);
   `captureIngestFailedHookCrash` wraps its own console+Sentry in try/catch and `.catch`es
   the best-effort mark (hardened beyond the publisher template it mirrors).
6. **Happy-path dashboard behavior-identical** — all-healthy tests in both degradation
   suites assert no reports and unchanged output; the full pre-existing dashboard suites pass
   under the adoption-order rework.

## 3. `tests_to_add` — all 7 present and asserting the right thing ✓

| Entry | File | Note |
|---|---|---|
| ingest-failed-hook crash-guard (resolves + Sentry; resolves when mark also throws) | `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` "last-resort crash guard" block | Also covers coupled-tx no-split, mid-tx rollback atomicity, and stale-CAS quiet no-op — beyond contract. |
| boundedSupabaseFetch attaches signal; rejects within bound | `src/lib/db/__tests__/supabase-fetch-timeout.test.ts` | Plus 10s-constant pin and caller-signal composition (edge case 3). |
| guardrail regen error matrix | `generate-draft.test.ts` `it.each` over the three transient classes | Violation-persists terminal covered by the retained pre-existing test. |
| attachEmitterErrorLogger consumes without throwing; survives Sentry throw | `worker/__tests__/emitter-errors.test.ts` | Plus throttle-window and per-source independence tests. |
| buildFastifyOptions asserts all four limits + logger levels | `worker/config/__tests__/fastify-options.test.ts` | Includes a live-instance wiring proof (413 on oversized inject). |
| health checks: generate_response finding; per-source inbound findings + quiet; runHealthChecks includes new check | `checks.test.ts` | SQL-text assertions prove the production query text, not just the mock rows. |
| dashboard degradation: aux degrades + reports; business still throws; all-healthy unchanged | both `*.degradation.test.ts` files | |

## 4. `edge_cases` — all 6 handled ✓

1. `markOutboxFailed` throwing inside the P1 crash guard → `.catch` log-and-swallow
   (`ingest-failed-hook.ts:161-163`), tested.
2. Sentry throwing inside the P5 listener → try/catch swallow, tested.
3. Caller AbortSignal composed via `AbortSignal.any` (`src/lib/db/server.ts:158-161`), tested.
4. Regen still violating → plain-Error throw → terminal `guardrail_failed` (both transient
   guards bypassed), pre-existing test retained.
5. inbound_events grouped per source — implemented finer, per `(source, event_type)`, which
   strictly satisfies "one noisy provider doesn't mask another"; schema verified against
   `supabase/migrations/001_initial_schema.sql:277-291` (columns + partial index
   `idx_ie_status` both real; `status='failed'` is genuinely written by
   `worker/ingress/shared.ts:72`).
6. `queues.ts` import stays side-effect-light — the listener loop attaches handlers only,
   no I/O; `queue-routing.test.ts` mock gained the sanctioned no-op `on()`.

## 5. Edit surface ✓

Every file in `git diff --name-only origin/main...HEAD` falls inside
`allowed_edit_surface` (`.feature/intake.json` restoration sanctioned; all docs paths under
`docs/superpowers/**` / `docs/reviews/**`; `.claude/CLAUDE.md` cost-guard bullet updated to
the owner-accepted guardrail-retry semantics with the deviation-mandated "bounded by the
queue's BullMQ attempts budget" phrasing).

## 6. Targeted bug-hunt on the refactored shapes

- **`withOwnedTerminalTransition` flag lifecycle**: flag set before `sql.begin`, cleared only
  after commit; on any throw (including `begin` itself rejecting pre-callback) it stays set,
  so `captureIngestFailedHookCrash` refuses to split the rolled-back tx — row stays
  `dispatched` for atomic watchdog recovery. Tested ("deadlock" and "insert blew up" cases).
- **Stale CAS**: `fn` skipped, `ownsAttempt=false` returned; pagination trend signal gated on
  ownership and emitted post-commit. If the post-commit `Sentry.captureMessage` itself threw,
  the crash guard's best-effort `markOutboxFailed` would CAS against an already-`failed` row
  and no-op — no corruption.
- **Transient-wrap leak**: none found — the only wrap-to-terminal site sits behind both
  `isCostCapError` and `isTransientGenerationError` guards at every layer.
- **Emitter throttle map**: keyed by fixed source strings (~26 queues + workers + probe) —
  bounded; per-source windows independent; listener cannot throw.
- **Dashboard adoption order**: `businessPromise` creation → `allSettled` batch construction
  → `await businessPromise` all run in one synchronous sequence, so handlers are attached
  before the microtask queue drains — no unhandled-rejection window; `allSettled` results
  never reject, so an early business throw safely orphans the batch. Same pattern verified on
  the aggregate path (batch built before each fatal await).
- **`boundedSupabaseFetch`**: composition correct (`init?.signal` falsy → timeout-only);
  no `supabaseServer.storage` upload call sites exist, so the 10s bound cannot truncate a
  legitimate long transfer; `CleanupAbandonedSignupsPoller`'s own 10s race is now redundant
  but harmless.
- **Health checks**: new check reuses `failedWindowS`/`failedThreshold` (default 0 → any
  failed event alerts, matching the outbox-failure semantics); placed inside the sequential
  #505-safe core bundle (correct — one query in flight), before the isolated backlog check.

## Findings (≥80% confidence)

| Severity | Location | Finding |
|---|---|---|
| Low | `worker/jobs/response-generation/generate-draft.ts:142-143` | Comment hardcodes "3 attempts + backoff" and "the 1h stale window", but the `generate_response` queue runs `attempts: 5` (`worker/queues.ts:52` `llmJobOptions`) and the watchdog default is 15min (`OUTBOX_WATCHDOG_STALE_MS`) — exactly the hardcoding the deviations log (2026-07-16, Task 3) instructed against. Failure scenario: a future reader sizes retry/spend budgets off the comment (e.g. reasoning about worst-case guardrail re-spend) and under-counts by 2 attempts. Comment-only; no behavior impact. |
| Low | `worker/background/pollers/health-alert/checks.ts` (runHealthChecks #505 comment, "the 5 core checks' shared-fate") | The sequential bundle now contains 6 core checks after `checkFailedInboundEvents` was added; the count in the load-bearing #505 rationale comment is stale. Comment-only. |

## Low-confidence appendix (speculation, <80%)

- **Emitter throttle tail loss**: suppressed-error counts surface only when a *later* error
  opens a new window; a storm that ends cleanly never reports its final suppressed tally.
  Matches the plan-R3 throttle design as written, so likely intentional — flagging only as a
  residual observability nuance.
- **`reportCaughtError` log line outside its try/catch**
  (`src/lib/shared/report-caught-error.ts`, pre-existing module): only `captureException` is
  guarded; a throwing `createWorkerLogger(...).error` would propagate out of
  `widgetOrFallback` and 500 the dashboard. Context objects here are flat string maps, so a
  throw is implausible; also outside this branch's diff.
- **Degraded billing fallback renders "Billing update pending"** for non-primary locations
  when the billing row query fails — a slightly misleading banner for an infra failure.
  Sanctioned by deviations item (d) ("`?? 1`/`?? 0` defaults already define the fallback
  shape"), so recorded only as UX residue.
- **Degraded dashboard payloads cacheable for the 45s #495 TTL** — explicitly accepted in
  the deviations log (2026-07-19 entry); noted for completeness.

## Verdict

Spec-complete. Every intake field is implemented, every invariant holds under adversarial
reading of the final shapes, and both findings are stale-comment-only. No behavioral defect
found at ≥80% confidence.

---
# Orchestrator triage (2026-07-19)

Both findings ACCEPTED and fixed in commit 23dc0204 (comment-only de-hardcoding).
No behavioral findings; review round closed.
