# #1185 deviations

## D1 — Required documentation surface

The first full review gate passed tests, build and changed-line coverage but failed `ci:merge-ledger`: the intake omitted the feature workflow's required architecture entry. Surface amendment 1 adds `.claude/reference/arch-review-log.md` and `docs/directory/lib-platform.md`; the latter's cookie-only wrapper description becomes false under the ticket. This is required bookkeeping under the authorized full feature workflow, without a behavior or ADR change. No new progress ledger is introduced.

**Verdict:** ACCEPT. Both documentation paths were checked by `pnpm agent:rules` (none). Full gate evidence: 1,065 test files and 14,643 tests passed; 99 files / 1,184 tests skipped, including unavailable live-DB suites. The first red was solely the missing ledger row.

## D2 — Deterministic red-team report paths

The report checker derives `feat-1185-67f43e` from branch `feat/1185`; intake originally allowed only the unhashed directory. The owner explicitly approved the second amendment on 2026-09-09: “I approve the second amendment you can continue”. This adds only `docs/reviews/red-team/feat-1185-67f43e/findings.md` and `docs/reviews/red-team/feat-1185-67f43e/findings.json`. It changes no production surface or authority.

**Verdict:** ACCEPT. `pnpm agent:rules` returned none for both exact report paths and the intake/deviations artifacts. Further surface expansion remains subject to the owner's hard stop.

## D3 — Owner-authorized completion of the mutation inventory

On 2026-09-09 the owner answered “I approve” to: “Approve the ticket-scoped verifier change needed to finish those 439 cases—at least 878 additional test runs? The red-team skill limits verification to ‘30 mutation runs per round,’ which is the remaining blocker.” This authorizes completion, not a coverage waiver or another round.

The bounded continuation keeps round 1 and its 30 spent launches. Only `feat/1185` with its original 453-row inventory and the exact recorded authorization may use 1,400 total launches: 30 spent plus 439 baselines and at most two mutations each (1,347), with 53 launches reserved for the narrow verifier change. Every other branch and round retains 30. The timeout, two-mutation limit, journal, finalizer and incomplete statuses remain intact. Original measured HEAD hashes remain in the evidence; current-tree claims require current-tree measurements.

**Verdict:** ACCEPT by the explicit owner approval above. The additional surface is the existing Codex mutation runner, the red-team skill under both `.claude/skills/` and `.agents/skills/`, plus `scripts/ci/__tests__/red-team-mutation-runner.test.ts`. The runner is Codex-only; only the skill prose has a source/mirror pair. Skill parity and focused refusal/continuation tests are required. No product behavior, global limit, new round, production write or merge is authorized by this amendment.
