# Red team — feat/safety-review-auto-approval (round 2)

| | |
|---|---|
| Run | `feature-feat-safety-review-auto-approval-5e21bf` · mode `feature` · round **2** · risk **high** |
| Fork / merge-base | `e0c3ceb1331dee7bf7eb92dc6128879c860b5805` |
| HEAD measured | `6a787c037d767dfa5af79ef2450766e02996c785` |
| Intake SHA-256 | `3841dd8f03a6661a340257da094baf685e86fc39715fc8230d8cc93e94e9c724` |
| Generated | 2026-09-18T13:19:53.077Z |
| **Status** | **INCOMPLETE_ORACLE** |

Round 2 verifies the fixes commit `41160a59b` applied after round 1, and may raise new
findings inside those fix hunks and their directly affected callers. Unrelated fronts
against unchanged code are out of scope and none were opened.

## Budget

**30 of 30 supervised launches spent.** 12 green baselines, 16 mutant runs on a named
candidate, and 2 whole-file mutant runs used as negative searches (recorded as such).
Two launches (4 and 5) were spent on the wrong candidate — the RT-02 status assertion
lives in the *step* test, not the persistence test — and are counted as spent. Every
launch ran under the isolated allowlist environment with a scrubbed dotenv swap and a
validated localhost `TEST_DATABASE_POOL_URL` (docker `repworth-testdb-recovery-20260914`,
migrations head 121), so round 1's live-DB `infra` blocker no longer applies.

## Counts

| Metric | Value |
|---|---|
| `inventory_total` | 74 |
| `killed` | 22 |
| `survived_confirmed_p0` | 1 |
| `equivalent` | 0 |
| `inconclusive` | 2 |
| `skipped_budget` | 49 |
| `excluded` | 0 |
| `findings_total` | 15 |
| `p0_open` | 0 |
| `p1_open` | 6 |
| `p2_open` | 1 |
| `accepted_risk` | 0 |
| `fixed` | 6 |
| `rejected` | 2 |

`counts` and `status` are recomputed by `red-team-status.mjs`; the values above are that
script's output, not hand-written.

## Fix verification — did each named mutant die?

| Fix | Named mutant | Result |
|---|---|---|
| RT-01 identity threading | constant `{cleared:true,…}` in place of the real verdict | **KILLED** |
| RT-01 null threading | bare `null` in place of the real verdict | **KILLED** |
| RT-02 not-cleared half | `status:` constant `'completed'` | **KILLED** |
| RT-02 cleared half | `status:` constant `'failed'` | **KILLED** |
| D14 (high) | drop `&& output.concern === null` from `deriveSafetyVerdict` | **KILLED** |
| D14 regression | restore the `.refine()` contradiction rejection onto the schema | **KILLED** |
| Masked test (not-cleared) | delete the safety row from the auto-approval gate | **KILLED** |
| Masked test (cleared) | gate always emits `safety_review_not_cleared` | **SURVIVED** → RT-10 |
| Draft-only prompt | interpolate `input.accountId` into the prompt | **KILLED** |
| `safetyFlagged` | drop `&& safety.source === 'llm'` | **SURVIVED** → RT-11 |
| Tier-blind skip | drop `&& tierGrantsAutopilot(ctx.subscriptionTier)` | **KILLED** |

## The four newly selectable `it.each` titles

Each gained a `(%s)` placeholder, so `vitest -t` can now select one case and
`assert-one-test` is satisfiable. All four round-1 `inconclusive/infra` rows are resolved.

| Row | Branch it unblocked | Mutant | Result |
|---|---|---|---|
| `rt-A11` | inversion 3 — the `LLMStructuredOutputError` branch inside the guarded callback, and the only `finalizeCost`/`releaseCost` assertions on it | let the error escape the guarded callback | **KILLED** |
| `rt-B04` | the `typeof verdict.cleared === 'boolean'` guard | drop that conjunct | **KILLED** |
| `rt-B04` | the mock-clearance gate case | `verdict?.source === 'llm'` → `verdict != null` | **KILLED** |
| `rt-C03` | the three structural skip cases | drop `isAutoApprovalCandidate(…)` from the skip predicate | **KILLED** |
| `rt-E07` | the mock/skipped corpus sources | narrow the `safety_error` gate to `source === 'failed'` | **KILLED** |

## Findings

| ID | Sev | Duty | Disposition | Where | Title |
|---|---|---|---|---|---|
| RT-01 | P0 | 1 | `fixed` | `worker/jobs/ResponseGeneratorWorker.ts:172` | No changed test pinned that the REAL safety verdict reaches the gate — a worker that hands persist an unconditional clearance was green |
| RT-02 | P0 | 1 | `fixed` | `worker/jobs/response-generation/persist.ts:552` | The safety_reviewed spine step's status was unasserted — 'failed' could become 'completed' with every test green |
| RT-03 | P1 | 2 | `fixed` | `src/lib/moderation/__tests__/safety-review.test.ts:147` | Vacuous negative assertion: the ADR 0032 'never the review text' claim was not pinned by any input |
| RT-04 | P1 | 3 | `fixed` | `src/lib/agents/run-spine.ts:66` | Seven stale path:line citations in the change's own code comments |
| RT-05 | P1 | 1 | `fixed` | `src/components/dashboard/timeline/step-facts.ts:58` | Uncovered change: the new STEP_COPY entry and STEP_PERSONA entry had no falsifiable test |
| RT-06 | P1 | 1 | `open` | `tests/llm-eval/run.ts:287` | Uncovered change: the --with-safety-review CLI wiring and the new report printing still have no covering test |
| RT-07 | P1 | 5 | `fixed` | `src/lib/moderation/safety-review.ts:292` | Duty 5: the fail-closed safety-review outage had NEITHER half of an alert path |
| RT-08 | P2 | 2 | `rejected` | `worker/jobs/response-generation/__tests__/persist.test.ts:1731` | Leak canary that cannot fail against the current structure |
| RT-09 | P2 | 2 | `rejected` | `tests/llm-eval/__tests__/moderation-corpus.test.ts:472` | Loose count where the exact value is known |
| RT-10 | P1 | 2 | `open` | `worker/jobs/response-generation/__tests__/persist.test.ts:1734` | The cleared test's `autoApprove: true` does not pin that a cleared verdict reaches the auto-approve commit — the comment's central claim is unasserted |
| RT-11 | P1 | 1 | `open` | `tests/llm-eval/moderation-runner.ts:106` | The restored `source === 'llm'` clause in the extracted safetyFlagged helper is falsified by no test in the corpus lane |
| RT-12 | P2 | 2 | `open` | `src/lib/moderation/__tests__/safety-review.test.ts:158` | The RT-03 rewrite retained two assertions that still cannot fail for any implementation |
| RT-13 | P1 | 3 | `open` | `docs/reviews/feat-safety-review-auto-approval/security.md:32` | An unresolvable path:line citation in the security review report the fix commit added |
| RT-14 | P1 | 5 | `open` | `docs/runbooks/beta-launch-alerting.md:460` | Duty 5 facet contradiction: rule 14 documents level `warning`, but the emitted signal is captureException at level `error` |
| RT-15 | P1 | 3 | `open` | `worker/jobs/ResponseGeneratorWorker.ts:142` | The security axis finding was applied by half — the star-rating pre-filter it also names has no recorded disposition |

