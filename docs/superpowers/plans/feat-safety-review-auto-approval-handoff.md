# Handoff — feat/safety-review-auto-approval

A resumed session bootstraps from this file. It never needs the prior transcript.

## Where to pick up

**Step 7.5 — red-team round 2.** Everything before it is done and green.

| Step | State |
|---|---|
| 3 plan | 3 review rounds, all findings closed. Cap spent — **no round 4.** |
| 4 execute | 8/8 tracers |
| 5 gate | **GREEN at `f7d956aee`** (this file's own commit) — 34/35 PASS, 1 WARN |
| 6 deviations | D1–D14, every verdict ACCEPT |
| 7 review wave | **Round 1 closed REVISE.** 16 findings, all triaged, 14 ACCEPT / 2 REJECT, 0 open. Fixes applied and committed. |
| 7.5 red-team | **ROUND 2 OWED — this is the next action.** |
| 8 ship | not started |

## ⚠ THREE THINGS THAT WILL BITE YOU IN THE FIRST FIVE MINUTES

**1. DO NOT run `round-start`. Round 2 is ALREADY OPEN.**
```
round-start: round 2 open, 30 mutation runs available
```
It was opened at 2026-09-18 while checking status — `round-start` is a state
mutation, not a query. Calling it again resets the budget or refuses. The cap is
two rounds without an owner authorization, and both are now spent, so **a round
3 needs the owner.**

**2. The red-team sidecar does NOT exist yet, and round 1's measurements are
STALE.** Round 1 measured `9c4a1ab4a`; HEAD has moved past it because the wave's
accepted fixes landed. That staleness is expected — the skill says so explicitly:
"a round-2 finding whose fix touches the tree makes the sidecar stale by
construction." Round 2 exists to re-measure at the new HEAD.

**3. Round 1's raw results are on disk but GITIGNORED.**
`.feature/review-staging/red-team-raw.json` (41 KB) holds the full 61-row
inventory, the 11 kills, the 2 P0s and the duty 2–5 results. It survives only
inside this worktree. **Read it before dispatching round 2** — re-deriving that
inventory costs a full pass. The three axis reports are beside it and are also
committed under `docs/reviews/feat-safety-review-auto-approval/`.

## What round 2 must do

1. Re-measure the round-1 inventory at HEAD `f7d956aee`.
2. **Verify the fixes** listed under "What the wave found" below. Each names the
   mutant that must now die.
3. Report new findings **only inside the fix hunks and their directly affected
   callers.** Unrelated fronts against unchanged code stay forbidden.
4. **Four `it.each` titles are now selectable.** Round 1 could not measure them:
   the titles carried no format placeholder, so every case collected under one
   byte-identical full name and `vitest -t` (a regex over the full name) could
   not select a single test, which `assert-one-test` requires. Each gained
   `(%s)`. The branches this unblocks are load-bearing and were left unmeasured:
   - inversion 3 — the `LLMStructuredOutputError` branch inside the guarded
     callback, and the only `finalizeCost`/`releaseCost` assertions on the branch
   - the `typeof verdict.cleared === 'boolean'` guard
   - the mock-clearance gate case
   - the three structural skip cases
   - the mock/skipped corpus sources
5. The invoking agent runs `finalize`, never the subagent.
6. Write the sidecar to **`docs/reviews/red-team/feat-safety-review-auto-approval-5e21bf/`**
   (`findings.md` + `findings.json`, `schema: 1`). The checker computes that path
   itself; run it with no report to be told.

Pins for round 2:
```
FORK_SHA / MERGE_BASE = e0c3ceb1331dee7bf7eb92dc6128879c860b5805
HEAD_SHA              = f7d956aee585bea54298607d9f83646a0372c440
risk = high   mode = feature   round = 2
run_id = feature-feat-safety-review-auto-approval-5e21bf
```
`intake_sha256` — re-derive it, do not copy: the intake moved with amendment 7.

## What the wave found, and what the fix was

Four axes ran in ONE wave against `9c4a1ab4a`. All four returned REVISE.
Full reports: `docs/reviews/feat-safety-review-auto-approval/{spec-correctness,standards-maintainability,security}.md`.

### The two P0s — both reproduced by the root before fixing

| # | Defect | Fix, and the mutant that must now die |
|---|---|---|
| RT-01 | **Nothing pinned that the real verdict reaches the gate.** Threading a constant `{cleared:true}` in place of what `reviewSafety` returned left **2449 tests green** — the feature could be entirely disconnected. Exactly the claim the call-site file's own header made. | An **identity** assertion (`toBe`) on the threaded verdict, plus a null-threading test. Any structural assertion is satisfied by the constant; only identity kills it. |
| RT-02 | The `safety_reviewed` step **status** was unasserted; a constant `'completed'` survived. It is the value D12's `failedLabel: 'Held for you'` renders from. | Both halves asserted — `failed` for not-cleared, `completed` for cleared. |

### The high one — D14, and it was an error in the plan's own reasoning

A schema-refine rejection is a **provider FAILOVER, not a fail-closed block**.
`validateStructured` runs inside `attemptProvider`'s `try`, so a rejection
returns `{kind:'error'}`; with D5's fallback registered, Anthropic is asked the
same prompt fresh, **never told the primary named a threat**, and a
`{cleared:true, concern:null}` answer opens the auto-approval lane.

The schema comment asserted the opposite on the exact line the defect lived, and
three plan-review rounds read that sentence without tracing it.

Fixed by **derivation** — round-1 finding 2's other branch. `deriveSafetyVerdict`
computes `cleared = output.cleared && output.concern === null`, so a
contradiction becomes a not-cleared verdict with the concern preserved and no
failover can launder it. `deriveSafetyVerdict` and `FAILED_SAFETY_VERDICT` are
exported and shared with the corpus lane, which had re-spelled both.

### The rest

- **Missing test flag.** The only end-to-end not-cleared test omitted
  `OPENAI_MODERATION_ENABLED`, which all four sibling describes set, so
  `provider_moderation_disabled` blocked unconditionally and it passed for the
  wrong reason. The cleared case now genuinely reaches the auto-approve commit —
  which is itself the proof it had been masked.
- **Tier-blind skip.** `AUTO_APPROVAL_ENABLED` is global, so at go-live every
  Copilot draft would pay for the call and then be blocked by
  `autopilot_tier_required`. `tierGrantsAutopilot` added to the skip;
  mutation-checked.
- **Four spellings of one predicate**, one of which dropped `source === 'llm'`,
  so an outage row printed `flagged-by=safety_review`. Extracted `safetyFlagged`.
- **A vacuous test** — `not.toContain(REVIEW_TEXT)` for a string never passed in,
  against a type with no field to carry it. Rewritten to assert the prompt
  contains the draft and **no other input field**.
- **No alert path** for the fail-closed outage, while the intake names it as the
  signal to watch. Both halves added: `reportCaughtError` tagged
  `moderation/safety-review`, and **runbook rule 14**, thresholded at 20/hour
  because one not-cleared verdict is the check *working*.
- **18 line citations → symbol citations.** The checklist's own most-repeated
  accepted finding: the commit that writes a citation is the commit that moves
  its target.

### The two REJECTs, with reasons

- `disposition: string` rather than a union — the value is consumed by log
  search, not by code; no caller branches on it. Follow-up, not a deadline
  change on a high-risk branch.
- A leak canary that cannot fail, and a `toBeGreaterThan(0)` where the count is
  known — weak rather than wrong; neither can produce a false green about
  behaviour.

## Paths

| What | Path |
|---|---|
| Locked intake (7 amendments) | `docs/superpowers/plans/feat-safety-review-auto-approval-intake.json` |
| Arming copy (byte-identical) | `.feature/intake.json` |
| The plan, revision 3a | `docs/superpowers/plans/feat-safety-review-auto-approval-plan.md` |
| Deviations D1–D14 | `docs/superpowers/plans/feat-safety-review-auto-approval-deviations.md` |
| Plan-round findings 1–3 | `.feature/plan-round{1,2,3}-findings.md` |
| Wave axis reports | `docs/reviews/feat-safety-review-auto-approval/*.md` |
| Red-team round-1 raw (gitignored) | `.feature/review-staging/red-team-raw.json` |
| Review log | `.feature/review-transcript.jsonl` (`review-log.mjs render`) |
| ADR | `docs/adr/0032-safety-review-draft-only-input.md` |
| Glossary owner | `docs/context/core-reviews-responses.md` → **Safety review** |

## A trap this run hit THREE times — read before you commit anything

**A docs-only commit after a green gate silently invalidates the evidence, and
`feature-state.sh set-phase gate_green` then RELABELS `lastGreenGateSha` to the
new HEAD as if a gate had run there.** It does not re-run anything. The state
file ends up asserting a green gate at a SHA no gate ever saw, and nothing
downstream can tell the difference.

This happened three times on this run and was caught and corrected each time by
re-running the gate. The rule that prevents it: **run `set-phase gate_green`
only immediately after a gate that actually passed at the current HEAD**, and
if you commit anything afterwards — even one documentation line — either re-run
the gate or do not touch the phase.

## Reconciliation traps — all three are known, do not re-investigate

**1. The handoff's own prevalidate reports 2 stale commits. Both are false.**
`01a0b358` and `d534a7a24b2d` are hex fragments of the WRONG Codex session UUID
quoted in the note below; the prevalidator reads any 8+ hex run as a SHA. Do not
delete the note — it is why the right id is recorded.

**2. `reclassify` WARN is a fork-point artifact.** It diffs against `origin/main`
and counts PR #1309's 3,566 insertions as this branch's. This branch's own
production diff is ~950 lines against an estimate of 950. **Do not re-run step 0
on it.** Re-check once #1309 merges.

**3. After the eventual rebase, RE-PROVISION the test DB.** `origin/main` is 2
ahead and one commit is **migration 122**. This worktree is at 121, and live-DB
suites `assertSchemaReady` rather than migrating, so run `pnpm test:db:setup`
before reading anything into a gate result.

## Codex session id — RESUME it, never start cold

```
01a0b34f-e1f1-7821-b28d-2815d54ec5b8
```

Re-derive rather than trust this line:
`grep -oE '"thread_id":\s*"[a-f0-9-]+"' .feature/logs/plan-round1.jsonl`

> Revision 1 recorded `01a0b358-a8ec-7b52-9425-d534a7a24b2d`, which is an
> unrelated **Codex Desktop** session (`originator: "Codex Desktop"`, cwd
> `~/Documents/Codex/2026-09-18/new-chat`). Resuming it would have anchored a
> verification round on a conversation that never saw this plan — and it would
> have looked like it worked. `.feature/sessions` holds a third id that is not
> the Codex thread either.

## Base branch — do not rebase onto main

Cut from `feat/provider-moderation-corpus` (PR #1309, **still OPEN**). T7 extends
`tests/llm-eval/moderation-*`, which exist only there. The 2-commit drift behind
`origin/main` is expected, not rot. Once the review wave has opened, a rebase
voids the gate result, the fingerprint and the red-team sidecar together — so
**do not take main now.** If #1309 merges, finish 7.5 first.

## After 7.5

1. Final gate as the LAST serialized step, then the `reviewed` transition
   (`red-team-status.mjs` must exit 0).
2. Draft PR (`gh pr create --draft` — draft PRs run no CI), then `gh pr ready`.
   The PR description must carry a **"Red-team findings rejected"** section for
   the two REJECTs above; a silent skip is forbidden.
3. **The live corpus runs are the real go-live gate and are NOT done.**
   `pnpm eval:llm --live --moderation-corpus --with-safety-review --env staging`
   then production, each `--out` into a dated evidence doc. The doc must state
   which provider answered each row (D5) — the run prints
   `safetyProviders=openai xN, anthropic xN`.
4. **Only on `VERDICT: PASS` in BOTH** does
   `AUTO_APPROVAL_PROVIDER_MODERATION_READY` flip, via the `flag-flip` skill,
   staging first.

`AUTO_APPROVAL_ENABLED` is **not** flipped by this work. Readiness is an
EXPANSION control, not a runtime kill switch — the runtime rollback is
`AUTO_APPROVAL_ENABLED=false` plus a worker redeploy (D4).
