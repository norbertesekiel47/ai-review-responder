# #1185 deviations

## D1 — Required documentation surface

The first full review gate passed tests, build and changed-line coverage but failed `ci:merge-ledger`: the intake omitted the feature workflow's required architecture entry. Surface amendment 1 adds `.claude/reference/arch-review-log.md` and `docs/directory/lib-platform.md`; the latter's cookie-only wrapper description becomes false under the ticket. This is required bookkeeping under the authorized full feature workflow, without a behavior or ADR change. No new progress ledger is introduced.

**Verdict:** ACCEPT. Both documentation paths were checked by `pnpm agent:rules` (none). Full gate evidence: 1,065 test files and 14,643 tests passed; 99 files / 1,184 tests skipped, including unavailable live-DB suites. The first red was solely the missing ledger row.

## D2 — Deterministic red-team report paths

The report checker derives `feat-1185-67f43e` from branch `feat/1185`; intake originally allowed only the unhashed directory. The owner explicitly approved the second amendment on 2026-09-09: “I approve the second amendment you can continue”. This adds only `docs/reviews/red-team/feat-1185-67f43e/findings.md` and `docs/reviews/red-team/feat-1185-67f43e/findings.json`. It changes no production surface or authority.

**Verdict:** ACCEPT. `pnpm agent:rules` returned none for both exact report paths and the intake/deviations artifacts. Further surface expansion remains subject to the owner's hard stop.
