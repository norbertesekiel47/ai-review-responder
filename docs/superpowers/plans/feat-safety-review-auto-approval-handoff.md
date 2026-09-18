# Handoff — feat/safety-review-auto-approval

Written at the step 3 boundary, after plan round 1 (**REVISE**) was applied.
A resumed session bootstraps from this file. It never needs the prior transcript.

## Where to pick up

**Step 3, mid-gate. Plan revision 2 is written; the verification round is OWED
and not yet dispatched.**

`bash scripts/feature-state.sh contract-changed <plan.md>` answers **CHANGED** —
the round-1 fixes moved `allowed_edit_surface`, `tests_to_add` and the tracer
decomposition, so round 2 is not optional. Dispatch it, then triage its findings.
No implementation has started. No tracer has moved. Phase is `worktree_ready`.

## This run is NOT parked

Revision 1's handoff opened with un-park instructions. They are spent — the
arming copy is in place and `bash scripts/arm-check.sh` prints **ARMED**. If a
future session parks it again, park it the same way (`mv .feature/intake.json
.feature/intake.parked.json`) and say so here.

## Paths — read these, never a restatement of them

| What | Path |
|---|---|
| Locked intake (signed off, then corrected — D1, D4, D5, D8; amended — D6, D7) | `docs/superpowers/plans/feat-safety-review-auto-approval-intake.json` |
| Arming copy (byte-identical, verified) | `.feature/intake.json` |
| The plan, **revision 2** | `docs/superpowers/plans/feat-safety-review-auto-approval-plan.md` |
| Round-1 findings, 13 of them | `.feature/plan-round1-findings.md` |
| Round-1 raw transcript | `.feature/logs/plan-round1.jsonl` |
| The brief round 1 was given | `.feature/plan-round1-brief.md` |
| Deviations, D1–D8 | `docs/superpowers/plans/feat-safety-review-auto-approval-deviations.md` |
| Why the feature exists | `docs/runbooks/evidence/2026-09-17-provider-moderation-corpus.md` |
| Glossary owner for the new term | `docs/context/core-reviews-responses.md` |

## Codex session id — RESUME it, never start cold

```
01a0b34f-e1f1-7821-b28d-2815d54ec5b8
```

Rounds 2–3 RESUME this session (`codex exec resume <id> "<delta>"`). A
verification round checks whether its OWN findings were addressed, so round 1's
context is exactly what it needs, and a cold start pays about 1M input tokens to
rebuild it.

> **Revision 1 recorded the WRONG id** (`01a0b358-a8ec-7b52-9425-d534a7a24b2d`).
> That is an unrelated **Codex Desktop** session — `originator: "Codex Desktop"`,
> cwd `~/Documents/Codex/2026-09-18/new-chat`, CLI `0.154.0-alpha.6.2` — started
> at 00:08, after round 1 had already returned at 00:10 from a different thread.
> Resuming it would have anchored a verification round on a conversation that
> never saw this plan, and the round would have looked like it worked.
>
> The id above is taken from the transcript itself, which is the only place that
> cannot drift: `grep -oE '"thread_id":\s*"[a-f0-9-]+"' .feature/logs/plan-round1.jsonl`.
> **Re-derive it that way rather than trusting this line.** Note that
> `.feature/sessions` holds `c5bedad5-…`, which is a third id and is not the
> Codex thread either.

## What revision 2 changed

Plan § "What round 1 changed" is the authoritative map from each of the 13
findings to the tracer that now carries its fix. Do not restate it here. The
four structural changes worth knowing before reading the plan:

1. **A new T0** fixes `promised-tests` before anything measures anything.
2. **`tests_to_add` grew 20 → 44.** Every round-1 `MISSING FAILING TEST` is now
   a locked title. Three round-1 titles were removed or narrowed because they
   asserted something the code does not do — the circuit-breaker no-call title
   (D5 kept the fallback), the vacuous superset invariant (finding 4), and the
   unconditional spine-step title (finding 11).
3. **Finding 9 was fatal** and is now answered in T7 with explicit safety-mode
   layer semantics. Without it the plan could never reach `VERDICT: PASS`, so
   step 8's flag flip was unreachable.
4. **Two surface amendments**, owner-approved 2026-09-18, D6 and D7.
   `surfaceAmendments=2`.

## State of the run

- Phase `worktree_ready`. `planReviewRounds=1`; round 2 is owed and uncounted.
  Two rounds remain before feature.md's stop rule. RISK is **high**, so round 3
  escalates rather than decides-and-records.
