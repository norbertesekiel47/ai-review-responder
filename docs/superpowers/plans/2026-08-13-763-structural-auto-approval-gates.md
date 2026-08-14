# Issue #763 — Structural Auto-approval gates

Status: owner-approved for implementation

Issue: `RepWorth/ai-review-responder#763`

Intake: `docs/superpowers/plans/codex-fix-763-structural-auto-approval-gates-intake.json`

## Intent

Make the existing structural Auto-approval contract impossible to change in
only one of its three production call shapes:

1. the cheap pre-transaction candidacy boolean in `persist.ts`;
2. the structural non-candidate decision; and
3. the structural portion of the total Auto-approval evaluator.

The eligible set remains exactly:

```text
AUTO_APPROVAL_ENABLED
  && origin_lane === live_ingest_new
  && version === 1
  && suppress_notification === false
```

## Decisions

### D1 — The seam stays in `auto-approval.ts`

`auto-approval.ts` already owns both decision forms and the structural reason
vocabulary. Add one module-private ordered `STRUCTURAL_GATES` table of readonly
`[predicate, reason]` tuples there. Moving the table elsewhere would widen the
interface without adding another owner.

### D2 — Export one cheap boolean interface, not the table

Export `isAutoApprovalCandidate(input: StructuralBlockInput): boolean` for
`persist.ts` and invariant tests. Keep `STRUCTURAL_GATES` and the reason
collector private. Callers need the decision, not the implementation. The
helper performs no I/O and reads only the existing server-side runtime flag
plus its input.

### D3 — Snapshot the runtime flag once per call shape

The private collector accepts the already-resolved `runtimeEnabled` value.
`isAutoApprovalCandidate`, `structurallyBlockedDecision`, and
`evaluateAutoApprovalCandidate` each resolve the flag once, then feed that
snapshot through the same table. This keeps each returned decision internally
consistent and avoids calling an environment reader twice in one decision.

### D4 — Canonical structural reason order follows the current blocked form

The table order remains:

1. `auto_approval_disabled`
2. `bad_origin_lane`
3. `unsupported_version`
4. `suppressed_notification`

Every applicable reason is emitted once. The total evaluator inserts this
ordered structural group as one spread while leaving all non-structural
predicates byte-for-byte unchanged. No code treats block-reason ordering as an
authority decision; approval continues to depend only on whether the complete
list is empty.

### D5 — Verify through the module interface

The property test uses `isAutoApprovalCandidate`,
`structurallyBlockedDecision`, and `evaluateAutoApprovalCandidate`; it does not
export or inspect `STRUCTURAL_GATES`. For every combination of runtime flag,
origin lane (including null), integer version, and suppression boolean:

- an independent test oracle derives the exact locked contract and exact
  ordered reasons directly from the intake expression (deliberate test-side
  duplication, not another production gate);
- candidate boolean true means the total evaluator approves under otherwise
  passing inputs and the blocked-only interface rejects the invalid call;
- candidate boolean false means the blocked-only and total decisions return
  the same ordered structural reasons; and
- all three results agree with the independent oracle, so a shared but wrong
  predicate cannot make the property pass.

This is the deletion test for the old duplication: changing any structural
predicate or reason in the table changes all three outcomes together.

### D6 — Remove the test-only copied predicate

`on-demand-lane.property.test.ts` currently acknowledges that its local mirror
can drift. Replace the mirror with the exported production boolean. Keep the
real `persistResponseAndNotify` test as the integration-style proof that an
on-demand v1 draft skips candidate-only SQL and stays owner-only. The invariant
property block explicitly sets `AUTO_APPROVAL_ENABLED=true`, restores the
environment afterward, and includes a live-ingest v1 unsuppressed positive
control so runtime-disabled vacuity cannot hide a broken lane or suppression
gate.

### D7 — Verify the one-read runtime snapshot

Add a focused unit test that spies on `autoApprovalRuntimeEnabled`, provides
different sequential return values, and proves each public decision interface
calls it exactly once. For the decision-returning interfaces, assert the
returned `runtimeEnabled` and structural reason describe that captured value.
This makes D3 observable without exporting the private collector or gate table.

### D8 — Repoint active invariant comments to the new owner

Update the three approved comment-only surfaces that either cite the predicate
in `persist.ts` or call the origin lane the only exclusion. They will point to
`auto-approval.ts#isAutoApprovalCandidate` and describe the on-demand lane and
notification suppression as independent fail-closed exclusions. No executable
code or assertion changes in these files. The bracketed route is represented
twice in `allowed_edit_surface` (literal and `\[reviewId\]`-escaped) because the
in-session bash matcher and merge-time TypeScript matcher require different
spellings; this is a known encoding correction, not additional path scope.

## Tracer bullets

### T1 — Lock three-shape agreement (red)

- Observable behavior: every candidate-field combination produces an
  agreeing candidacy result and structural-reason decision across the three
  public call shapes.
- Test seam: `isAutoApprovalCandidate`, `structurallyBlockedDecision`, and
  `evaluateAutoApprovalCandidate`.
- Exact test: `property: structural candidate boolean, blocked decision, and total evaluator agree for every candidate-fields input`.
- Additional exact test: `reads the Auto-approval runtime flag once per structural decision`.
- Blocking edges: none.
- Precedent: the `fast-check` invariant block in
  `worker/jobs/response-generation/__tests__/persist.test.ts` and
  `src/lib/reviews/__tests__/sentiment.test.ts`.
- Allowed files:
  `worker/jobs/response-generation/__tests__/auto-approval.test.ts`.
- Red evidence: the focused test command fails because the new boolean
  interface does not yet exist.