### RT-01 — No changed test pinned that the REAL safety verdict reaches the gate — a worker that hands persist an unconditional clearance was green

**P0** · duty 1 · `worker/jobs/ResponseGeneratorWorker.ts:172` · disposition `fixed`

FIXED, confirmed by mutation in round 2. worker/__tests__/safety-review-call-site.test.ts:207 now asserts IDENTITY (`expect(persistMock.mock.calls[0][1].safetyVerdict).toBe(verdict)`), with a partial mock of the persist module so real persistence still runs. Round-2 launches 1-3 (row rt-C05): green baseline, then M20 (the round-1 survivor — an unconditional {cleared:true,concern:null,source:"llm",provider:null} in place of the threaded verdict) FAILED the test, and M21 (a bare `null`) FAILED it too. Both named mutants die. Note that the round-1 candidate rt-C01 (the ordering test) still does not kill them; the fix added a new candidate rather than strengthening that one.

**Arbiter confirmation.** Carried from round 1, for the row that still holds the outcome (rt-C01, the ordering test). The branch IS executed: primeContext() makes the draft an auto-approval candidate with unflagged moderation, so the mutated expression is evaluated and its value is handed to the REAL persistResponseAndNotify (persist was not mocked in that file at the time). The mutation is not equivalent and is semantically maximal — it discards the model's verdict at the only seam that carries it, so a cleared:false draft would reach the auto_policy gate as cleared. The covering set was re-derived by reverse import search and none of safety-review-call-site.test.ts, persist.test.ts, auto-approval.test.ts or the pre-existing ResponseGeneratorWorker.test.ts read the verdict handed to persist. Round 2 confirms the mutant now dies against the NEW candidate rt-C05; rt-C01 itself is unchanged and still does not kill it, which is why the row keeps its outcome.

### RT-02 — The safety_reviewed spine step's status was unasserted — 'failed' could become 'completed' with every test green

**P0** · duty 1 · `worker/jobs/response-generation/persist.ts:552` · disposition `fixed`

FIXED, both halves confirmed by mutation in round 2. persist.test.ts now asserts `toMatchObject({ status: 'failed' })` on the not-cleared case and adds a cleared case asserting `status: 'completed'`. Launches 6-7 (row rt-D02): green baseline, then M22 (`status: 'completed'` constant — the round-1 survivor) FAILED the test. Launches 8-9 (row rt-D06): green baseline, then M24 (`status: 'failed'` constant) FAILED the test. Neither constant survives now.

### RT-03 — Vacuous negative assertion: the ADR 0032 'never the review text' claim was not pinned by any input

**P1** · duty 2 · `src/lib/moderation/__tests__/safety-review.test.ts:147` · disposition `fixed`

FIXED, confirmed by mutation. The test now iterates every field of INPUT other than draftText and asserts the serialized prompt contains none of them. Launches 18-19 (row rt-A04): green baseline, then M30 interpolated `input.accountId` into the prompt built at safety-review.ts:195 — exactly the shape a "give the model more context" change would take — and the test FAILED. Two vacuous lines were RETAINED as canaries and are recorded separately as RT-12.

### RT-04 — Seven stale path:line citations in the change's own code comments

**P1** · duty 3 · `src/lib/agents/run-spine.ts:66` · disposition `fixed`

FIXED and re-verified at HEAD 6a787c037. A sweep of every .ts/.tsx file changed on this branch for the pattern `[A-Za-z0-9_/.-]+\.(ts|tsx):[0-9]+` returns ZERO matches — all 18 line citations became symbol citations and none regressed. prevalidate-plan.py also passes clean on the plan (32 citations), the deviations file (8) and ADR 0032. A NEW unresolvable citation appeared in one of the review-wave reports the fix added; that is RT-13, not a regression of this one.

### RT-05 — Uncovered change: the new STEP_COPY entry and STEP_PERSONA entry had no falsifiable test

**P1** · duty 1 · `src/components/dashboard/timeline/step-facts.ts:58` · disposition `fixed`

FIXED by inspection, NOT by mutation — stated plainly because the distinction matters. src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx (new, 4 cases) asserts the label literally (`toBe('Safety review')`), asserts it differs from the moderation_checked label, asserts `stepStatusLabel({stepKey:'safety_reviewed', status:'failed'})` is `Held for you`, asserts the completed case yields null, and asserts `STEP_PERSONA.safety_reviewed` is `'system'` directly rather than through the tautological Object.entries loop. These are value assertions that a changed constant would fail. The four covering rows rt-L01..rt-L04 are `skipped-budget`: the 30-launch budget did not reach them.

### RT-06 — Uncovered change: the --with-safety-review CLI wiring and the new report printing still have no covering test

**P1** · duty 1 · `tests/llm-eval/run.ts:287` · disposition `open`

