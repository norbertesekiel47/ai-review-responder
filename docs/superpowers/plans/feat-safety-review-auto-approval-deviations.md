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

**Verdict:** pending — resolve at step 6.

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

**Verdict:** pending — resolve at step 6.

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
