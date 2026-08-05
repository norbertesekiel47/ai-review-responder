# Handoff — feat-674-import-review-no-generation

**Checkpoint:** step 3→4 boundary (plan locked, execution not started).
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation`
**Branch:** `feat-674-import-review-no-generation` · **HEAD at checkpoint:** `d1f4e184`
**Phase file:** `.feature/state.json` → `plan_approved`, `planReviewRounds=3`

A resumed session bootstraps from this file and reads the artefacts below. It
does **not** need the prior transcript.

## Read these, in order

| Artefact | Path |
|---|---|
| Intake contract (arming copy) | `.feature/intake.json` |
| Intake contract (committed audit copy) | `docs/superpowers/plans/feat-674-import-review-no-generation-intake.json` |
| Implementation plan (4 tasks, full code) | `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md` |
| Deviations (D1–D9, all pending step-6 verdicts) | `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md` |
| Design of record (epic level) | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` |
| Plan review reports | `docs/reviews/feat-674-import-review-no-generation/plan-round-{1,2,3}.md` |
| Glossary | `CONTEXT.md` — **Review import** is added by plan Task 3, not yet present |

Ticket [#674](https://github.com/RepWorth/ai-review-responder/issues/674),
map [#667](https://github.com/RepWorth/ai-review-responder/issues/667).

## State

- **Classification:** RISK=high · SURFACE=backend · SIZE=normal. Full pipeline, staging ride before `main`.
- **Commits so far:** `c0cd0ad8` (docs + spec), `d1f4e184` (round-2 revisions). **No implementation code yet.**
- **Gate:** last run GREEN at `c0cd0ad8` in `docs_only` mode. That mode skips test/build/promised-tests/diff-coverage, so it is **not** review-ready evidence — re-run `scripts/verify-gate.sh` after Task 2, and `--review` before step 7.
- **Amendment budget: EXHAUSTED (2 of 2).** See deviations D8. A third `allowed_edit_surface` change during implementation MUST trigger the step-5 abort path — that decision was already reasoned around once and must not be again.
- **Plan review rounds: 3 of 3 used.** Round 1 `REVISE`, round 2 `REVISE`, round 3 dispatched at checkpoint (codex session `019fd129-092f-7e93-8409-854489caac01`). **If round 3 returned `REVISE`, do not run a round 4** — surface both positions to the owner; their call substitutes for `APPROVED`.

## Next action

Step 4. Set phase (`bash scripts/feature-state.sh set-phase executing`), then
dispatch per-task subagents via `subagent-driven-development`:

1. **Task 1 runs ALONE** (eval — the failing tests). After it completes, diff
   `git status --porcelain` against `allowed_edit_surface`; an out-of-surface
   file means enforcement did not bind for subagent tool calls — STOP and report.
2. **Tasks 2 and 3** are mutually independent (disjoint file sets) — may run concurrently.
3. **Task 4** is blocked by Task 2.

Each subagent prompt must carry the CONTEXT.md glossary excerpt, the task's spec
slice, its blocking-edge context, the `existing_patterns_to_follow` paths, and
the failing tests it turns green.

## Things a resumed session will otherwise get wrong

- **Do not fix the cross-lane lost-draft race** (deviations D4, plan "Hazards").
  It is a real defect, deliberately deferred to #675 by owner decision. File it
  as a comment on #675 at ship time.
- **Do not refactor the existing `describe('processReview')` test block.** Its
  being byte-for-byte untouched is this ticket's regression evidence. The single
  permitted shared-harness edit is adding `completeRun` to the module-scope
  run-spine mock factory.
- **`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts` is not a
  live-DB suite** despite the name — it mocks `sql` and mocks `process-review`
  wholesale. It proves nothing about this change (deviations D7). The real
  evidence is plan Task 4's new suite.
- **`db_touching: true`** — the gate provisions the test DB itself. Never put
  `pnpm test:db:setup` in `verification_commands`.
- A `SKIP` on the Task 4 integration suite is a **failure**, not a pass: it means
  `TEST_DATABASE_POOL_URL` was unset and the keystone's SQL was never executed.

## Open at ship time (step 8)

- Comment the D4 hazard on #675.
- Comment on map #667 that `CONTEXT.md` has no **Origin lane** entry, which the
  map's reuse note #2 cites and #678 depends on.
- Promote durable lessons from the deviations file into
  `.claude/reference/lab-notes.md` (candidates: the zernio suite's misleading
  `.integration.` name; the run-spine stall for runs with no downstream completer).