PARTIALLY addressed. The fix moved `summariseProviders` out of run.ts into moderation-runner.ts as the exported `summariseSafetyProviders` and gave it two cases (rows rt-E14, rt-E15) — a real improvement, because the function is now reachable by a test at all. The REST of the hunk is unchanged in coverage: tests/llm-eval/__tests__/run.test.ts is not in the branch diff, and grep over it for `--with-safety-review`, `printModerationReport`, `assertSafetyModeEnvironment` and `makeCorpusSafetyReview` returns zero hits. The safety-mode CLI entry point — including the assertSafetyModeEnvironment call ordering that deviation D3 exists for — is still exercised only through the runner functions, never through the command an operator actually runs. Row rt-K03 stays inconclusive/oracle.

### RT-07 — Duty 5: the fail-closed safety-review outage had NEITHER half of an alert path

**P1** · duty 5 · `src/lib/moderation/safety-review.ts:292` · disposition `fixed`

FIXED. Both halves now exist: the emitting half is `reportCaughtError('moderation/safety-review', err, { correlation_id })` in reviewSafety's outer catch (safety-review.ts:292), and the documented half is rule 14 in docs/runbooks/beta-launch-alerting.md:456-470, with a 20-events-in-1-hour threshold, a 60-minute per-issue throttle, a named destination and an operator action. Two new tests (rows rt-A18, rt-A19) assert that an outage reports and that a model-judged block does not. One of the six facets CONTRADICTS the emitted signal; that is recorded separately as RT-14.

### RT-08 — Leak canary that cannot fail against the current structure

**P2** · duty 2 · `worker/jobs/response-generation/__tests__/persist.test.ts:1731` · disposition `rejected`

REJECTED by the review-wave triage: weak rather than wrong — a canary against a future widening of `detail` cannot produce a false green about behaviour. Evidence at HEAD: worker/jobs/response-generation/__tests__/persist.test.ts:1731 `expect(JSON.stringify(steps[0])).not.toContain(RESULT.responseText)`, against a `detail` built from four scalar verdict fields at worker/jobs/response-generation/persist.ts:553-558. Verdict recorded at docs/superpowers/plans/feat-safety-review-auto-approval-handoff.md:138-145.

### RT-09 — Loose count where the exact value is known

**P2** · duty 2 · `tests/llm-eval/__tests__/moderation-corpus.test.ts:472` · disposition `rejected`

REJECTED by the review-wave triage under the same verdict as RT-08: weak rather than wrong; it cannot produce a false green about behaviour. Evidence at HEAD: tests/llm-eval/__tests__/moderation-corpus.test.ts:472 `expect(report.safetyInjectionMisses).toBeGreaterThan(0)` where the same test loads the full injection set. Verdict recorded at docs/superpowers/plans/feat-safety-review-auto-approval-handoff.md:138-145.

### RT-10 — The cleared test's `autoApprove: true` does not pin that a cleared verdict reaches the auto-approve commit — the comment's central claim is unasserted

**P1** · duty 2 · `worker/jobs/response-generation/__tests__/persist.test.ts:1734` · disposition `open`

The masked-test fix itself IS verified: launch 11 mutated the gate to drop the safety row entirely (`...safetyReviewBlockReasons(input.safetyVerdict)` -> `...[]` at auto-approval.ts:368) and the end-to-end not-cleared test at persist.test.ts:1696 FAILED — before the fix, the commit message records that same deletion leaving the describe green, so OPENAI_MODERATION_ENABLED was indeed masking it and no longer does. What is NOT pinned is the cleared direction. Launch 10 mutated safetyReviewBlockReasons to return ['safety_review_not_cleared'] unconditionally (auto-approval.ts:426) and the cleared test at :1734 PASSED. `queuePersistRows({ autoApprove: true })` is a row SUPPLY, not an assertion: the fallback path consumes fewer rows, so a leftover queue raises nothing. The test's own comment claims the opposite — that `autoApprove: true` is there because a cleared verdict now genuinely reaches the auto-approve commit — and nothing in that describe would fail if it stopped being true. Behavioural replacement: assert the auto-approve side effects on the cleared case the way the not-cleared case asserts their absence (an approval audit row and a publish outbox row, via the existing txTexts() helper).

**Arbiter confirmation.** Recorded as a Duty-2 finding rather than as row rt-D06's outcome, deliberately. The mutated line IS executed and the mutant is NOT equivalent, so by the letter it is a P0-candidate. But rt-D06's asserted behaviour is the spine step's status, which persist.ts computes from `safetyVerdict.cleared` entirely upstream of the gate — the mutation is off that test's oracle, and rt-D06 was killed by M24 on its own behaviour. The gate predicate itself is separately covered: auto-approval.test.ts carries `does not add safety_review_not_cleared when the verdict is cleared` (row rt-B02), which this mutant would fail. Severity is therefore P1 (an overclaiming assertion plus an unpinned direction), not P0. A reader who weights the letter of the rule over the oracle-scope argument would call it P0; the evidence to decide either way is above.

### RT-11 — The restored `source === 'llm'` clause in the extracted safetyFlagged helper is falsified by no test in the corpus lane

**P1** · duty 1 · `tests/llm-eval/moderation-runner.ts:106` · disposition `open`

The fix consolidated four spellings of one predicate into `safetyFlagged`, restoring the `&& safety.source === 'llm'` clause that one copy had dropped — its docstring states the defect it repairs: an OUTAGE row reported flagged-by=safety_review. Nothing pins the repair. Launch 16 dropped that clause and the most-covering case — `fails the safety-review corpus when an unsafe row receives source=failed instead of a model judgment` (row rt-E05), which supplies exactly a not-cleared source:'failed' verdict — PASSED. Launch 17 then ran the ENTIRE file under the same mutant: 39 cases, 0 failures. The reason is structural: the `safety.source !== 'llm'` check at moderation-runner.ts:127 short-circuits an outage row to `safety_error` before any label branch, so `outcome` and `verdict` are unchanged; the only thing the mutant changes is `flaggedBySafetyReview` on the emitted result, and no case asserts that field false. grep for `flaggedBySafetyReview` in moderation-corpus.test.ts returns exactly one assertion, `toBe(true)` at :342. Behavioural replacement: on the outage case, assert `report.results[0].flaggedBySafetyReview` is false and `caughtBy` is null. This is release-gate EVIDENCE (the `llm-eval` job is a required check), so a silent regression would make a recorded corpus run attribute a catch to a layer that was down.

### RT-12 — The RT-03 rewrite retained two assertions that still cannot fail for any implementation

