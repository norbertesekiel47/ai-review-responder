# Deviations — feat/safety-review-auto-approval

Everything the plan did not anticipate. Step 6 reads this end to end and logs a
**Verdict:** ACCEPT or RE-PLAN per entry. The `reviewed` transition refuses
while any entry lacks a resolved ACCEPT.

---

## D1 — Intake invariant #15 wording was wrong (corrected at plan self-review)

**What.** The signed-off intake said the safety-review module "takes no DB
client. It is pure over its text input plus the injected LLM seam."

**Why that is wrong.** The module records an `api_costs` row, so it needs a
client. Invariant #15 requires a domain module to receive its client as an
**explicit parameter** rather than importing `@/lib/db/server` — it does not
require the absence of a client. The precedent is
`classifyReviewTriage(sql, input)` at `src/lib/reviews/triage.ts:146`.

**Correction.** The invariant now reads: the module receives `sql` explicitly,
never imports the singleton, and needs it only for the `api_costs` row; the
verdict itself stays pure over the draft text plus the injected LLM seam.
`reviewSafety(sql, input, deps?)`.

**Classification.** An intake CORRECTION, not a surface amendment — no path in
`allowed_edit_surface` changed, so it does not consume the amendment budget
(`execution-lanes.md`: "Only `allowed_edit_surface` changes count — other intake
corrections are deviations-file entries"). Both intake copies updated and
re-validated; they match.

**Found by.** Plan self-review, check 3 (name and contract consistency), before
any code was written.

**Verdict:** ACCEPT — the correction makes the intake describe the precedent the
plan already follows, and it narrows nothing the owner signed off on.

---

## D2 — Mock-mode behaviour is not named in `user_visible_behavior`

**What.** `reviewSafety` short-circuits on `isMockMode()` and returns
`{ cleared: true, concern: null, source: 'mock' }`, following `triage.ts:150`.

**Why.** `MOCK_EXTERNAL_APIS=true` is the documented local-dev bypass for all
external APIs. Without the short-circuit the check would fail closed in local
dev, so no developer could ever exercise the Auto-approval lane locally.

**Why it is safe.** `MOCK_EXTERNAL_APIS=false` in CI (CLAUDE.md, "CI & repo")
and in both deploy environments, so the branch is unreachable anywhere a draft
can reach Google. `source: 'mock'` makes a mock clearance distinguishable from a
model clearance on the run spine, so it can never be mistaken for evidence.

**Classification.** Behaviour not named in the locked
`user_visible_behavior`, disclosed here rather than absorbed silently. It adds no
path to `allowed_edit_surface`.

**Verdict:** ACCEPT — resolved at step 6. As built it is safer than disclosed:
the gate does not merely fail to clear on a mock verdict, it **refuses to treat
one as an answer at all** (`safetyReviewBlockReasons` requires `source === 'llm'`,
`auto-approval.ts`). So a mock clearance blocks with `safety_review_unavailable`
even in the unreachable case where `MOCK_EXTERNAL_APIS=true` reached a lane that
could post. The environment guarantee is still true; the code no longer depends
on it. Pinned by `blocks auto-approval when the safety verdict is null,
undefined, or missing cleared`.

---

## D3 — The corpus lane must refuse to run in mock mode

**What.** A consequence of D2 rather than a separate decision. If
`--with-safety-review` ran under `MOCK_EXTERNAL_APIS=true`, every safety verdict
would be a mock clearance and the corpus would record a PASS that tested
nothing — the same silent-failure shape the existing lane already guards against
for `OPENAI_MODERATION_ENABLED`.

**Correction.** T7 adds the matching guard: with `--with-safety-review`, the lane
refuses to start unless `MOCK_EXTERNAL_APIS` is not `true`, and any row whose
verdict `source` is `'mock'` fails the run.

**Verdict:** ACCEPT — resolved at step 6. Built as
`assertSafetyModeEnvironment()` (`moderation-runner.ts`), called from `run.ts`
**before** the rows load and before any provider call, and a `mock` or `skipped`
verdict scores `safety_error` against a zero budget. Round 1's finding 3
widened this from "mock" to every non-answer, which is the stronger rule: an
outage is not evidence either. Pinned by `refuses the live safety-review corpus
before external calls when MOCK_EXTERNAL_APIS=true` and `rejects safety-review
corpus evidence containing mock or skipped verdicts`.

---

## D4 — The locked `rollback_plan` was factually wrong (owner decision, 2026-09-18)

**What.** The signed-off intake claimed that unsetting
`AUTO_APPROVAL_PROVIDER_MODERATION_READY` "re-raises
provider_moderation_not_validated and blocks the lane again".

**Why that is wrong.** Plan round-1 finding 6. The flag feeds
`buildAutoApprovalReadiness`, which `settings.ts:328` enforces when an owner
**enables or widens** a policy. The generation evaluator never reads it, and the
publisher's runtime check reads `AUTO_APPROVAL_ENABLED`
(`auto-policy-publish.ts:555`). Once customers have policies, unsetting
readiness stops new opt-ins while existing policies keep approving and
publishing — an operator could believe posting had stopped when it had not.

**Owner decision.** Correct the wording only. No runtime readiness gate is
added; the existing `AUTO_APPROVAL_ENABLED` gate is sufficient, which was also
Codex's own recommendation. `rollback_plan` now states plainly that readiness is
an EXPANSION control and that the runtime lever is `AUTO_APPROVAL_ENABLED=false`
plus a worker redeploy.

**Classification.** Intake correction, not a surface amendment. No path changed.

**Verdict:** ACCEPT — it replaces a false operational promise with the true one
and adds no code.

---

## D5 — The circuit-breaker edge case misdescribed the executor (owner decision, 2026-09-18)

**What.** The signed-off intake said "The LLM circuit breaker is open:
not-cleared, with no call attempted."

**Why that is wrong.** Plan round-1 finding 7. `runLlmTask` proceeds from a
blocked primary to the Anthropic fallback (`run-task.ts:242`), and a healthy
fallback returns normally. A unit test that merely makes `runTask` throw a
circuit error cannot expose this.

**Owner decision.** Keep the Anthropic fallback. The `safety_review` task
descriptor retains `fallback`, and the edge case is amended: only an
all-attempts failure yields not-cleared. The alternative — dropping `fallback`
so the no-call contract held literally — was weighed and declined in favour of
availability.

**Accepted consequence, and its mitigation.** Production may answer from
Anthropic while the corpus measured OpenAI. Mitigation, added to T7: every
corpus row records which provider answered it, so the evidence can never claim
to have measured a path it did not exercise.

**Classification.** Intake correction, not a surface amendment. No path changed.

**Verdict:** ACCEPT.

---

## D6 — Surface amendment: the cost-guard caller tripwire (owner-approved, 2026-09-18)

**What.** `src/__tests__/cost-guard-contract.test.ts` is added to
`allowed_edit_surface`, and `src/lib/moderation/safety-review.ts` is registered
in its `CALLER_ALLOWLIST`.

**Why.** Plan round-1 finding 13b. That file is a tripwire: it reads every
production `runLlmTask` call site off disk and fails unless the file is listed
by name. It exists to force human review of each new LLM caller. `reviewSafety`
is a new caller, so the test goes red the moment T3 lands, and the gate can
never reach green without the registration.

**Alternatives.** None. The tripwire has no bypass, and it should not — that is
the whole governance value.

**Classification.** A surface AMENDMENT. It consumes the amendment budget;
`surfaceAmendments=1` records it.

**Verdict:** ACCEPT — owner-approved 2026-09-18. It is the sanctioned way to add
an LLM caller, and the entry carries the guard-shape comment the neighbouring
tenants carry.

---

## D7 — Surface amendment: `promised-tests` never searched `tests/` (owner-approved, 2026-09-18)

**What.** `scripts/verify-gate.sh` and `scripts/ci/__tests__/*.test.ts` are added
to `allowed_edit_surface`. The gate's promised-title discovery gains `tests` as a
search root, and `scripts/ci/__tests__/gate-rows.test.ts` gains the covering test.

**Why.** Plan round-1 finding 13a. `verify-gate.sh:472` greps `src worker
scripts` only. The three promised corpus titles live in
`tests/llm-eval/__tests__/`, so `promised-tests` reports them missing even when
they exist and pass — a false RED that cannot be told apart from an unwritten
test. The script's own header records the identical defect being fixed once
before, for `scripts/`, at #611.

**Why the test glob rides along.** A change to `verify-gate.sh` that no test may
cover is a change nothing verifies. `gate-rows.test.ts` already exercises this
script, so the covering test has a home and the two paths are one amendment, not
two.

**Alternatives weighed.** A separate PR off `main` first — declined: this branch
already forks from the unmerged #1309, and a second unmerged dependency would
block the gate on two PRs. Dropping the three titles from `tests_to_add` —
declined: the gate would go green by having nothing to look for.

**Classification.** A surface AMENDMENT. `surfaceAmendments=2` records it.

**Verdict:** ACCEPT — owner-approved 2026-09-18.

---

## D8 — `test_seams[0]` still described the pre-D1 signature

**What.** D1 corrected the module contract to `reviewSafety(sql, input, deps?)`
and said both intake copies were updated. The `invariants` field was, but
`test_seams[0]` still read `reviewSafety(text, deps)`.

**Correction.** The seam string now names the real signature, says the client
arrives explicitly per invariant #15, and adds that the cost reservation,
finalization and `api_costs` write sit inside the injected seam — which is what
makes round-1 finding 1 testable at the real boundary instead of through a
stubbed `runTask`.

**Classification.** Intake CORRECTION, not a surface amendment. No path changed.

**Verdict:** ACCEPT — it removes a contradiction inside the locked file. Found
by the resume reconciliation, not by a review round.

---

## D9 — Surface amendment: a safety-mode-only corpus file (round-2 NEW A)

**What.** `tests/llm-eval/moderation-corpus-safety.jsonl` is added to
`allowed_edit_surface`. `tests/llm-eval/moderation-corpus.jsonl` stays in the
surface but is **not modified**.

**Why.** Revision 2 put the two injection-resistance rows (round-1 finding 10)
into the shared corpus and added `maxSafetyErrors` to the shared acceptance
object, while the same tracer promised the default mode stays byte-identical.
Round 2 proved those cannot both be true: `loadModerationCorpus` returns every
row in the file it reads (`moderation-corpus-load.ts:101`), and the report prints
`total: results.length` (`moderation-runner.ts:151`). The ordinary command would
have scored 55 rows against the recorded 53 and emitted a different acceptance
shape — silently invalidating the 2026-09-17 evidence this feature exists to
supersede.

**Alternatives weighed.** Tag the new rows in the shared file and filter them out
of the default load — declined: it turns a byte-identical promise into a
filtered one, which is weaker and is the exact class of claim round 2 rejected.

**Classification.** A surface AMENDMENT — a new fixture file in a directory
already heavily in scope, forced by a confirmed defect. `surfaceAmendments=3`.

**Verdict:** ACCEPT — it is the smaller correction, and it keeps the recorded
evidence reproducible by construction rather than by care.

---

## D10 — Six T1 tests pass at the RED phase, and must

**What.** T1's rule is "every new test FAILS or is `.todo`. A new test that
PASSES here is a broken test." Six of the 47 pass at T1 with no implementation:

| Test | Why it passes now |
|---|---|
| `does not add safety_review_not_cleared when the verdict is cleared` | Asserts the reason is ABSENT. With no gate row, it is absent. |
| `invariants: a cleared safety verdict preserves every pre-safety approval decision and block reason` | Asserts the pre-feature block set is unchanged. With no gate row, it is unchanged. |
| `skips the safety review and makes no LLM call when the draft is not an auto-approval candidate` (×3 cases) | Asserts `reviewSafety` is NOT called. With no call site, it is not called. |
| `persists a not-cleared safety verdict as pending_approval with one owner notification and no moderation hold, approval audit, or publish outbox` | Asserts the manual-notification fallback. That is already the behaviour for this fixture. |

**Why this is not the defect the rule guards against.** The rule exists to catch
a test that asserts nothing — one that would pass against any implementation.
These six are **preservation** assertions: their job is to fail when the feature
breaks something that used to work, so passing before the feature exists is the
correct reading, not a vacuous one.

Round-2 **NEW C** settled this exact question for the invariant pair. It proved
that demanding both rewritten properties fail under the "delete the safety row"
mutation was wrong, because the preservation property must still PASS there.
T1's RED phase is the same condition as that mutation: no safety row. A test
cannot be required to fail under a mutation it is defined to survive.

**How they are kept honest instead.** Each is mutation-checked at its own tracer
rather than at T1 — T5's two-mutation table for the invariants, and the skip
tests by deleting the call-site guard at T6. A preservation test that cannot be
made to fail by SOME mutation is the real defect, and that is what the tracers
check.

**Classification.** A deviation from T1's stated expectation, disclosed rather
than absorbed. No path or title changed.

**Verdict:** ACCEPT — resolved at step 6, and the per-tracer mutation checks
were actually run rather than merely promised. T5's two-mutation table came out
exactly as round-2 NEW C specified: deleting the safety row fails `adds exactly
safety_review_not_cleared` and leaves `preserves every pre-safety decision`
passing; deleting an existing veto (`triage_high_severity`) fails `preserves`.
The round-1 superset property survived that second mutation, which is what made
it vacuous. Two of the six also stopped passing vacuously once T5 landed — the
`cleared: 'mock'` case now blocks — so four remain, all preservation
assertions.

---

## D11 — One block reason could not carry two owner-facing facts (owner decision, 2026-09-18)

**What.** `AutoApprovalBlockReason` gains a SECOND member. The gate now emits
`safety_review_not_cleared` when a model named a concern, and
`safety_review_unavailable` when the check did not answer.

**Why.** Found at T4, while mapping the reason to a Refusal category. The
category vocabulary's own comments are the evidence:

- `unsafe_content` — "We would not say that."
- `watchdog_unavailable` — "We could not check it, so we did not post."

A single `safety_review_not_cleared` covers both cases, because the module
fails **closed**: a provider outage and a model-named threat produce the same
`cleared: false`. The Refusal ledger is **owner-facing**, so the mapping is not
bookkeeping — it is a sentence the owner reads about their own draft.

Neither single mapping is defensible:

- to `unsafe_content`: a check outage tells the owner "We would not say that"
  about a draft that nothing objected to — an affirmative false statement;
- to `watchdog_unavailable`: a genuine veiled-threat catch is reported as "We
  could not check it", hiding the exact catch G4-F1 exists to make.

**The precedent settles it.** The provider layer three lines up in the same map
already splits on this axis: `moderation_flagged` is `unsafe_content`, while
`provider_moderation_error` and `provider_moderation_disabled` are
`watchdog_unavailable`. Collapsing the safety layer would be inconsistent with
its own neighbour.

**Cost.** `SafetyVerdict.source` already distinguishes the cases and the gate
already holds it, so the split is two `when()` rows rather than new machinery.
Precedence: `safety_review_not_cleared` joins tier 1 beside `moderation_flagged`;
`safety_review_unavailable` joins tier 2 beside `provider_moderation_error`. An
unsafe-content finding therefore outranks a watchdog outage, which is tested.

**Why it was not caught by review.** All three rounds read the plan, and the
plan said "map it with the safety vetoes" — which is true of one half. The
conflation is only visible against the category COMMENTS, and those are read
when writing the map entry, not when reviewing the instruction to write one.

**Classification.** A contract change after the review cap: one new
`AutoApprovalBlockReason` member, two new locked titles, and a surface
amendment for the timeline copy seam (below). Escalated to the owner rather
than decided here, per feature.md's round-3 rule for `risk: high`.

**Owner decision, 2026-09-18.** Split the reason in two.

**Verdict:** ACCEPT.

---

## D12 — Surface amendment: the timeline step-copy seam (forced at T4)

**What.** `src/components/dashboard/timeline/step-facts.ts` and its test glob
are added to `allowed_edit_surface`.

**Why.** A THIRD exhaustiveness seam, which the plan did not know about. T4 adds
`safety_reviewed` to `STEP_PERSONA`, and `STEP_COPY` is
`satisfies Record<AgentStepKey, StepCopy>` — so `pnpm typecheck` fails until the
new step carries an owner-facing label and one-sentence explanation. The plan
claimed the step key needed only the run-spine map.

This is the seam working as designed: the timeline is the page that answers
"why was this held?", and the guard exists so a new step cannot render as a
de-snake-cased database word.

**What the copy says, and one naming call.** The label is **"Safety review"**,
NOT "Safety check" — `moderation_checked` already owns that label, and two steps
with one name on the same timeline is worse than a longer word. "Safety review"
is also the glossary term, so the page and the domain agree. `failedLabel` is
"Held for you": a not-cleared verdict routes the draft to the owner, which is
the check working, and the map's own header says that is exactly what
`failedLabel` is for.

**Classification.** A surface AMENDMENT, forced by a compile error.
`surfaceAmendments=4`.

**Verdict:** ACCEPT.
