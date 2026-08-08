I’ll use the `verify-spec` skill because this is a read-only audit of a plan against code and a locked intake. I’ll first read its workflow and the repository’s authoritative context, then trace every cited artifact and test claim.
The skill calls for parallel verification on audits this large, so I’m splitting the independent evidence checks: one pass on Task 1’s test strength, one exhaustive citation/path audit, and one intake/plan consistency pass. I’ll independently re-check any decisive “missing” finding before the verdict.
A decisive issue has surfaced: deleting the helper has an additional live-DB test import that the plan’s “no stragglers” command would find, but no task updates that file. I’m now checking whether that is merely a compile omission or also the missing real-Postgres regression pin the eval needs.
Yes. The 11 promised tests can all pass while material invariants remain broken. Separately, the plan as written cannot reach a green full gate because it misses two pre-existing test updates.

The working tree contains the untracked plan under review. I made no edits and ran no test suite.

## Eval holes

| Hole | Missing failing test title | What it asserts |
|---|---|---|
| `owner_unreachable` is self-referential: the writer test, poller fixtures, and readers all use the same constant. Changing its persisted value would strand historical rows while tests remain green. | `OUTBOX_COMPLETION_REASON preserves the persisted owner_unreachable wire value` | Pins `OWNER_UNREACHABLE` to the durable compatibility value `owner_unreachable`. |
| The plan omits the existing real-Postgres owner-marker/CAS test. Mock assertions can pass if the helper receives the right constant but persists the wrong value. | `markOutboxCompletedWithReason preserves owner_unreachable and rejects a superseded attempt against live Postgres` | Retargets the existing poller integration test: stale N−1 leaves the row dispatched/NULL; N completes it with `owner_unreachable`. |
| None of the helper tests proves the requested outbox ID scopes the `UPDATE`. A missing or mis-bound ID could update unrelated dispatched rows. | `markOutboxCompletedWithReason updates only the requested outbox row` | Seeds two dispatched rows, calls the helper for one, and proves the neighbor remains dispatched with `completion_reason NULL`. |
| The property test fabricates `rowMatches`; it never asserts `status = 'dispatched'` is in the SQL. A terminal row could be overwritten. | `markOutboxCompletedWithReason does not overwrite a non-dispatched terminal row` | Calls the helper against completed/failed rows with a matching attempt and proves status/reason remain unchanged. |
| The generalized helper may stop setting `completed_at`, violating the intake’s “same emitted UPDATE” requirement. | `markOutboxCompletedWithReason sets completed_at when recording a durable reason` | Verifies a successful reasoned completion has non-NULL `completed_at`. |
| Pending refusals are not reason-pinned. The two existing pending tests are retargeted only to call-count assertions. Declined, expired, and missing are covered, but pending could receive NULL or `owner_unreachable`. | `guardImportConsent persists completion_reason=import_consent_blocked on the outbox row for a live pending import` | Uses live Postgres and asserts a live pending offer becomes completed with `IMPORT_CONSENT_BLOCKED`. This also covers the NULL-deadline case once the existing derivation test proves it resolves to pending. |
| Both NotificationWorker tests use a job without `outbox_attempt`; the old test accepts any string ID. The worker could forward the wrong ID or drop a real attempt. | `NotificationWorker forwards the dispatched outbox id and attempt to the generalized reason helper` | Supplies explicit `outbox_id` and `outbox_attempt: 7`, then asserts the exact call `(sql, id, OWNER_UNREACHABLE, 7)`. |
| The promised transaction-handle test cannot distinguish `tx` from outer `sql`: the mock supplies the same object, and `inTransaction` only records callback timing. | `guardImportConsent passes the exact transaction executor to the reason completion helper` | Uses distinct outer/transaction sentinels and asserts the helper receives the callback’s transaction object. The existing forced-race integration test does independently pin shipped serialization, so the invariant is not wholly untested; the promised unit title is still overclaiming. |
| Nothing proves ordinary completion remains reasonless. An accidental change to `markOutboxCompleted` could stamp generic completions and violate the legacy/other-topic NULL invariant. | `markOutboxCompleted leaves completion_reason NULL for a generic completion` | Completes an ordinary dispatched row and asserts `completion_reason` remains NULL. |

The four specifically retargeted tests otherwise retain their original `outboxId`, `attempt`, and `inTransaction` evidence. The defect is that a fifth existing assertion was overlooked.

All 11 promised `it(...)` titles match the intake’s `tests_to_add` strings verbatim.

## Cited-artifact check