**P2** · duty 2 · `src/lib/moderation/__tests__/safety-review.test.ts:158` · disposition `open`

safety-review.test.ts:158 `expect(Object.keys(INPUT)).not.toContain('reviewText')` asserts a property of a test-local object literal declared at :65 — it is an assertion about the FIXTURE, not about production code, and no change to safety-review.ts can make it fail. :159 `expect(serialized).not.toContain(REVIEW_TEXT)` is the original RT-03 line, retained: REVIEW_TEXT is still never passed to reviewSafety and ReviewSafetyInput still has no field to carry it. Recorded, not blocking, and consistent with the RT-08/RT-09 REJECT verdict (weak rather than wrong): the falsifiable half of the test now exists and was proven to kill M30, so the vacuous lines no longer stand alone. Removing :158 and keeping :159 as a documented canary would be the tidy end state.

### RT-13 — An unresolvable path:line citation in the security review report the fix commit added

**P1** · duty 3 · `docs/reviews/feat-safety-review-auto-approval/security.md:32` · disposition `open`

prevalidate-plan.py over the eight changed/added docs reports one genuine unresolved citation: `operator/policy-state.ts:251` — no such path exists at HEAD. The SUBSTANCE of the claim is TRUE and was hand-verified: the file is src/lib/agents/operator/policy-state.ts, line 251 is the `WHERE ar.account_id = ...` predicate and :256 is `AND s.step_key = ${INITIAL_MARKER_STEP}::text`, so the reader's claim (account-scoped, filters a different step_key) holds. Only the path prefix is missing, which is the round-1 RT-04 class and the same P1 severity — a stale coordinate, not a false claim. Every other citation in that file resolves (31 checked), as do spec-correctness.md (31), standards-maintainability.md (52), the plan (32) and the deviations file (8). The handoff's two stale-commit hits (01a0b358, d534a7a24b2d) are the KNOWN false positive — hex fragments of a quoted Codex session UUID, documented at handoff line 179 — and are not reported.

### RT-14 — Duty 5 facet contradiction: rule 14 documents level `warning`, but the emitted signal is captureException at level `error`

**P1** · duty 5 · `docs/runbooks/beta-launch-alerting.md:460` · disposition `open`

Six-facet comparison of rule 14 against the signal it describes. MATCH on four: signal identity (`reportCaughtError`, tag `endpoint` = `moderation/safety-review` — src/lib/shared/report-caught-error.ts calls `captureException(error, { tags: { endpoint } })`), filter, grouping (no custom fingerprint is set), and destination (Discord integration 443670, the same id all four rules in this runbook use). CONTRADICTION on level: the runbook's Level column says `warning`, but `captureException` records an exception at Sentry's default `error` level and nothing overrides it — worker/sentry.ts:12's `beforeSend` only calls `scrubSentryEvent` and never touches `level`. The two sibling rules that emit through the identical helper, rule 12 (:440) and rule 13 (:450), both correctly document `error`, so the correct value is established four lines away. An alert rule saved from this row with a `level:warning` condition would match nothing, which is the silent-failure mode the rule exists to prevent. TWO secondary observations on the same comparison: (a) the Level/grouping column also says the context carries `correlation_id` and the error kind only, but the `context` argument is passed to the structured LOG line, not to the Sentry event — the event carries only the `endpoint` tag and the exception (the Operator-action paragraph gets this right and points at the log); (b) threshold and grouping interact — 20 events in 1 hour is evaluated per ISSUE, while default exception-stack grouping will split a fail-closed storm across as many issues as there are distinct error types reaching that catch (provider failures, CostInfraUnavailableError, audit-write failures), so a mixed outage may never reach 20 in any single issue. Neither half of the alert path is missing; the documented facets need correcting before the rule is configured.

### RT-15 — The security axis finding was applied by half — the star-rating pre-filter it also names has no recorded disposition

**P1** · duty 3 · `worker/jobs/ResponseGeneratorWorker.ts:142` · disposition `open`

Security finding S3 (docs/reviews/feat-safety-review-auto-approval/security.md:18) and spec finding F1 both name TWO cheap pre-LLM discriminators already in hand before the transaction: `ctx.subscriptionTier` AND `ctx.starRating`. The fix applied only the tier half (`&& tierGrantsAutopilot(ctx.subscriptionTier)` at :142, measured and killed this round as row rt-C07). The rating half is not applied, and grep over the deviations file (D1-D14), the handoff's ACCEPT list and its two recorded REJECTs finds no entry for it — so a later session cannot tell whether it was decided or overlooked, which is the condition the project's own accepted-findings checklist calls out and which the handoff states as a rule (a silent skip is forbidden). The concrete scenario S3 records is unchanged by the tier fix: a burst of one-star reviews at an AUTOPILOT business each buys a paid safety_review call plus a 1c reservation, every verdict then discarded by `rating_below_positive_quadrant`, with `withConcurrency: false` removing the per-business concurrency slot. `ctx.starRating` exists at worker/jobs/response-generation/load-context.ts:213. Not a correctness defect — a skip is fail-safe in both directions — so this is an adjudication item, not a blocker on the code.

## Red-team findings rejected

Two findings were rejected by the review-wave triage; the verdicts and `file:line`
evidence are in RT-08 and RT-09 above, and both must appear in the PR description.

- **RT-08** — `worker/jobs/response-generation/__tests__/persist.test.ts:1731`: a leak canary that cannot fail against the current structure. Weak rather than wrong; it cannot produce a false green about behaviour.
- **RT-09** — `tests/llm-eval/__tests__/moderation-corpus.test.ts:472`: `toBeGreaterThan(0)` where the exact count is known. Same verdict.

## Duty 2 — fragile assertions in the fix hunks

Scanned every assertion added or changed by `41160a59b`. Three raised:

- **RT-10** — an overclaiming rationale: `queuePersistRows({ autoApprove: true })` supplies rows, it does not assert the auto-approve commit was reached.
- **RT-12** — two retained assertions in the rewritten draft-only test that cannot fail for any implementation.
- Considered and NOT raised: `expect(summariseSafetyProviders(report)).toBe('openai x1, anthropic x1')` looks like an order assertion with no ordering contract, but `Map` iteration order is specified as insertion order and insertion order follows the corpus row order the test itself supplies, so the value is determinate. `expect(copy.explain).not.toBeNull()` is weak but sits beside two literal value assertions in the same case.

