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
