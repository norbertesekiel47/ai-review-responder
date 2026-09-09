# #1185 deviations

## D1 — Required documentation surface

The first full review gate passed tests, build and changed-line coverage but failed `ci:merge-ledger`: the intake omitted the feature workflow's required architecture entry. Surface amendment 1 adds `.claude/reference/arch-review-log.md` and `docs/directory/lib-platform.md`; the latter's cookie-only wrapper description becomes false under the ticket. This is required bookkeeping under the authorized full feature workflow, without a behavior or ADR change. No new progress ledger is introduced.

**Verdict:** ACCEPT. Both documentation paths were checked by `pnpm agent:rules` (none). No second surface amendment is authorized. Full gate evidence: 1,065 test files and 14,643 tests passed; 99 files / 1,184 tests skipped, including unavailable live-DB suites. The first red was solely the missing ledger row.