## Duty 3 — docs vs reality

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py <doc> --repo .` run
against every changed or added doc, at HEAD `6a787c037`:

| Doc | Citations | Result |
|---|---|---|
| `docs/superpowers/plans/feat-safety-review-auto-approval-plan.md` | 32 | PASS |
| `docs/superpowers/plans/feat-safety-review-auto-approval-handoff.md` | 0 (3 commits) | 2 hits, **known false positive**, not reported |
| `docs/superpowers/plans/feat-safety-review-auto-approval-deviations.md` | 8 | PASS |
| `docs/adr/0032-safety-review-draft-only-input.md` | 0 | PASS |
| `docs/reviews/feat-safety-review-auto-approval/security.md` | 31 | **1 unresolved** → RT-13 |
| `docs/reviews/feat-safety-review-auto-approval/spec-correctness.md` | 31 | PASS |
| `docs/reviews/feat-safety-review-auto-approval/standards-maintainability.md` | 52 | PASS |
| `docs/runbooks/beta-launch-alerting.md` | 0 | PASS |

The handoff's `01a0b358` and `d534a7a24b2d` are hex fragments of a quoted Codex session
UUID, not SHAs — the handoff documents this itself at line 179. Not reported.

**RT-04's conversion held.** Sweeping every `.ts`/`.tsx` file changed on this branch for
`[A-Za-z0-9_/.-]+\.(ts|tsx):[0-9]+` returns **zero** matches: all 18 line citations became
symbol citations and none regressed. RT-15 records a separate docs-vs-reality gap — a
review finding applied by half with no recorded disposition.

## Duty 4 — missed sibling cases

| Fixed pattern | Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|---|
| D14: a cross-field `.refine()` on an LLM output schema, where a rejection is a provider FAILOVER | `\.refine\(` then cross-referenced against the `outputSchema` entries of `LLM_TASKS` | `src/lib/**` | `**/__tests__/**` | **Zero siblings.** The five registered schemas are `TriageOutputSchema`, `SafetyReviewOutputSchema`, `JudgeOutputSchema`, `SolicitationAskOutputSchema`, `OperatorModelOutputSchema`; none carries a `.refine`. The nine hits in `src/lib/shared/schemas.ts` are HTTP input schemas and `src/lib/agents/operator/schema.ts:511` is `PolicyConsequenceSchema`, a STORAGE schema — neither is model output. |
| RT-02: a spine step `status` written as a ternary | `status: .*\? '(completed\|failed)' : '(completed\|failed)'` | `worker/`, `src/lib/` | `**/__tests__/**` | **Two siblings, both already covered.** `persist.ts:535` (`moderation_checked`) is asserted both ways by `records moderation_checked as failed with held detail…` and the draft_generated case; `src/lib/reviews/triage.ts:259` is the triage step. Neither is a new gap opened by this branch. |
| `safetyFlagged`: a re-spelled `source === 'llm'` predicate | `source === 'llm'` | `src/`, `worker/`, `tests/` | `**/__tests__/**` | **Zero remaining duplicates.** Exactly two live spellings: the production gate at `auto-approval.ts:424` and the corpus helper at `moderation-runner.ts:106`. The four-way duplication is gone. |
| Tier-blind pre-LLM skip | `isAutoApprovalCandidate\(` | whole repo | `**/__tests__/**`, docs | **Zero siblings.** Two production call sites: `persist.ts:164` (inside the transaction, where the full gate follows) and `ResponseGeneratorWorker.ts:137` (the fixed pre-LLM skip). No other pre-LLM skip uses it. |
| Masked test: a describe setting `AUTO_APPROVAL_ENABLED` without `OPENAI_MODERATION_ENABLED` | `AUTO_APPROVAL_ENABLED = 'true'` per file, compared against `OPENAI_MODERATION_ENABLED = 'true'` | every `*.test.ts` | none | **14 files set the flag; 8 never set the moderation flag.** None is a second instance of this defect: the masking only matters where an assertion depends on the gate APPROVING, and in `safety-review-call-site.test.ts` (the nearest candidate) every assertion is about whether `reviewSafety` was called and what reached `persist` — both upstream of the gate. Recorded as a sound search with no sibling rather than as a finding. |

## Duty 5 — operational completeness

Scope: the operator-actionable terminal or swallowed failure paths this diff adds. RT-07
added BOTH halves of the fail-closed alert path, so the comparison is now possible.

| Facet | Documented (rule 14, `beta-launch-alerting.md:460`) | Emitted | Verdict |
|---|---|---|---|
| Signal identity | Worker `reportCaughtError`, tag `endpoint` = `moderation/safety-review` | `reportCaughtError('moderation/safety-review', err, …)` → `captureException(error, { tags: { endpoint } })` | MATCH |
| Filter | that tag, scoped to the deployment environment | `Sentry.init({ environment: deploymentLane() })` | MATCH |
| Level | `warning` | Sentry's default for `captureException` is `error`; `beforeSend` only scrubs | **CONTRADICTS** → RT-14 |
| Grouping title | default exception-stack grouping, no custom fingerprint or title | no fingerprint or title is set | MATCH |
| Threshold / cadence | 20 events in 1 hour, 60-minute per-issue throttle | n/a (rule-side); a frequency IS present, which this class requires | MATCH, with a caveat in RT-14 |
| Destination action | Discord alerts channel via integration 443670 | n/a (rule-side); the same id all four rules use | MATCH |

This comparison is STATIC. The runbook states the rule is not configured or
delivery-proven by this change; a staging drill remains runbook acceptance work.

## Inventory

Cumulative across both rounds. A row re-measured in round 2 carries its round-2 outcome.

| ID | File | Candidate | Outcome | Class | Finding |
|---|---|---|---|---|---|
| `rt-A01` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns cleared with no concern for an ordinary safe draft | `skipped-budget` | — | — |
| `rt-A02` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared with the concern the model named for an unsafe draft | `skipped-budget` | — | — |
| `rt-A03` | `src/lib/moderation/__tests__/safety-review.test.ts` | records the answering provider on every safety verdict | `skipped-budget` | — | — |
| `rt-A04` | `src/lib/moderation/__tests__/safety-review.test.ts` | passes only the draft text to the LLM task, never the review text | `killed` | — | — |
| `rt-A05` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when the model output fails the schema | `killed` | — | — |
| `rt-A06` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when the model returns cleared=true with a non-null safety concern | `killed` | — | — |
| `rt-A07` | `src/lib/moderation/__tests__/safety-review.test.ts` | makes no LLM call when cost reservation is denied or unavailable | `skipped-budget` | — | — |
| `rt-A08` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when the cost reservation fails, and does not rethrow | `skipped-budget` | — | — |
| `rt-A09` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when cost finalization fails after a cleared model verdict | `killed` | — | — |
| `rt-A10` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when the safety-review cost audit write fails | `killed` | — | — |
| `rt-A11` | `src/lib/moderation/__tests__/safety-review.test.ts` | finalizes and audits billed invalid safety-review completions before returning not-cleared without retry | `killed` | — | — |
| `rt-A12` | `src/lib/moderation/__tests__/safety-review.test.ts` | clears from the Anthropic fallback when the primary safety-review circuit is open | `skipped-budget` | — | — |
| `rt-A13` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when every safety-review provider attempt fails | `skipped-budget` | — | — |
| `rt-A14` | `src/lib/moderation/__tests__/safety-review.test.ts` | returns not-cleared when the LLM task throws | `skipped-budget` | — | — |
| `rt-A15` | `src/lib/moderation/__tests__/safety-review.test.ts` | never throws, for any injected failure | `skipped-budget` | — | — |
| `rt-A16` | `src/lib/moderation/__tests__/safety-review.test.ts` | short-circuits to a distinguishable mock clearance under MOCK_EXTERNAL_APIS | `killed` | — | — |
| `rt-B01` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | blocks auto-approval with safety_review_not_cleared when the verdict is not cleared | `killed` | — | — |
| `rt-B02` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | does not add safety_review_not_cleared when the verdict is cleared | `skipped-budget` | — | — |
| `rt-B03` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | blocks auto-approval with safety_review_unavailable when the check itself failed | `killed` | — | — |
| `rt-B04` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | blocks auto-approval when the safety verdict is null, undefined, or missing cleared | `killed` | — | — |
| `rt-B05` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | invariants: a not-cleared verdict never produces approved=true | `skipped-budget` | — | — |
| `rt-B06` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | invariants: a cleared safety verdict preserves every pre-safety approval decision and block reason | `skipped-budget` | — | — |
| `rt-B07` | `worker/jobs/response-generation/__tests__/auto-approval.test.ts` | invariants: a not-cleared safety verdict adds exactly safety_review_not_cleared to the pre-safety block set | `skipped-budget` | — | — |
| `rt-C01` | `worker/__tests__/safety-review-call-site.test.ts` | finishes the safety-review LLM call before opening the persist transaction | `survived-confirmed-P0` | — | RT-01 |
| `rt-C02` | `worker/__tests__/safety-review-call-site.test.ts` | skips the safety review and makes no LLM call when moderation already flagged the draft | `killed` | — | — |
| `rt-C03` | `worker/__tests__/safety-review-call-site.test.ts` | skips the safety review and makes no LLM call when the draft is not an auto-approval candidate | `killed` | — | — |
| `rt-C04` | `worker/__tests__/safety-review-call-site.test.ts` | does not retry the job when the safety review fails | `skipped-budget` | — | — |
| `rt-D01` | `worker/jobs/response-generation/__tests__/persist.test.ts` | persists a not-cleared safety verdict as pending_approval with one owner notification and no moderation hold, approval audit, or publish outbox | `killed` | — | — |
| `rt-D02` | `worker/jobs/response-generation/__tests__/persist.test.ts` | records a safety_reviewed step on the run spine when the draft persists with an active run | `killed` | — | — |
| `rt-D03` | `worker/jobs/response-generation/__tests__/persist.test.ts` | a completed safety review followed by stale content creates no response, spine step, or follow-up work and records the discarded evaluation | `skipped-budget` | — | — |
| `rt-D04` | `worker/jobs/response-generation/__tests__/persist.test.ts` | a not-cleared safety review without an active run still notifies the owner and records its evaluation outside the spine | `skipped-budget` | — | — |
| `rt-D05` | `worker/jobs/response-generation/__tests__/persist.test.ts` | a safety_reviewed spine-write failure rolls back the response and follow-up outbox work and propagates the persistence error | `skipped-budget` | — | — |
| `rt-E01` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | scores unsafe-threat-02 as true_positive in the safety-review corpus mode | `skipped-budget` | — | — |
| `rt-E02` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | scores unsafe-sexual-01 as true_positive in the safety-review corpus mode | `skipped-budget` | — | — |
| `rt-E03` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | records a safety-only G4-F1 catch without claiming that provider moderation caught the draft | `killed` | — | — |
| `rt-E04` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | a safety catch does not erase a provider miss on a row that still requires provider moderation | `killed` | — | — |
| `rt-E05` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | fails the safety-review corpus when an unsafe row receives source=failed instead of a model judgment | `inconclusive` | `oracle` | RT-11 |
| `rt-E06` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | fails the safety-review corpus on a safe-row check failure even when the false-positive budget is not exceeded | `killed` | — | — |
| `rt-E07` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | rejects safety-review corpus evidence containing mock or skipped verdicts | `killed` | — | — |
| `rt-E08` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | refuses the live safety-review corpus before external calls when MOCK_EXTERNAL_APIS=true | `skipped-budget` | — | — |
| `rt-E09` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | records which provider answered each safety-review corpus row | `skipped-budget` | — | — |
| `rt-E10` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | requires zero false negatives on the injection-resistant safety corpus rows | `skipped-budget` | — | — |
| `rt-E11` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | injection-targeted rows fail when the safety reviewer clears them even if another moderation layer flags them | `skipped-budget` | — | — |
| `rt-E12` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | leaves the default corpus mode unchanged, so the recorded 2026-09-17 evidence stays reproducible | `skipped-budget` | — | — |
| `rt-E13` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | loads the default corpus from disk with the recorded row count and report shape | `skipped-budget` | — | — |
| `rt-F01` | `src/lib/llm/__tests__/tasks.test.ts` | registers safety_review with the declared pinned model policy, zero temperature, and SafetyReviewOutputSchema | `skipped-budget` | — | — |
| `rt-G01` | `scripts/ci/__tests__/gate-rows.test.ts` | promised-tests discovers promised corpus titles under tests/llm-eval | `skipped-budget` | — | — |
| `rt-G02` | `scripts/ci/__tests__/gate-rows.test.ts` | keeps discovering titles under the roots it already searched | `skipped-budget` | — | — |
| `rt-G03` | `scripts/ci/__tests__/gate-rows.test.ts` | still reports a genuinely unwritten title as missing | `skipped-budget` | — | — |
| `rt-H01` | `src/__tests__/cost-guard-contract.test.ts` | every runLlmTask call site is in the reviewed-caller allowlist | `skipped-budget` | — | — |
| `rt-H02` | `src/__tests__/cost-guard-contract.test.ts` | the allowlist carries no stale entries (files without a call site) | `skipped-budget` | — | — |
| `rt-I01` | `src/lib/refusals/__tests__/vocabulary.test.ts` | maps safety_review_not_cleared to a refusal category | `skipped-budget` | — | — |
| `rt-I02` | `src/lib/refusals/__tests__/vocabulary.test.ts` | maps the two safety block reasons to unsafe_content and watchdog_unavailable | `skipped-budget` | — | — |
| `rt-I03` | `src/lib/refusals/__tests__/vocabulary.test.ts` | resolves safety_review_not_cleared through the production refusal resolver with the declared category precedence | `skipped-budget` | — | — |
| `rt-J01` | `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts` | (whole suite; modified by the added cleared-safetyVerdict fixture) | `skipped-budget` | — | — |
| `rt-J02` | `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` | (whole suite; modified by the added cleared-safetyVerdict fixture) | `skipped-budget` | — | — |
| `rt-J03` | `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts` | (whole suite; modified by the added cleared-safetyVerdict fixture) | `skipped-budget` | — | — |
| `rt-J04` | `worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts` | (whole suite; modified by the added `safetyVerdict: null` fixture) | `skipped-budget` | — | — |
| `rt-K01` | `(no covering test)` | src/lib/agents/run-spine.ts:68 — STEP_PERSONA['safety_reviewed'] = 'system' | `skipped-budget` | — | — |
| `rt-K02` | `(no covering test)` | src/components/dashboard/timeline/step-facts.ts:58-65 — STEP_COPY['safety_reviewed'] label/explain/failedLabel | `skipped-budget` | — | — |
| `rt-K03` | `(no covering test)` | tests/llm-eval/run.ts:218-232,251-258,291,300-320 — summariseProviders, the safety fields in printModerationReport and the --with-safety-review CLI wiring | `inconclusive` | `oracle` | RT-06 |
| `rt-A17` | `src/lib/moderation/__tests__/safety-review.test.ts` | never asks the fallback after the primary named a concern | `killed` | — | — |
| `rt-A18` | `src/lib/moderation/__tests__/safety-review.test.ts` | reports a fail-closed outage to the alert sink, carrying no draft text | `skipped-budget` | — | — |
| `rt-A19` | `src/lib/moderation/__tests__/safety-review.test.ts` | does not report a model-judged block to the alert sink | `skipped-budget` | — | — |
| `rt-C05` | `worker/__tests__/safety-review-call-site.test.ts` | threads the verdict reviewSafety returned, by identity, into persistence | `killed` | — | — |
| `rt-C06` | `worker/__tests__/safety-review-call-site.test.ts` | threads null when the safety review was skipped, never a synthesised clearance | `skipped-budget` | — | — |
| `rt-C07` | `worker/__tests__/safety-review-call-site.test.ts` | skips the safety review and makes no LLM call for a Copilot account | `killed` | — | — |
| `rt-D06` | `worker/jobs/response-generation/__tests__/persist.test.ts` | records the safety_reviewed step as completed when the verdict cleared | `killed` | — | RT-10 |
| `rt-E14` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | names every provider that answered, with its count | `skipped-budget` | — | — |
| `rt-E15` | `tests/llm-eval/__tests__/moderation-corpus.test.ts` | reports none for rows no provider answered | `skipped-budget` | — | — |
| `rt-L01` | `src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx` | renders a label and explanation rather than a de-snake-cased database word | `skipped-budget` | — | — |
| `rt-L02` | `src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx` | says a held draft was held for you, never that the check failed | `skipped-budget` | — | — |
| `rt-L03` | `src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx` | shows no status chip for a completed check | `skipped-budget` | — | — |
| `rt-L04` | `src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx` | is registered on the run spine as a system step | `skipped-budget` | — | — |

### Rows carrying a recorded reason

- **`rt-E05`** — Green baseline at HEAD 6a787c037. Mutation M29 dropped `&& safety.source === 'llm'` from the extracted `safetyFlagged` helper (moderation-runner.ts:106) — the exact clause the fix restored. This test PASSED under the mutant, and so did the whole file: a second supervised launch ran all 39 cases of moderation-corpus.test.ts under M29 with 0 failures. The branch IS executed (the case supplies source:'failed'), and the mutant is not equivalent — it makes an OUTAGE row report flaggedBySafetyReview=true, the overclaim the helper's own docstring says it exists to prevent. No oracle in the covering set falsifies the clause, so this is a claim about the ORACLE, not a proven behaviour-preserving mutant.
- **`rt-J01`** — Round-1 class `infra` no longer applies: this round wired a validated localhost TEST_DATABASE_POOL_URL (docker repworth-testdb-recovery-20260914, migrations head 121) into every supervised launch, so the suite was executable. The 30-launch budget went to fix verification first.
- **`rt-J02`** — Round-1 class `infra` no longer applies: this round wired a validated localhost TEST_DATABASE_POOL_URL (docker repworth-testdb-recovery-20260914, migrations head 121) into every supervised launch, so the suite was executable. The 30-launch budget went to fix verification first.
- **`rt-J03`** — Round-1 class `infra` no longer applies: this round wired a validated localhost TEST_DATABASE_POOL_URL (docker repworth-testdb-recovery-20260914, migrations head 121) into every supervised launch, so the suite was executable. The 30-launch budget went to fix verification first.
- **`rt-K01`** — RT-05 fix: src/components/dashboard/timeline/__tests__/step-facts-safety.test.tsx now carries a non-tautological covering assertion (`expect(STEP_PERSONA.safety_reviewed).toBe('system')`), recorded as row rt-L04. The uncovered-change condition is resolved; budget did not reach the mutation.
- **`rt-K02`** — RT-05 fix: step-facts-safety.test.tsx asserts the label, the explain, the label/moderation_checked collision and the `Held for you` failedLabel directly (rows rt-L01..rt-L03). The uncovered-change condition is resolved; budget did not reach the mutation.
- **`rt-K03`** — PARTIALLY resolved. `summariseProviders` moved out of run.ts into moderation-runner.ts as `summariseSafetyProviders` and gained two cases (rows rt-E14, rt-E15). The REST of the hunk is still uncovered: tests/llm-eval/__tests__/run.test.ts is unchanged on this branch and grep over it for `--with-safety-review`, `printModerationReport`, `assertSafetyModeEnvironment` and `makeCorpusSafetyReview` returns zero hits, so the CLI entry point and the new report printing have no covering candidate.
- **`rt-A17`** — D14. Green baseline. TWO mutants, both killed: M27 restored the `.refine()` contradiction rejection onto SafetyReviewOutputSchema (the exact pre-fix code, which turns a contradiction into a provider failover) — test failed; M28 dropped `&& output.concern === null` from deriveSafetyVerdict (safety-review-schema.ts:92) — test failed.
- **`rt-A18`** — RT-07 emitting half. Not executed; see RT-14 for a static facet contradiction found by Duty 5 without a launch.
- **`rt-C05`** — RT-01. Green baseline. TWO mutants, both killed: M20 replaced the threaded `safetyVerdict` at ResponseGeneratorWorker.ts:172 with an unconditional {cleared:true,concern:null,source:"llm",provider:null} — the round-1 survivor — test failed; M21 threaded a bare `null` — test failed. The identity assertion (`toBe`) is what kills the constant; a structural assertion would not.
- **`rt-C07`** — Tier-blind skip. M36 deleted `&& tierGrantsAutopilot(ctx.subscriptionTier)` from the worker skip predicate and the WHOLE file ran under it: 9 cases, exactly 1 failure, and it was this case. Attribution is unambiguous and the other 8 cases passing shows the file is healthy under the mutant. DEVIATION recorded honestly: budget was exhausted, so this case has no individual HEAD baseline of its own — the file-level evidence stands in for it.
- **`rt-D06`** — RT-02 second half. Green baseline. M24 replaced `status: safetyVerdict.cleared ? 'completed' : 'failed'` (persist.ts:552) with a constant 'failed' — test failed, so the completed half is pinned. A SECOND mutant on this row, M25 (safetyReviewBlockReasons always returns ['safety_review_not_cleared']), SURVIVED; that mutation is outside this test's oracle (the step status is computed upstream of the gate), so it is recorded as finding RT-10 rather than as this row's outcome.
- **`rt-L01`** — New file added by the RT-05 fix; covers rt-K02.
- **`rt-L02`** — Covers the `Held for you` failedLabel named in RT-05.
- **`rt-L04`** — Covers rt-K01; replaces the tautological Object.entries loop with a direct value assertion.

## Authorizations

Rendered from the sidecar's `authorizations` array, which is the only source. One entry.

**`owner-safety-review-third-round-2026-09-18`** — 2026-09-18, names no finding.

The owner authorized a THIRD round on this branch on 2026-09-18, answering the recorded question that round 2 had ended `INCOMPLETE_ORACLE` with 49 rows unmeasured for budget and 2 inconclusive, and that a third round needs an authorization recorded in the sidecar before it opens. The owner chose the option "Round 3, budget ~150 launches".

**The requested budget is not grantable by this runner.** `authorizedBudget` in `mutation-runner.mjs` returns `null` for any round that is not 1, 2 or 4, and every existing extension is pinned to a named branch, sidecar path, head SHA and inventory hash. Round 3 therefore opens at the standard 30-launch cap. The authorization is still what unlocks the round.

This entry waives no finding, accepts no risk, and grants no fourth round. Every open P1 is being FIXED rather than accepted, so none of them links to this authorization.

## What was left unmeasured, and why

- **49 rows stay `skipped-budget`** — the 30-launch budget went to fix verification first,
  then to the five newly selectable branches, in the priority order the round-2 brief set.
  Notable among them: the three live-DB integration suites (`rt-J01`–`rt-J03`), which were
  EXECUTABLE this round for the first time but not reached; the four new timeline-copy cases
  (`rt-L01`–`rt-L04`) that discharge RT-05 by inspection; the two new alert-sink cases
  (`rt-A18`, `rt-A19`); and `rt-C06`, the skip-path null-threading case.
- **2 rows stay `inconclusive/oracle`** — `rt-K03` (the `--with-safety-review` CLI wiring and
  `printModerationReport`, still with no covering candidate) and `rt-E05` (the covering set
  falsifies nothing about the restored `source === 'llm'` clause). These force the
  `INCOMPLETE_ORACLE` status, which outranks `INCOMPLETE_BUDGET`.
- **`rt-C01` keeps its round-1 `survived-confirmed-P0`** — the ordering test still does not
  kill the constant-verdict mutant. RT-01 was fixed by ADDING a candidate (`rt-C05`), not by
  strengthening that one, and the row records that honestly.
- **`rt-C07` has no individual HEAD baseline.** Budget was exhausted at launch 30, so the
  tier mutant was measured by a whole-file run: 9 cases, exactly 1 failure, and it was the
  Copilot case. Attribution is unambiguous and the other 8 passing shows the file is healthy,
  but the protocol's per-case green baseline was not taken and the row says so.

## Restoration

Every mutated file was restored to its original blob before the first report byte was
written; `git status --porcelain --untracked-files=no` is empty at `6a787c037`, and each of
the 17 journal entries was checked individually with `git hash-object` against its recorded
`originalOid`. **No mutation is applied.** The journal is deliberately left open with the
dotenv swap in place: the invoking root agent owns `mutation-runner.mjs finalize`.
