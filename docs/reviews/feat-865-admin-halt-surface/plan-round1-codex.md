# feat-865 — plan review round 1 (codex, adversarial, read-only)

codex thread id: `01a01308-efa1-7542-81f3-3a974d3b1c5d`

Brief: `scratchpad/codex-865-plan-review-brief.md` (eval-first: *can this eval pass while the feature is still wrong?*)

---

I’ll perform this as a read-only `verify-spec` audit, because you’re asking for an evidence-backed plan/eval verdict against the codebase. I’ll first load the repository rules and skill instructions, then trace every cited artifact and map each failure mode to the 16 named tests.

---

The skill normally records incremental findings in `/tmp`, but your read-only constraint overrides that, so I will keep the audit in-memory and create nothing. Because the audit exceeds 15 verifiable items, the skill also calls for parallel independent inspection; I’m splitting artifact validation, eval-gap mapping, and transaction/domain-contract review, then I’ll personally re-check every severe finding.

---

A central eval flaw is already confirmed: Task 0 permits `.todo` while calling the cases “failing tests,” so the gate can be green before any behavior is exercised. I’m now distinguishing that structural hole from behavioral gaps where a named test exists but cannot prove the claimed invariant (for example, final parent state cannot prove that `closeBatchIfSettled` remained the sole owner).

---

Yes. The eval can pass while the feature is materially wrong. The current review tree also has the plan and deviations files untracked.

