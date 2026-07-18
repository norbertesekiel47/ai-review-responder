# Deviations — #505 pool-wedge root-cause + cure + reaper deletion

Surprises and orchestration choices during step-4 EXECUTE. Read alongside the plan
(`fix-505-pool-wedge-rootcause.md`) and intake (`.feature/intake.json`). Scope is
UNCHANGED — same tasks, same allowed_edit_surface, same acceptance criteria.

## D0 — Execution order: T3 → T2 → T1 → T4 (orchestration, not scope)

The handoff suggested "T1 + T3 parallelizable, T2 validated by T1, T4 last." During
execution setup two facts forced a sequential re-order:

1. **T2 and T3 both edit `worker/index.ts`** (T3 removes the `startPoolWedgeReaperPoller`
   wiring; T2 adds the boot-readiness coordinator). They cannot run as parallel
   implementers — `subagent-driven-development` forbids parallel implementers for
   exactly this conflict.
2. **T1's harness toggles the T2 cure seam via env.** Writing T1 before T2 would make
   the harness reference a boot-stagger flag that does not exist yet. Landing T2 first
   gives T1 a real flag to toggle (baseline off / treatment on).

Chosen order **T3 → T2 → T1 → T4** respects every blocking edge in the plan: T2's
*code* depends on nothing from T1 (T1 *validates* T2 operationally via OP2), and docs
(T4) stay last. No file surface, acceptance criterion, or decision changed.

## D1 — T3: `env-vars.md` `DATABASE_URL` entry had a dangling reaper cross-ref

The `DATABASE_URL` doc entry forward-referenced the reaper/`DIRECT_URL` narrative.
Trimmed it to the direct-route-on-staging fact so it no longer points at a deleted
entry (dangling refs are bugs per repworth.md). Commit `509cdac6`.

## D2 — T3: `DIRECT_URL` `env-vars.md` entry claimed "used for migrations"

The old `DIRECT_URL` entry claimed it "bypasses PgBouncer for migrations." A repo-wide
grep (code, `scripts/`, `package.json`, `.github/`, `supabase/`, CI) found **zero**
non-reaper consumers — matching the intake's "sole consumer was the reaper." The
migrations claim was stale/aspirational doc; the entry was removed. Independently
re-verified by the T3 spec reviewer. The genuine-direct-route concept is preserved for
the #477 re-arm ticket (T4). Commit `509cdac6`.

## D3 — T3: `server.test.ts` `application_name` fixture renamed

The `createDedicatedPostgresClient` app-name-override test used `'rw-wedge-reaper'` as
its fixture — a value the system no longer uses. Renamed to a generic `'custom-app-name'`
so the test stops implying a live reaper value, while keeping the factory-override
coverage (the health client uses the same factory). Commit `509cdac6`.

