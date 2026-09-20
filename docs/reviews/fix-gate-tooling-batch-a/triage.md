# Review round 1 — triage verdicts (`fix/gate-tooling-batch-a`)

Wave composition, `RISK = normal`: spec & correctness (opus) + standards &
maintainability (opus, via `thermo-nuclear-code-quality-review`). No
adversarial axis (`RISK = high` only). No red-team pass — waived from the
signed-off intake.

**Standards-axis threshold, measured not estimated:** executable production
diff 391 lines across 7 files at wave time (a further 727 lines were workflow
paperwork — plan, intake, deviations, handoff — which the axis was told not to
review for code quality). Above threshold, so the axis ran.

Blast radius: empty. No changed TypeScript production source, so there are no
importers whose behavior could shift.

**11 findings, 11 accepted, 0 rejected.** Every one was verified against the
code before acting — several by reproduction, not by reading.

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 1 | BLOCKING | `carry` anchors recency on the INSTALLED intake's mtime, which `cp` stamps moments earlier — every legitimate carry refused | ACCEPT · fixed |
| 2 | MAJOR | doc-reading scan non-recursive and `src/__tests__` only; ≥5 doc-reading suites escape | ACCEPT · fixed |
| 3 | MAJOR | `stringLiterals` blind to JS regex literals; a doc path sharing a line is swallowed | ACCEPT · fixed |
| 4 | MAJOR | `--ps-source` fixture pids resolved with REAL `lsof` against the live machine | ACCEPT · fixed |
| 5 | MINOR | T5's narrowing unpinned at its production call site | ACCEPT · fixed |
| 6 | MINOR | matcher's `--include` filters pinned by nothing | ACCEPT · fixed |
| 7 | MINOR | intake claims a backslash title is handled; it is not | ACCEPT · fixed |
| 8 | MINOR | `arm-check.sh` repetitive jq type-probe scaffolding | ACCEPT · fixed |
| 9 | MINOR | source-text root assertion in the mutant-passing form | ACCEPT · fixed |
| 10 | MINOR | plan claims `arm-check.sh` got smaller; it grew 6 → 48 lines | ACCEPT · fixed |
| 11 | MINOR | 9th `--phase` cause wears the 8th's name; `\|\| true` swallows the fault message | ACCEPT · fixed |

## The three that were worth the whole wave

**#1 was my design error, and the suite proved the opposite of reality.** I
specified the recency anchor as the intake file's mtime without accounting for
`feature-setup.sh:75` copying that file immediately beforehand — `cp` stamps
mtime at copy time, so the intake is ALWAYS newer than a ladder written during
steps 0-1. Every legitimate carry was refused and the parent's real history
discarded. The suite missed it because its fixture BACKDATED the intake by 60s,
the exact inverse of production ordering, and because no test drove
`feature-setup.sh` end to end with a matching parent ladder. Both are now
fixed: the anchor is `$SRC` (author time), the inverted helper is replaced by
one that models real ordering, and the missing end-to-end test exists and was
proven non-vacuous — removing `--intake` reproduces the exact refusal line.

**#5 showed the T5 fix was unfalsifiable.** Reverting `mutation-runner.mjs`
line 567 to `findWatchers(processes.stdout, selfAncestry())` — undoing this
branch's entire watcher fix — left the suite 248/248 GREEN. A fix nobody can
fail is not yet a fix. After the pin, that reversion fails both named tests,
and two further probes pin the other directions: over-narrowing `processServes`
so it never matches (the false-GREEN direction) fails, and undoing the fixture
cwd lookup fails.

**#2 and #3 were the batch's own bug, inside the batch.** `ci.yml`'s rewritten
comment asserted "That is safe only because…", a safety property the guard did
not deliver; the plan claimed `arm-check.sh` got smaller when it grew by 42
lines. Fixing the code and leaving those claims standing would have shipped
exactly the defect the four tickets exist to remove.

## Rejected findings

None. Every finding was verified true before it was fixed.

## Named residuals — open, not closed

1. **Two doc-reading suites are deferred ON COST**, not covered:
   `scripts/ci/__tests__/red-team-status.test.ts` (71.1s) and
   `red-team-mutation-runner.test.ts` (122.1s). They read
   `docs/reviews/red-team/**/findings.json` and the red-team `SKILL.md`. Their
   `NOT_DOC_READING` reasons say so verbatim, a test enforces that wording, and
   both `ci.yml`'s `test`-job comment and `verify-gate.sh`'s banner name the
   gap. **A follow-up ticket is owed.**
2. **`gate-status.json` records `"mode":"full"` for a `--review` run.**
   `verify-gate.sh` only overrides `GATE_MODE` for `docs_only`, so the status
   file cannot distinguish a review-mode run from a plain one even though they
   differ by the `diff-coverage` row. Same class as this batch; not fixed here.

## The reclassify WARN, and why the estimate was NOT edited

The final gate is GREEN at `7818fa37e` with one WARN:

    RECLASSIFY: test 1250 > 2x estimated_test_lines (430)

Real numbers against the fork point:

| Bucket | Estimate | Actual | Ratio |
|---|---|---|---|
| Production | 250 | 450 | 1.8x — under the trigger |
| Tests | 430 | 1250 | 2.9x — over |

Production stayed within bounds; only the test bucket tripled. The growth is
attributable, not diffuse:

- `red-team-mutation-runner.test.ts` 432 lines, of which ~130 are a fixture
  MOVED verbatim into a shared builder — churn counted as +237/-145, not new
  coverage.
- `ci-audit-wiring.test.ts` 351 lines, most of it 18 excuse entries each
  carrying a prose reason. That is data, not logic.
- The rest is review-driven coverage the findings demanded: the pin that makes
  T5's fix falsifiable, the end-to-end carry test, the `--include` fixture, the
  regex-literal regression test.

**Step 0 re-run, as the trigger requires.** The lane is CONFIRMED, not revised:
the surface is 14 named files rather than top-level directories; it spans one
risk domain (tooling — no worker, ingress, migration, billing, approval or
auth); it decomposed into 5 tickets, not more than 8; and no investigation
questions remain. `standard · normal · backend` stands.

**The estimate was deliberately left alone.** Editing it to clear the row is
the failure `.claude/reference/arch-review-log.md` already records against
#1082 — an estimate inflated 35 → 90 → 250 "to keep the row green, which is the
measurement ceasing to measure". The WARN stays visible and is repeated in the
PR body instead.

## Round protocol

Round 1 only. `bash scripts/feature-state.sh branch-round-owed <sha>` decides
whether a verification round is owed after the fix commits.