| # | severity | plan section or file:line | finding | required change |
|---|---|---|---|---|
| 1 | critical | plan §4 Task 0:210–226 | Task 0 permits `.todo`, so all 16 titles can exist while zero assertions execute and the suite stays green. Calling them “failing tests” does not create a red gate. | Require all 16 tests to be executable, prohibit `.todo`/`.skip`, and run a command proving the eval fails before implementation. Add the meta-test named below. |
| 2 | critical | plan §3.1:102–103; §3.4:191–193; `outreach.ts:90–101`; `batch-builder.ts:693–706,780–787`; migration 091:175–176 | The plan makes every state except `halted`/`closed` haltable, including an unbuilt `pending` batch. The builder does not check `halted_at`; it later stamps `built_at`. If that timestamp is after the earlier halt, migration 091 rejects the build because `halted_at >= built_at` is false. No listed test catches this. | Make `pending` not haltable for the admin surface. This is simpler than widening the builder’s lifecycle contract. Add the pending/builder test below. |
| 3 | high | plan §4:215–220; Task 3:250–258; §5:287 | The only UI test passes if the panel is completely inert and never renders a stop control. There is no test of `readAdminBatchSummary`, positive submission, or safe serialization. The feature can therefore lack a working surface—or serialize outreach subject/body—and still pass. | Add positive panel, exact safe-projection, tenant/count, closed, and no-batch tests. |
| 4 | high | plan §5:279–283; intake:73,77,79 | The second-halt test names no second audit row but not the second `batch_halted` spine step. The mixed-case test only observes a closed parent, so direct `agent_runs` terminalization passes. The parentless test does not require `closeBatchIfSettled`. | Add explicit spine-cardinality, settlement-seam, live-sending-parent, and parentless-join tests. |
| 5 | high | plan §3.1:83–100; §5:285–286; intake:76 | “Same transaction” does not prove atomic rollback or audit-before-spine ordering. A test that merely observes both rows can pass when the audit uses the base client or runs after `recordStep`, preserving the stated lock-order regression. | Inject audit failure and assert rollback; separately instrument call order and shared transaction identity. |
| 6 | high | plan §4:222–226; §5:283; intake:87 | The property title says the admin arm “always writes” for every `BatchState`, contradicting the correct no-write outcomes for `halted` and `closed`. Its described implementation only checks reason selection and cannot prove that `OwnerHaltReason` has exactly two members or that `LatchHaltReason` is private. Existing `approval.test.ts:104–129` already property-tests owner-reason derivation over arbitrary lifecycle rows. | Replace this with exact type/export assertions. Spend the property test on arbitrary outreach-status multisets: only `rendered`/`queued` change, and a second halt is a fixed point with audit/spine cardinality one. |
| 7 | high | plan §3.3:167–170; intake:83 | The route design mandates `z.strictObject` rejection, but the locked title says the route “ignores” a supplied reason. An implementation returning 200 after ignoring `reason` can satisfy that title while violating the specified 400 contract; aliases are also uncovered. | Replace the title with explicit 400 rejection of `reason`, `haltReason`, and `halt_reason`, with no domain call or write. |
| 8 | medium | plan §3.2:143–146 | `liveOutreachCount` includes `sending` but is documented as “what a halt would stop.” The latch explicitly never stops `sending`, so the proposed admin projection can overstate preventable sends. No listed test catches this. | Expose `cancellableOutreachCount` for `rendered`/`queued` and a separate `sendingCount`, or otherwise correct the projection and UI semantics. |
| 9 | medium | intake invariants:31–36; edge cases:44–49 | No listed test covers flag-off availability, non-admin refusal, cross-origin refusal, overlong notes, exact audit payload, complete route result mapping, or tenant scoping of the new reader. | Add the concrete tests below. |
| 10 | medium | plan:9–10,59 | The cited glossary term **Outreach** does not exist; `CONTEXT.md:65` defines **Outreach row**. “Halt-latch” at plan:59 also is not the locked **Halt latch** spelling. | Use the exact glossary terms `Outreach row` and `Halt latch`. |
| 11 | medium | plan D2:33; `scripts/ci/admin-aal2-audit.ts:11–19` | D2 incorrectly says the admin AAL2 audit header establishes that `resolveAdminActor` reads `businessId` from the body. That audit only enforces reachable AAL2 gates and page parity; it does not prove body sourcing or tenancy. | Cite `src/app/api/_shared/channels/resolve-actor.ts:9–14,61–75` and do not claim `ci:admin-aal2` proves body tenancy. |
| 12 | medium | plan D3:34,70; `approval.ts:112–135,402–404` | D3 says `lockBatchForAction`’s UUID/text pairing depends on caller casing, but its query casts the input to UUID and correlates the parent through canonical `b.id::text`. It also says canonicalization occurs at the latch entry point while `latchHalt` requires an already-canonical ID. | State the real boundary: public action entry points canonicalize before locking so later text-key consumers, including the join, receive the canonical ID. |
| 13 | low | deviations:51–53 | The cited `feat-860-ask-regeneration-surface-deviations.md` is absent under this review root. It exists only in a sibling worktree, so the bare citation and named section are not resolvable here. | Qualify it as sibling-branch evidence or replace it with a repository-relative citation after #860 lands. |
| 14 | info | plan §3.1–§3.4, §4 | Expected pre-implementation artifacts are absent: `src/app/api/admin/solicitation/batch/halt/route.ts`, `src/app/api/admin/solicitation/batch/__tests__/routes.test.ts`, `SolicitationBatchPanel.tsx`, its test, `LatchHaltReason`, `LatchHaltOutcome`, `latchHalt`, `AdminHaltBatchInput`, `AdminHaltBatchResult`, `adminHaltBatch`, `AdminBatchSummary`, and `readAdminBatchSummary`. All other cited existing paths, functions, types, migrations, CHECK names, glossary entries, and sections were found. | No correction is needed merely for planned-new artifacts, but they must exist by implementation review. |

The listed tests do catch `sending` cancellation, rendered/queued cancellation, second audit-row creation, wrong-tenant action lookup, and missing AAL2—provided their assertions are substantive. They do not catch the second spine step, settlement ownership, type/export widening, audit ordering, browser data leakage, page `Promise.all`, or a nonfunctional UI.

MISSING FAILING TESTS