## T3 — CLOSED. Both review gates passed (spec ✅ + code-quality Approved).
Commit `509cdac6` (base `f9080813`). 19 files, all CI-subset checks green
(typecheck, 8779 tests, `ci:db-imports` strict, lint). Bulkhead (#502) untouched;
shutdown-resilience invariant preserved.

## D4 — T2: `abortBootCoordinator` shutdown dep made OPTIONAL (surface boundary)

The plan offered adding `abortBootCoordinator` to `GracefulShutdownDeps` and calling
it first. The clean test for that ordering lives in `worker/__tests__/shutdown.test.ts`
— but that file is OUTSIDE `allowed_edit_surface` (the intake lists `worker/shutdown.ts`
and `worker/background/**`, not `worker/__tests__/**`), and adding a *required* dep
would break its `makeDeps` literal at typecheck. Rather than edit a blocked file (or
work around the hook), the dep is declared **optional** (`abortBootCoordinator?`) and
invoked `deps.abortBootCoordinator?.()` FIRST in the shutdown handler: the pre-#505
test compiles + passes unchanged, and `worker/index.ts` always wires it. The
abort-before-stop ordering is proven by a NEW in-surface test,
`worker/background/__tests__/boot-shutdown-ordering.test.ts`. No shutdown semantics
changed beyond the added first step. Judgment call — flagged for reviewer.

## D5 — T2: `AutonomyGovernorScheduler.test.ts` registration-grep assertion updated

That suite greps `worker/index.ts` for the literal `startAutonomyGovernorScheduler();`.
The cure thunk-wraps every loop start into the `loopStarts` array
(`() => startAutonomyGovernorScheduler()`), so the trailing-semicolon literal no longer
matches. Loosened the assertion to `startAutonomyGovernorScheduler()` (call without the
semicolon) — still proves the scheduler is wired for startup; the stop assertion is
unchanged (stop still runs synchronously in `stopBackgroundLoops`). In-surface
(`worker/background/**`).

## D6 — T2: worker resume is all-at-once AFTER the stagger (per spec), Redis-only burst

Per the plan ("only AFTER the stagger completes resume the Workers"), all ~30 workers
resume together via `worker.run()` once the staggered DB-loop starts finish. That
reintroduces a burst of *Redis* (Railway) connection opens — NOT Postgres/Supavisor
pooler opens, which are the wedge surface and ARE spread by the loop stagger. Job
handlers touch Postgres only as jobs actually arrive (naturally spread), so this does
not re-create the boot pooler burst. Left as-is intentionally. (D6 rationale is now
also captured as an inline comment at the resume site per the review, so a future
reader doesn't "fix" it.)

## Code-quality review fixes (Approved-with-minor) — F1, F2

**F1 (race) — `bootAbortController` hoisted to module scope.** It was created AFTER
`await app.listen()`, so a SIGTERM arriving WHILE listen was pending hit
`abortBootCoordinator()` with the controller still null (`?.abort()` no-op); listen
then resolved and `main()` built a FRESH un-aborted controller and launched the
coordinator concurrently with the running teardown — the exact "begin DB work
mid-SIGTERM" the abort-first ordering exists to prevent. Fix: the controller is now a
module-scope `const` created at load (before the signal handlers can fire), and `main()`
no longer reassigns it. An early abort sets `signal.aborted` and `runBootCoordinator`
bails at line 1. Proven by the renamed test `signal already aborted before coordinator
starts: no readiness, no start, no worker-resume (FIX F1)`.

**F2 (fail-inside-boundaries) — per-start try/catch in `staggerBoot`.** A scheduled
`start()` throwing synchronously previously never incremented `fired` (so `done` never
resolved) AND escaped the timer as a fatal `uncaughtException` (crash-net kills all
loops+workers). Each start invocation is now wrapped: the throw is reported via a new
optional `onStartError` hook (index.ts logs it) and swallowed, the start still counts
toward completion, and the other starts run. Proven by `a start that throws
synchronously is contained: other starts run and done still resolves (FIX F2)`.

Gates after F1/F2: typecheck clean, `worker/**` 1772 passed, boot-stagger suite 22
passed, `ci:db-imports` strict, lint clean. The optional `abortBootCoordinator?` dep
(D4) stays as-is per the reviewer (out-of-surface test edit needs sign-off).

## T2 — CLOSED. Spec ✅ + code-quality Approved (F1/F2 re-reviewed Approved).
Spec review verified OFF-path worker-resume + all three abort-race points non-trivially.
Code-quality Approved-with-minor → F1/F2 applied → focused re-review Approved (race
closed, throw contained, non-trivial regression tests, gates green). Commits
`4529395c` (cure) → `28c232a9` (F1/F2). Toggle `BOOT_STAGGER_ENABLED` default ON
(only literal `"false"` disables). D4 optional dep deferred to a sign-off-gated follow-up.

## D7 — T1: transport instrumentation DECLARED OPAQUE (no `server.ts` edit)

The plan offered an opt-in, default-off `PG_DEBUG_TRACE` gate wiring postgres.js's
`debug` hook into the production DB singleton (`src/lib/db/server.ts`). Not built.
Rationale: (a) the `debug` hook fires PRE-write (messages queued, not `socket.write()`
completion) so it cannot prove the transport mechanism; (b) the cork/uncork theory was
already falsified for postgres.js 3.4.9; (c) the harness's PRIMARY signal is external
`pg_stat_activity` observation + the empirical treatment result, which stand on their
own; (d) even a strictly-gated hook adds surface to the prod singleton. Per the task's
minimal-production-intrusion preference, the harness prints "TRANSPORT TRACE: not wired
— declared OPAQUE" in its summary and falls back to the empirical signal. Judgment call
— `server.ts` left untouched.

## D8 — T1: guard test lives in `scripts/ci/__tests__/` (vitest include glob)

The task suggested `scripts/__tests__/wedge-repro.test.ts`. The vitest `include` glob is
`scripts/ci/**/__tests__/**/*.test.ts` — a bare `scripts/__tests__/` file is NOT
collected (and a CLI path filter cannot override `include`). Placed the guard test at
`scripts/ci/__tests__/wedge-repro.test.ts` importing `../../wedge-repro`, matching the
existing precedent where `scripts/ci/__tests__/verify-stripe-price-parity.test.ts` tests
the root-level `scripts/verify-stripe-price-parity.ts`. Both files stay inside the T1
`scripts/**` surface; no config edit (vitest.config.ts is out-of-surface).

## T1 — harness delivered. `scripts/wedge-repro.ts` (fresh-process-per-trial, direct
observer, staging-only guard) + `scripts/ci/__tests__/wedge-repro.test.ts` (11 guard
tests green). typecheck / `ci:db-imports` strict / lint all clean. Operational baseline
(OP1) + treatment (OP2) results are produced by the operator running the harness via MCP.
