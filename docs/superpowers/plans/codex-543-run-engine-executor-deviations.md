# Deviations read-back: #543

## D1 — Real-Postgres evidence expanded the diff

The implemented feature exceeded the original line estimate because the
5,001-contact rotation case, concurrency behavior, migration catalog facts,
and account-offboarding cascade were proven against Postgres rather than
mocked.

**VERDICT: ACCEPT.** The plan and intake record the measured reclassification;
the feature remains one high-risk schema/worker domain with a named surface.

## D2 — Shared DB suites require fail-safe serialization

The feature gate launches changed integration suites in separate processes.
Migration 088 replaces live constraints, so concurrent fixture lifecycles
collided until the four suites acquired one session advisory lock for their
full lifecycle.

**VERDICT: ACCEPT.** Isolation preserves coverage and prevents cross-suite DDL
or cascade interference. After the repeated-history regression increased the
valid serialized workload, diagnosis retained the lock and derived a
five-minute acquisition bound instead of narrowing the safety boundary.

## D3 — Solicitation needed focused run terminalization seams

The generic run-spine terminal APIs carry review-anchor guards that do not
apply to a `solicitation_batch` subject. Focused Solicitation success/failure
seams were added rather than bypassing the guard or widening the generic API.

**VERDICT: ACCEPT.** `run-spine.ts` remains the only writer and the focused
seams keep bounded Solicitation metadata explicit.

## D4 — Adversarial review reopened the contract

The first green gate did not prove database-enforced tenant links, the shared
offboarding processing gate, actionable exhausted-failure alerts, or bounded
intermediate history work. The health-alert surface was a second amendment,
triggering the feature workflow restart and postmortem.

**VERDICT: ACCEPT.** The user-supplied findings were valid. The restarted
intake and approved plan made all four executable with verbatim regressions;
no product-scope decision was invalidated.

## D5 — Tenant audit required an equivalent indexed query shape

The independently reduced CTE query was tenant-safe in SQL, but the
tenant-scope audit intentionally strips nested `SELECT`s and could not see its
bindings. The candidate query now uses indexed latest-row lookups with
explicit top-level account/Business joins.

**VERDICT: ACCEPT.** This is one of the review's recommended bounded-history
shapes, preserves the whole-pool order and send-only history, and passes both
the audit and the 4,000-by-4,000 regression.

## D6 — Final review found a storage type and a runner-only timeout

The standards review found that the account-wide agent-team reader typed
persisted personas with the narrower review-timeline union, and that the
five-minute advisory-lock bound existed only in Vitest rather than Postgres.
It also flagged the 1,016-line builder integration suite and four copied lock
harnesses.

**VERDICT: ACCEPT / ADAPT.** The persisted reader now uses the full persona
union. A shared test helper enforces a four-minute database statement timeout,
closes failed waiters, and is covered by a real timeout/session-cleanup test.
Centralizing the harness reduces the builder suite to 967 lines; splitting the
suite was rejected because each new file would add another separately
scheduled full-lifecycle migration-088 lock holder.

## D7 — Post-rebase local gate can't go green (whole-repo integration concurrency)

The step-8 rebase onto `origin/main` (docs-only) invalidated the committed
green gate's freshness, so the pre-ship `verify-gate.sh --review` was re-run
with `TEST_DATABASE_POOL_URL` set. It went RED on `test` + `diff-coverage`
across three runs (2 default, 1 `VITEST_MAX_WORKERS=1`). Root cause:
`verify-gate.sh` launches `pnpm test:coverage` (the whole repo, incl. every
`*.integration.test.ts`) CONCURRENTLY with the dedicated changed-suite
`integration-*` rows, all against one local Postgres. Other features' live-DB
suites lose cross-process deadlock races (`deadlock detected`, `duplicate key`,
`Hook timed out`); the victim set shifts run to run. No #543 suite ever failed;
every #543-specific check passed every run. `diff-coverage` is downstream —
the deadlocked `test:coverage` never emits `coverage-final.json`.
`VITEST_MAX_WORKERS=1` serializes within a process but cannot fix cross-process
contention. Code is byte-identical to the reviewed green gate `673d2170`.

**VERDICT: ACCEPT.** Not a branch defect. The user accepted CI as the
authoritative full-suite gate (CLAUDE.md: "CI stays the full-suite gate"; CI's
`test` job runs unit-only without a local pool URL and self-skips integration).
The gate-harness flaw (`test:coverage` inheriting the DB URL and running
whole-repo integration alongside the isolated rows) is a general local-harness
hardening item, out of #543's surface — worth a follow-up ticket, not a
#543-blocking fix.
