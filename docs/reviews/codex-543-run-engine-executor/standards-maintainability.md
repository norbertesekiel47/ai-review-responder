# Standards and maintainability review — #543

Target: working-tree diff from merge-base `42a4c30b7fe1142e9f1576a5f1ea6229b0bd8b49`
through remediation HEAD `57c262a10adb75199d69014b5630fc96c942db38`.

Method: thermo-nuclear code-quality review against `AGENTS.md`,
`.claude/rules/{repworth,engineering,production}.md`, the Solicitation
glossary, intake, deviations read-back, blast-radius inventory, executor spec,
and ADR 0011. The review traced the changed run-spine callers and inspected
migration rerunnability/Postgres compatibility, query shape, transaction and
offboarding lock order, terminal-failure ownership, PII boundaries, and the
shared-database test gate.

## Verdict

**PASS (post-fix).** The original review at `9fc3c5d7` found three
maintainability/standards blockers. Commits `644ce265` and `57c262a1` close all
three without changing product behavior; no standards blocker remains.

## Post-fix triage

- **ACCEPT F1:** `TeamSummaryRow` now uses the full
  `AttributedAgentPersona` storage union and a regression proves persisted
  Solicitation outcomes are accepted while the review-handler timeline stays
  intentionally scoped to `AgentPersona`.
- **ACCEPT F2:** one shared helper enforces a four-minute PostgreSQL
  `statement_timeout` beneath the five-minute hook timeout, closes the waiting
  client on failure, and a real-Postgres regression proves `57014`, waiter
  session cleanup, and successor acquisition.
- **ADAPT F3:** centralizing the four copied harnesses reduces the builder
  suite to 967 lines, below the 1,000-line presumptive threshold; retaining one
  suite is justified because splitting it would add separately scheduled
  full-lifecycle migration-088 DDL lock holders rather than reduce the guarded
  lifecycle.

Focused post-fix verification: 16/16 tests passed across
`read.test.ts` and `feature-543-database-lock.integration.test.ts`.

## Original findings (confidence >= 80%; all closed above)

| Severity | Confidence | Location | Finding | Concrete scenario / standard | Required remedy |
|---|---:|---|---|---|---|
| Medium | 95% | `src/lib/agents/run-spine.ts:32-35` | `AGENT_PERSONAS` now includes `solicitation`, but the exported `AgentPersona` type deliberately excludes it. Existing database readers still declare raw `agent_outcomes.attributed_agent` values as `AgentPersona` (`src/lib/agents/read.ts:162`) even though `getAgentTeamSummary` now receives real `solicitation` rows. | After the first built batch, Postgres returns `{ attributed_agent: 'solicitation', outcome_kind: 'solicitation_batch_built' }` through a type that claims that value is impossible. Today `mapTeamSummary` silently ignores it; a future exhaustive consumer can be compiled under a false invariant. This violates the project rule to make boundary contracts explicit and the thermo-nuclear type-boundary standard. | Keep the storage/domain union honest (`AgentPersona` or a clearly named `AttributedAgentPersona` must include every DB value). Introduce a separate UI-only `TimelinePersona`/`DisplayedPersona` at the timeline component boundary, and type raw read rows with the full storage union. |
| Medium | 98% | `src/lib/solicitation/__tests__/batch-builder.integration.test.ts:243-248` (same pattern in the other three #543 integration suites) | The stated five-minute database-lock bound is only a Vitest hook timeout around blocking `pg_advisory_lock`; it does not cancel or time-limit the PostgreSQL statement. | If another process holds the session lock beyond five minutes, Vitest times out the hook while the Postgres.js query continues waiting. Cleanup is queued behind that same connection, so the suite can hang or later acquire and retain the lock without a reliable release path. This violates the explicit-timeout/resource-ownership rules in `production.md`; the comment at lines 41-45 promises a bound the mechanism does not enforce. | Replace blocking acquisition with a shared helper that polls `pg_try_advisory_lock` to a real deadline (and always closes the session), or enforce a database-side timeout whose error path closes the lock client. Test the timeout/cleanup behavior; do not rely on a test-runner timeout as cancellation. |
| Medium | 100% | `src/lib/solicitation/__tests__/batch-builder.integration.test.ts:1` | The new integration suite is 1,016 lines and combines schema setup, common tenant fixtures, success/retry semantics, concurrency, offboarding races, terminal failure, history performance, and 5,001-contact rotation. | This branch creates a file over the thermo-nuclear 1,000-line presumptive-blocker threshold. The same database URL parsing, advisory-lock protocol, migration setup, and cleanup are also copied across four suites, which is already why a lock-timeout change required four synchronized edits. | Extract one #543 local-DB fixture/lock module, then split the suite by responsibility (for example lifecycle/failure, concurrency/offboarding, and history/window). Keep each test focused while preserving the full-lifecycle serialization boundary required by migration 088. |

## Positive checks

- Migration 088's composite run foreign keys keep account and Business columns
  non-null during run archival, and the migration's double-application test
  exercises the Postgres syntax used by the branch.
- Candidate history uses independently indexed latest-row lookups rather than
  a visits-by-asks product; the 4,000-by-4,000 regression exercises it under a
  two-second statement timeout.
- Both preparation and construction lock the account row before a later
  offboarding-state read. No inverse batch/account dependency was found in the
  offboarding-confirm path.
- Construction owns the outbox transition first and commits asks, child runs,
  parent attribution, `built_at`, and outbox completion atomically. The failed
  hook likewise lets only the exact-attempt CAS winner terminalize the parent.
- Stored evidence, run metadata, health findings, and worker logs contain
  identifiers, enums, counts, dates, and bounded error-class names only; no
  contact name, email, phone, raw CSV, or review text is copied.
- The changed generic registries and outbox helpers preserve existing caller
  behavior; the blast-radius scan found no semantic change to prior queue
  topics or run terminalization callers.

## Appendix — lower-confidence notes

No lower-confidence notes were retained.