- `eval manifest contains 16 executable tests and no todo or skip markers` — assert every locked title is registered as an executable test and none uses `.todo`, `.skip`, or conditional skipping.
- `adminHaltBatch returns not_haltable for an unbuilt pending batch and leaves the batch builder able to complete` — assert no halt, audit, cancellation, or spine write, then assert construction can stamp `built_at`.
- `adminHaltBatch is monotone — a second halt adds neither a second audit row nor a second batch_halted spine step` — invoke twice and assert one audit, one halt step, and unchanged `halted_at`.
- `adminHaltBatch delegates parent settlement to closeBatchIfSettled and never updates agent_runs directly` — assert the seam receives the same transaction, canonical batch ID, and both tenant IDs; assert no direct `agent_runs` update.
- `adminHaltBatch leaves the send parent running while a sending outreach row remains live` — assert the row remains `sending`, close returns `not_settled`, and the parent remains running.
- `adminHaltBatch still calls closeBatchIfSettled for a parentless batch` — assert the join runs even though `recordStep` is skipped.
- `type contract: OwnerHaltReason is exactly owner_veto | owner_halt and LatchHaltReason is not exported` — assert exact bidirectional type equality and module export absence.
- `the admin halt route rejects reason, haltReason, and halt_reason as unknown fields and never calls adminHaltBatch` — assert 400 and no domain call/write for every alias.
- `adminHaltBatch rolls back the latch, outreach cancellations, and audit when writeAccountAuditLog fails` — inject audit failure and assert all domain changes roll back and no spine call occurs.
- `adminHaltBatch writes its audit row before recordStep and closeBatchIfSettled` — assert call order and that all calls receive the same transaction object.
- `readAdminBatchSummary returns only the admin-safe projection and never serializes outreach subject or body` — seed unique secrets and assert exact result keys and serialized absence.
- `readAdminBatchSummary returns null for a real batch under the wrong account or business` — assert both tenant predicates are required.
- `readAdminBatchSummary returns the latest tenant-scoped batch with correct cancellable, sending, and sent counts` — assert ordering and status-bucket semantics.
- `the business detail page reads the admin batch summary sequentially without Promise.all` — use an AST/source assertion to pin the pool-safety rule.
- `the admin halt panel shows a stop control for a haltable batch and submits the required note` — assert the positive interaction and POST payload.
- `the admin halt panel shows no stop control for a closed batch or when no batch exists` — assert both promised non-actionable states.
- `the admin halt panel distinguishes sending outreach from rendered and queued outreach that the halt will cancel` — ensure UI copy does not imply in-flight sends are stopped.
- `adminHaltBatch remains available when SOLICITATION_SEND_ENABLED is false` — assert successful halt with the lane flag disabled.
- `the admin halt route rejects a cross-origin POST before calling adminHaltBatch` — assert same-origin enforcement and no write.
- `the admin halt route refuses a non-admin caller even with an AAL2 session and writes nothing` — assert the role gate independently of MFA level.
- `the admin halt route rejects a note longer than 1000 characters and writes nothing` — assert the upper bound, not only missing/empty input.
- `the admin halt route maps halted and already_halted to 200, not_haltable to 409, and not_found to 404` — assert every declared wire mapping.
- `adminHaltBatch records solicitation_batch_admin_halted with the note, actor, entity, location, state_at_halt, and cancelled_count` — assert the complete durable audit contract.
- `invariants: halting is a fixed point and preserves every outreach status except rendered and queued for arbitrary outreach-status multisets` — property-test first-halt transitions, exact cancellation count, and second-halt idempotence.

VERDICT: REVISE

---

The stop hook requests `scripts/verify-gate.sh`, but the review contract explicitly forbids file creation or edits. I’ll inspect the script’s behavior first; I will only run it if it is demonstrably read-only.

---

I did not run `scripts/verify-gate.sh`: it creates `.feature/logs`, writes `gate-status.json`, deletes coverage output, and may rebuild/provision the test DB. That violates the explicit read-only constraint. No existing gate-status file is present.