| Citation | Exists? | Correction |
|---|---:|---|
| Plan and intake paths | Yes | Both resolve; the plan is currently untracked. |
| `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.3 | Yes | §5.3 is lines 173–214 and contains the locked derived-expiry, worker-locus, fail-closed, and runbook decisions. |
| `docs/adr/0010-owner-unreachable-outcome.md` | Yes | Exactly 184 lines, as claimed. |
| Claimed ADR 0010 structure: Status / Context / Decision / Consequences / Alternatives considered | **No** | ADR 0010 has Status, Context, Decision, Consequences, and Post-implementation review—but no `Alternatives considered` heading. |
| `docs/adr/0015-consented-import-unflagged-replacement.md` | Yes | Exists and is cited by the current review-import context row. |
| `docs/reviews/feat-679-import-consent-worker-guard/review-adversarial.md` | Yes | Contains the insertion-boundary/trigger challenge later triaged to #695. |
| Task 1: `src/lib/shared/__tests__/outbox.test.ts` | Yes | Existing owner-unreachable property block is at lines 166–196. |
| Task 1: `worker/jobs/notification/__tests__/NotificationWorker.test.ts` | Yes | Declaration line 12, mock binding line 48, reset line 223, test line 391, destructure line 403. |
| `vi.hoisted` “~line 36” in NotificationWorker test | **Inaccurate** | The `vi.hoisted(...)` call starts at line 14; line 36 is the mock’s factory entry. |
| Task 1: `worker/jobs/zernio/__tests__/job-eligibility.test.ts` | Yes | Same-transaction discussion at lines 11–12 and 43–56; NULL-deadline assertion at line 223; exact describe block at line 167. |
| Task 1: `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts` | Yes | `outboxStatus` is line 191; guard call begins line 382; it passes `silentLogger` at line 386. |
| Integration logger named `testLogger` in plan sample | No under that name | The suite’s logger is `silentLogger`, defined at lines 103–107. The plan does instruct the implementer to reuse the actual name. |
| `resetToLivePendingOffer`, `insertHandRow`, `outboxStatus` | Yes | Integration test lines 140, 158, and 191. |
| `pushConsentState`, `runGuard`, `completionCalls` | Yes | Unit test lines 113, 117, and 58. |
| `mkTaggedResult`, `sqlReturnQueue`, `sqlCalls`, `resetMockSql`, `mockLogger` | Yes | All exist in the current unit harness. |
| `execMock` | Yes | Outbox test line 36. |
| `mock-sql.ts:99-103` | Yes | Those lines explicitly document same-object transaction callbacks; implementation passes `mockSql` at lines 143–153. |
| `src/lib/shared/outbox.ts:127-142` | Yes | Exact current `markOutboxOwnerUnreachable` implementation. |
| `NotificationWorker.ts:15,69` | Yes | Import at 15, invocation at 69, warning immediately above at 68. |
| `src/lib/shared/outbox-completion-reason.ts` | Yes | `OUTBOX_COMPLETION_REASON` at line 4; owner value at line 5; age floor at line 10. |
| `guardImportConsent`, `ImportConsentGate`, `ImportConsentBlockReason` | Yes | `job-eligibility.ts` lines 177, 131, and 134. |
| `guardZernioJobEligibility` and its three plain completions | Yes | Function line 72; completions at 92, 101, and 116. |
| `importConsentStateSql`, `recordImportDecisionAndEnqueue`, `enqueueInitialImport` | Yes | `import-consent.ts` lines 193, 352, and 631. |
| `dispatchedRow`, `hasAttempt`, `warnOutboxNoop`, `markOutboxCompletedIfOwned` | Yes | `outbox.ts` lines 19, 8, 43, and 101. |
| `checkOwnerUnreachable` | Yes | Defined at `checks.ts:203`; reads `OWNER_UNREACHABLE` at line 219. |
| `checkZeroDeliveryNotifications` distinctness predicate | Yes | Uses `IS DISTINCT FROM OWNER_UNREACHABLE` at `checks.ts:174`. |
| `NotificationFailoverPoller` owner reader | Yes | Reads the constant at lines 203 and 240. |
| Migration 083 / existing nullable column | Yes | `083_outbox_owner_unreachable.sql:19` adds `completion_reason TEXT`; migrations log corroborates it. |
| `CONTEXT.md` Import consent bullet around line 26 | Yes | Exact bullet and exact “all no-op-complete with a logged reason” sentence exist at line 26. |
| `.claude/CLAUDE.md` review-import-consent row | Yes | Exists at line 101 and currently cites ADR 0015 plus the transaction invariant. |
| `scripts/verify-gate.sh` | Yes | Exists. |
| `docs/adr/0016-import-consent-enforcement-locus.md` | No, expected | Correctly marked `Create` in Task 4. |
| Planned `markOutboxCompletedWithReason`, `OutboxCompletionReason`, `IMPORT_CONSENT_BLOCKED` | No, expected | These are Task 2 outputs, not stale current citations. |
| Required `subagent-driven-development` skill | **No** | No such installed/repository skill exists. The plan cannot mark it “REQUIRED” without installing or replacing that workflow. |
| `codebase-design` skill | Yes | Installed under the user’s agent skills. |
| All 11 promised test-title literals | Yes | Each appears exactly once in the plan code and matches the intake verbatim. |

## Plan findings

| Severity | Location | Finding |
|---|---|---|
| Blocker | Task 2 Files / Steps 4–5 | A fifth affected test file is omitted: `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts` imports the deleted helper at line 55 and calls it at 365/373. Because `tsconfig.json` includes `**/*.ts`, Task 2’s claimed `pnpm typecheck` PASS is impossible. The intake’s allowed edit surface also excludes this necessary file. |
| Blocker | Task 1 Step 3 | The plan says four existing block tests must be retargeted, but there are five. The missing-business test at `job-eligibility.test.ts:243–251` still expects `mockMarkOutboxCompleted`; it will remain red after Task 3. |
| High | Task 4 spec amendment | “Leave every existing sentence intact” makes §5.3 self-contradictory. Its current statement that manual SQL means “no enqueue-time gate can ever cover it” is disproved by the challenged table trigger, whose advantage is precisely covering manual inserts. Reaffirm the worker locus, but qualify or replace that sentence. |
| High | Task 4 `CONTEXT.md` and `.claude/CLAUDE.md` updates | Both authoritative docs currently name `markOutboxCompleted(tx, …)`. Task 4 only appends new material/ADR references, leaving those symbol references stale after Task 3 changes the call to `markOutboxCompletedWithReason`. |
| High | Task 1 integration assertions | The plan reads `completion_reason` using bare `'import_consent_blocked'` literals, contradicting the intake invariant requiring `OUTBOX_COMPLETION_REASON` at read/write sites. Import and assert the constant. |
| High | Task dependency graph / Gate | The graph allows T4 to run in parallel with T2/T3, but the gate is stated only as “After T4.” It needs the join `{T3, T4} → Gate`; otherwise T4 may finish first and start verification before production implementation completes. |
| Medium | Task 2/3 comments and Task 4 glossary text | The plan repeatedly says the refusal state is “re-derivable” from the current business row. That is false for a deleted/missing business and historically false when a pending refusal is followed by acceptance. The historical state is in the structured log; the durable marker only proves that a refusal occurred. |
| Medium | ADR operator-query explanation | With no historical backfill, NULL does not universally mean genuine import: legacy refused rows remain NULL. Qualify the query as reliable for post-deployment refusals or explicitly document the legacy ambiguity. |
| Medium | §1 and Task 4 ADR rationale | “An immutable migration means the trigger predicate can never be kept in sync” is too absolute. A later migration can replace a trigger function. The valid objection is unavoidable duplicate spelling and unenforced drift/deployment risk, not literal impossibility. |
| Medium | Task 4 ADR precedent | ADR 0010 exists and has the claimed length, but lacks the asserted `Alternatives considered` section. Either choose a matching precedent or say ADR 0016 adds that section beyond ADR 0010’s structure. |
| Medium | Plan header | The required `subagent-driven-development` skill is unavailable in the repository and installed skill set. |

VERDICT: REVISE

1. Add `NotificationFailoverPoller.integration.test.ts` to the plan and intake edit surface; retarget its live helper test and run it explicitly.
2. Retarget the overlooked missing-business pre-existing test.
3. Close the eval holes above, especially persisted owner compatibility, exact row/status scoping, pending refusal, NotificationWorker ID/attempt forwarding, and generic-completion NULL behavior.
4. Make the transaction-handle promised test distinguish outer `sql` from `tx`; retain the forced-race integration test.
5. Correct §5.3 instead of append-only amendment, and update stale helper names in both authoritative context documents.
6. Replace bare completion-reason literals with the vocabulary constant and qualify legacy query semantics.
7. Add the `{T3,T4} → Gate` dependency.
8. Correct the unavailable skill, ADR precedent claim, and over-absolute trigger-maintenance rationale.
Gate evidence is not applicable: this was a read-only review of an unimplemented plan, not a completion claim. Running `scripts/verify-gate.sh` could mutate test state or generated artifacts, conflicting with the explicit read-only instruction. No files were changed.