- `PREVALIDATE: PASS` on revision 2 — 26 citations, 9 fixtures, 0 stale.
- All 44 locked titles appear verbatim in the plan. Re-check with the parity
  script in the run log if the plan is edited again.
- Enforcement ARMED. No surface overlap with other worktrees.
- Tracers registered, 0/7 done. T0 is new and is not yet in `progress.json`.

## Base branch — do not rebase onto main

This branch is cut from `feat/provider-moderation-corpus` (PR #1309, CI green,
**still OPEN** as of 2026-09-18). T7 extends `tests/llm-eval/moderation-*`, which
exist only there. The 2-commit drift behind `origin/main` is therefore expected,
not rot. If #1309 merges first, rebase onto `main` at that point and re-run the
gate — the fork point is not frozen until the step 7 wave dispatches.

## Baseline gate — RED on purpose, and why

`bash scripts/verify-gate.sh --baseline` was run at the revision-1 boundary to
prove the tree without advancing the phase. Result **RED**. All four red rows
are expected or environmental. None is a code defect — this branch has written
zero production lines.

| Row | State | Why |
|---|---|---|
| `promised-tests` | FAIL | Correct before T1. T1 IS the task that creates them. Note the count is now 44, and 10 of them live under `tests/` — which the gate could not see until T0. |
| `feature-surface` | FAIL | Two `allowed_edit_surface` entries match no file: `src/lib/moderation/safety-review.ts` and `safety-review-schema.ts`. They are the files T2 and T3 CREATE. Same class as `promised-tests`; both rows go green when those tracers land. |
| `rls-audit` | FAIL | Environmental. Static coverage PASSES (48 tenant tables enable RLS in migrations). The live check fails with "test DB provisioning incomplete or behind head". The parent checkout has no `TEST_DATABASE_POOL_URL` and so skips it and passes. **Fix at step 5: `pnpm test:db:setup`.** Not run at plan time because it drops schema `public` on the test DB and this feature is `db_touching: false`. |
| `reclassify` | WARN | **False trigger — do NOT re-run step 0 on it.** It diffs against `origin/main` while this branch is cut from the unmerged `feat/provider-moderation-corpus`, so it counts PR #1309's 3,566 insertions as this branch's. The number becomes honest once #1309 merges and this branch rebases. Re-check the trigger then; it is a real signal on a correct fork point. |

`.feature/gate-status.json` predates revision 2 and is therefore stale by
content as well as red by result. It is not evidence of anything except that the
tree was provable. Ignore `.feature/gate-fast.json` entirely.

## The two owner calls from round 1 — ANSWERED, already applied

Both contradicted signed-off intake fields, so they went to the owner. Both
answers are applied to BOTH intake copies (validated, byte-identical) and
recorded as deviations **D4** and **D5** with ACCEPT verdicts. A resumed session
does not need to re-ask.

- **Finding 6 → correct the wording only.** No runtime readiness gate is added.
  `rollback_plan` now states that readiness is an EXPANSION control and that the
  runtime lever is `AUTO_APPROVAL_ENABLED=false` plus a worker redeploy. The
  plan's closing section carries the same correction.
- **Finding 7 → keep the Anthropic fallback.** The `safety_review` descriptor
  retains `fallback`; only an all-attempts failure yields not-cleared. The
  accepted consequence is that production may answer from Anthropic while the
  corpus measured OpenAI, so **every verdict and every corpus row now records
  which provider answered**. That mitigation is written into T2, T3 and T7.

## The two surface amendments from revision 2 — ANSWERED, already applied

Owner-approved 2026-09-18. Recorded as **D6** and **D7**.

- **D6 — `src/__tests__/cost-guard-contract.test.ts`.** Forced, with no
  alternative: it is a tripwire that reads every production `runLlmTask` call
  site off disk and fails until the new caller is registered by name. The gate
  cannot be green without it.
- **D7 — `scripts/verify-gate.sh` + `scripts/ci/__tests__/*.test.ts`.**
  `promised-tests` greps `src worker scripts` only, so the corpus titles under
  `tests/llm-eval/` report missing even when they pass. The script's own header
  records the identical fix made once before for `scripts/` at #611. A separate
  PR off `main` was weighed and declined — this branch already waits on #1309,
  and a second unmerged dependency would block the gate on two PRs.

## What round 1 confirmed as sound

Not everything was rejected. Round 1 checked and upheld: the transaction
placement (the LLM call outside `sql.begin`), the lock ordering, and the
no-migration claim for the new run-spine step key. T6 now carries the test that
pins the first of those.