### T2 — Make the shared gate table the single production owner (green)

- Observable behavior: the exact pre-existing eligible set is retained;
  structural non-candidates still skip candidate-only locks/runtime reads;
  blocked and total decisions emit the same structural reasons.
- Test seam: T1 property plus existing `persistResponseAndNotify` mocked-SQL
  assertions.
- Exact checks:
  - the T1 property passes;
  - the T1 independent oracle preserves exactly flag-on + live-ingest-new +
    version-1 + unsuppressed eligibility and the canonical reason order;
  - the one-read snapshot test passes;
  - existing `persistResponseAndNotify auto approval runtime branch` tests
    continue to prove the lock/read split.
- Blocking edges: T1.
- Precedent: current `structurallyBlockedDecision`, current pre-transaction
  candidacy comment in `persist.ts`, WS4 spec §2.3/§5.
- Allowed files:
  `worker/jobs/response-generation/auto-approval.ts`,
  `worker/jobs/response-generation/persist.ts`, and
  `worker/jobs/response-generation/__tests__/persist.test.ts` only if an
  existing assertion must name the new interface (no new behavior is planned
  there).
- Completion evidence: focused Auto-approval and persist tests pass.

### T3 — Retire the on-demand test mirror

- Observable behavior: the on-demand lane regression tests now exercise the
  production candidacy interface while the real persist test continues to
  prove no publish path is reached.
- Test seam: `on-demand-lane.property.test.ts`.
- Exact checks:
  - `live_ingest_new version 1 without suppression is a candidate when AUTO_APPROVAL_ENABLED is true`;
  - `property: isAutoApprovalCandidate is false for every origin lane other than live_ingest_new`;
  - `property: a suppress_notification draft is never an auto-approval candidate at any version`;
  - `persistResponseAndNotify keeps an on_demand_generate v1 draft owner-only when AUTO_APPROVAL_ENABLED is true even if suppress_notification is false`.
- Blocking edges: T2.
- Precedent: that file's existing production-through-persist proof.
- Allowed files:
  `worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts`,
  `src/lib/shared/worker-types.ts`,
  `src/lib/reviews/on-demand-generate.ts`, and
  `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts`.
- Completion evidence: the focused on-demand property suite passes with no
  hand-copied structural predicate and cannot pass under a default-false flag.

## Plan-review triage

### Round 1 — `VERDICT: REVISE`

| Finding | Disposition | Evidence and correction |
|---|---|---|
| P1: agreement property lacks an exact eligible-set oracle | ACCEPT | `job-outbox-helpers.ts` accepts every positive integer version, so three agreeing consumers could all wrongly admit v3. D5/T1 now require an independent exact-expression and exact-reason oracle. |
| P1: on-demand properties become vacuous under the default-false flag | ACCEPT | The existing local helper receives `true`, while the production helper reads `AUTO_APPROVAL_ENABLED`; D6/T3 now require scoped flag-on setup and a positive control. |
| P2: one-read flag snapshot is promised but unverified | ACCEPT | Current `structurallyBlockedDecision` reads the non-memoized flag twice. D7/T1 now require a sequential-return spy proving one call and internally consistent returned facts. |

### Round 2 — `VERDICT: REVISE`

| Finding | Disposition | Evidence and proposed correction |
|---|---|---|
| P2: active invariant comments will point to the old candidacy owner and one calls the lane the only exclusion | ACCEPT — surface amendment approved | `worker-types.ts` and the Generate route test cite `persist.ts`; the latter asserts suppression immediately after calling the lane the only exclusion. `on-demand-generate.ts` also cites the old owner. The approved intake amendment adds these three comment-only files; D8 points every ownership reference to `auto-approval.ts#isAutoApprovalCandidate` and preserves lane + suppression as independent fail-closed exclusions. |

### Round 3 — `VERDICT: APPROVED`

No findings at or above the 80% confidence threshold. Plan-review budget is
closed at 3/3; implementation may begin only after owner sign-off.

## Branch-review triage

### Round 1

| Review axis | Finding | Disposition | Evidence and correction |
|---|---|---|---|
| Spec/correctness | No actionable finding at or above 80% confidence | APPROVED | The reviewer verified the ordered table, all three consumers, the cheap pre-transaction split, exact oracle, and reason order. |
| Security/authorization | No actionable finding at or above 80% confidence | APPROVED | The reviewer verified fail-closed candidacy, candidate-only locking/runtime reads, one-read flag snapshots, and unchanged tenant/publishing boundaries. |
| Maintainability | P2: the eligible all-three-shape branch depended on rare property sampling | ACCEPT | The exact eligible example now deterministically proves a true candidate, an approving total decision, and the blocked-only interface's contract throw. |
| Maintainability | P3: the on-demand test header's “third title” ordinal became stale | ACCEPT | The comment now refers directly to “the persist test,” which remains accurate if test order changes. |

## Verification

Run in order:

```bash
pnpm exec vitest run worker/jobs/response-generation/__tests__/auto-approval.test.ts worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts worker/jobs/response-generation/__tests__/persist.test.ts
pnpm build
bash .agents/skills/feature/scripts/verified-gate.sh
bash .agents/skills/feature/scripts/verified-gate.sh --review
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
```

The final high-risk review axes are spec/correctness,
standards/maintainability, and security/authorization. Reviewers are read-only;
the root agent verifies and triages every finding.

## Rollback and observability

Rollback is a code revert of the table and all three consumers together; no
schema, data, environment, or remote flag rollback exists. Existing decision
summaries, fallback logs, and `approval_audit_log` remain the operational
signals. No new signal is necessary because the change is behavior-preserving
and the property test is the drift detector.
