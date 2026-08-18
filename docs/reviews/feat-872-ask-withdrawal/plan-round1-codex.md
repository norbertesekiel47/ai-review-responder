# feat-872 — plan review round 1 (codex, adversarial, read-only)

codex thread id: `01a01383-9393-7fc1-ac89-867399b6c9bd`

Brief: scratchpad `codex-872-plan-review-brief.md` (eval-first: *can this eval pass while the feature is still wrong?*)

---

I’m using the `verify-spec` skill because this is a pre-implementation, adversarial plan/eval audit. I’ll first validate the governing project context and cited artifacts, then trace every named test against concrete wrong implementations and finish with compile/helper/transaction checks. I’ll remain strictly read-only.

---

The skill normally asks for an incremental `/tmp` findings file and sub-agent fan-out for large audits. I’m intentionally skipping both: the user’s read-only constraint forbids creating that file, and this session’s agent policy forbids delegation unless explicitly requested. I’ll preserve the same evidence standard in-memory and report the user-requested verdict format.

---

The locked contract and glossary are internally explicit: withdrawal must never cancel `sending`, must be legal only in `veto_window`/`approved`/`sending`, and must settle solely through `closeBatchIfSettled`. I’m now checking whether Task 1’s actual test bodies—not just their titles—pin each of those facts and whether its mocks/helpers make the assertions meaningful.

---

Two concrete issues are already confirmed. First, Task 1’s new withdraw-route block cannot use `SCOPED` as written because that constant is scoped inside the existing regenerate `describe`. Second, the planned UI discards the server’s `remainingLive`/`closed` fields and announces from a client-side count that excludes `sending`, so its own tests can pass while the owner sees a false remaining-count sentence. I’m continuing through the database attempts, refusal atomicity, and citation inventory.

---

Yes. Task 1 can pass while several materially incorrect implementations remain—and one proposed property test rejects a correct implementation.

| # | severity | plan section or file:line | finding | required change |
|---:|:---:|---|---|---|
| 1 | critical | [plan:449](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:449) | The property generator creates schema-impossible rows because all six timestamps are independent. Counterexample: only `sending_started_at` is set. `deriveBatchState` returns `sending`, `isWithdrawableState` returns true, but the asserted “approved batch” predicate is false. Correct code therefore fails the eval. It also spends the sole property test on a tiny enum equivalence already covered by examples. | Generate only schema-valid lifecycle rows, or replace this property with the full valid batch-state × current-attempt-status classification invariant described below. |
| 2 | high | [plan:1147](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:1147), [ApprovalPanel.tsx:568](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:568) | The server returns `remainingLive`/`closed`, but the existing `postLaneAction` discards both. The planned UI instead computes `liveCount - 1`, and its `live` count excludes `sending`. With one rendered target and one sending row, the batch remains open but the panel announces “Nothing more will send.” All planned fixtures use rendered rows, so they pass. “N will send” is also not a valid promise for rendered/queued rows that can still be halted or withdrawn. | Carry the server’s `remainingLive` and `closed` through the mutation result. Base the announcement on that response and use factual language such as “N messages remain active/in flight.” |
| 3 | high | [plan:260](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:260) | The integration matrix does not establish the domain boundary. No listed test covers `pending`, `expired`, successful withdrawal of `queued`, an ask with no attempt, an older superseded attempt versus the newest one, or `sent`/`failed`/`unknown`/cancelled-with-another-reason. It also misses the boundary where the target is the last waiting row but a `sending` row keeps the batch unsettled. These wrong implementations can pass. | Add the concrete state/attempt tests listed below. Make the property test classify every schema-valid state/status combination. |
| 4 | high | [plan:325](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:325) | Refusal tests generally snapshot only outreach. Because postgres.js commits on a normal callback return, an implementation can update the batch, ask, or steps and then return `not_withdrawable`/`not_live`/`not_found`; the listed tests still pass. The happy-path “same transaction” test also does not prove rollback atomicity. | Snapshot all four affected tables for every refusal. Add an abort-injection integration test proving cancellation, step creation, and settlement all roll back together. |
| 5 | high | [plan:154](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:154) | `assertOwnerWithdrawnAdmitted` only searches `pg_get_constraintdef` for the token. A malformed migration that admits `owner_withdrawn` under `queued`, `sent`, or every status passes that precondition. The integration test checks only legal `cancelled` and illegal `rendered`, leaving the other status arms unpinned. Keeping the 108 constraint name is acceptable, but it makes this stronger check essential because generic `assertSchemaReady` cannot distinguish a 108-only database. | Compare the normalized full CHECK definition with “108 plus exactly one additive value,” or exercise every non-cancelled status and assert the named CHECK rejects it. |
| 6 | high | [plan:624](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:624), [route.test.ts:419](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts:419) | The planned sibling `withdraw` describe uses `SCOPED`, but `SCOPED` is currently block-scoped inside the `regenerate` describe. Task 1 will not compile as written. | Hoist the fixture to file scope or define a withdraw-specific scoped session fixture. |
| 7 | high | [plan:373](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:373) | The tenant test covers an ask from another batch and scope mismatches against an owned batch, but it does not compare a real foreign-tenant ask with a random unknown UUID. A foreign ask may therefore be distinguishable—or writable—while all listed assertions pass. Route tests check input key names but not that `accountId` and `businessId` are the scoped session values. | Add result-equality and complete no-write assertions for foreign, other-batch, and unknown IDs; assert exact tenant values passed to the domain function. |
| 8 | high | [plan:292](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:292), [approval.integration.test.ts:318](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:318) | The plan says `BatchApprovalRow` must expose `veto_deadline_at`, but the existing `readBatch` returns neither that field nor `approved_by_user_id`. Consequently the promised approval/veto immutability assertion cannot be implemented as described. All approved fixtures also use `approval_method='owner'`, so an erroneous owner-only gate passes despite ADR 0021 applying to approved batches generally. | Extend `readBatch` with both fields and assert the complete approval quartet byte-for-byte. Add an `auto_policy` case. |
| 9 | high | [plan:1190](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:1190) | Panel tests use only rendered attempts. They do not pin queued eligibility, absence on sending/sent/withheld/failed/unknown rows, or absence on a closed batch. The planned `armedAskId` also survives a refetch that temporarily drops the row: confirmation disappears only because the row is absent, then silently returns armed if that ask reappears. | Add the UI status matrix, a closed-batch case, and a drop-then-reappear refetch test. Explicitly clear arming when the armed ask is absent from refreshed data. |
| 10 | medium | [ADR 0020:126](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/adr/0020-approved-content-is-immutable.md:126), [ADR 0021:108](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/adr/0021-ask-withdrawal-is-restraint-not-reapproval.md:108) | ADR 0020 still says halt is the only post-approval recourse and that the releaser contends with nothing that can cancel a row. ADR 0021 explicitly changes both claims, but the documentation task does not update ADR 0020 even though it is in the allowed edit surface. | Amend ADR 0020’s consequences or add a supersession note pointing to ADR 0021. |
| 11 | medium | [plan:3](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:3), [plan:777](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:777) | Mandatory cited-artifact failures: the required skills `subagent-driven-development` and `executing-plans` do not exist in the repository or installed skill catalog. The route comment attributes the “no internal ID rendered” rule to ADR 0012, but [ADR 0012](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/adr/0012-sentiment-blind-withhold-enum.md:1) concerns sentiment-blind withholding and contains no such rule. | Name available workflows or remove the unusable prerequisites. Replace the ADR 0012 citation with the actual authority or remove it. |
| 12 | low | [plan:23](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/docs/superpowers/plans/feat-872-ask-withdrawal.md:23), [approval.integration.test.ts:915](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal/src/lib/solicitation/__tests__/approval.integration.test.ts:915) | Additional citation drift: the cited halt-test range ends at 1010, but that describe currently continues through 1076. The shared scoped-route source header still describes three POST routes, and its `docs/directory.md` row describes only the existing readers; Task 3 adds another route and `readBatchAsk`, but Task 5 does not update either description. | Refresh the test range and include the shared route header/directory row in the documentation sweep. |

The listed eval does catch these specific failures:

- Cancelling a `sending` row: caught by the named sending-row integration test and SQL predicate pin.
- Missing last-row settlement or bypassing `closeBatchIfSettled`: substantially caught by the last-live integration case plus unit call ordering/count.
- A second `ask_withdrawn` step: caught by the repeated-withdrawal step-count assertion.
- Writing `solicitation_asks` on successful withdrawal: caught by the success snapshot.
- Sending `parentRunId`, reason, status, or an outreach-row identifier over the route wire: caught by the exact input-key assertion.
- Posting on the first tap, arming two rows, or choosing `replace` refresh: caught by the planned panel tests.

The LATERAL query itself is correctly shaped: it scopes the outer ask and inner attempt by both tenant keys and uses `ORDER BY attempt_no DESC LIMIT 1`. The problem is that the eval never proves that ordering behavior or the no-attempt result. The tenant-scope audit’s LATERAL handling is compatible with this query.

The planned lock and transaction order is otherwise sound: advisory batch lock → batch `FOR UPDATE` → scoped outreach mutation → step recording → `closeBatchIfSettled`. It maintains the existing lock order, uses the transaction handle throughout, and does not violate invariants #8, #12, or #15. No task exceeds the intake’s `allowed_edit_surface`. Migration 109 is the only planned schema change and is additive/re-runnable.

Cited-artifact check: all other referenced existing files, functions, types, migrations, glossary entries, and named sections were found. In particular, all six requested `CONTEXT.md` entries exist. Migration 109, the withdraw route, handoff document, `readBatchAsk`, withdrawal types, and the new list component do not exist yet, but are explicitly marked as artifacts to create rather than false citations.

## MISSING FAILING TESTS

1. `withdrawal is refused in pending and expired batch states and leaves every table unchanged`  
   Assert both results are `not_withdrawable` and batch, outreach, asks, and steps are byte-identical.

2. `withdraws a queued current attempt in an approved batch`  
   Assert queued becomes cancelled/owner_withdrawn and records exactly one step.

3. `withdrawal classification is exact for every schema-valid batch state and current-attempt status`  
   Property-test the valid cross-product: mutation only for veto/approved/sending plus rendered/queued; idempotence only for cancelled/owner_withdrawn; every other pair refuses without writes.

4. `withdrawal selects the highest attempt_no and never an older superseded attempt`  
   Seed an older cancelled attempt and a newer live attempt; assert only the newer attempt changes.

5. `an ask in the owned batch with no outreach attempt is not_live with null status and writes nothing`  
   Assert no fallback to an older/unrelated row and no mutation.

6. `withdrawing the last waiting row does not settle while another outreach row is sending`  
   Assert `remainingLive=1`, `close='not_settled'`, and parent/batch remain open.

7. `sent failed unknown and non-owner-withdrawn cancelled attempts are not_live and write nothing`  
   Pin the complete non-live status boundary.

8. `every withdrawal refusal leaves solicitation_batches solicitation_outreach solicitation_asks and agent_run_steps unchanged`  
   Cover `not_found`, `not_withdrawable`, and every `not_live` reason.

9. `withdrawal rolls back the outreach cancellation ask_withdrawn step and batch close when its transaction aborts`  
   Use abort injection and assert all three writes disappear together.

10. `foreign-tenant other-batch and unknown ask ids are indistinguishable and unwritable`  
    Assert identical public results and no changes in either tenant.

11. `auto_policy-approved batches allow the same withdrawal as owner-approved batches`  
    Prevent an accidental `approval_method='owner'` gate.

12. `withdrawal preserves approved_at approval_method approved_by_user_id and veto_deadline_at byte for byte`  
    Assert all four columns before and after a non-settling withdrawal.

13. `migration 109 preserves the 108 check verbatim and admits owner_withdrawn only under cancelled`  
    Verify every other delivery status is rejected by the named constraint.

14. `post-approval queued rows show Withdraw while sending sent withheld failed and unknown rows do not`  
    Pin the panel’s row-level eligibility.

15. `no Withdraw control renders for a closed settled batch`  
    Prevent a control on terminal batch state.

16. `a refetch that drops an armed ask permanently disarms it even if the ask later reappears`  
    Assert the reappearing row requires a fresh first tap.

17. `withdraw success announces the server remainingLive and closed result when a sending row exists`  
    Assert the client does not derive the count from rendered/queued UI rows.

18. `withdraw success copy does not promise that queued or rendered messages will send`  
    Require factual remaining-active/in-flight wording.

19. `withdraw route passes the scoped session account and business ids and ignores client reason status and outreach id fields`  
    Assert exact values, not only input key names.

20. `withdraw route is unavailable when either watch or send is disabled`  
    Exercise both halves of the dual feature gate independently.

VERDICT: REVISE

---


---

## Triage (orchestrator, `receiving-code-review`) — 2026-08-18

| # | verdict | resolution |
|---|---|---|
| 1 | **ACCEPT** (critical, verified: a row with only `sending_started_at` set derives `sending` and fails a correct impl) | Generator constrained to 091-valid rows via `fc.pre`; decision extracted as pure `classifyWithdrawal` with a second property over the full state × attempt-status matrix. Promised title kept verbatim. |
| 2 | **ACCEPT** | `LaneOutcome.done` carries `remainingLive`/`closed`; `Announce` gains a `done` param; copy "N messages left to send" / "…this batch is finished"; new panel test with a `sending` row present. Intake `user_visible_behavior[1]` corrected (deviations D3). |
| 3 | **ACCEPT** (partially — `pending` covered by the classification property, not a DB fixture: `seedBatch` cannot produce `built_at IS NULL`) | Added DB cases: `expired`, queued success, superseded-vs-newest ordering, no-attempt ask, last-waiting-row-with-sending-row, cancelled-for-another-reason. |
| 4 | **ACCEPT** | `snapshotWithdrawSurface` (batch + outreach + asks + steps) on every refusal; abort-injection rollback case via `abortingExecutor` (`SELECT 1/0`, 22012). |
| 5 | **ACCEPT** | Precondition asserts `owner_withdrawn` appears exactly once and inside the `cancelled` arm of `pg_get_constraintdef`; the CHECK test asserts every 108 member is preserved. |
| 6 | **ACCEPT** (verified: `SCOPED` is block-scoped at `:419`) | Withdraw describe defines its own `WITHDRAW_SCOPED`. |
| 7 | **ACCEPT** | Unknown-UUID probe added; all four `not_found` results asserted equal; both tenants' full surfaces snapshotted; route test asserts tenant VALUES from session/scope and ignores client `outreachId`/`reason`/`status`/tenant fields. |
| 8 | **ACCEPT** (verified: `readBatch` lacks both columns) | `readBatch` extended with `approved_by_user_id`/`veto_deadline_at`; quartet asserted byte-for-byte; `auto_policy` case added. |
| 9 | **ACCEPT** | Panel status matrix, closed-batch case, drop-then-reappear disarm case; arming CLEARED by effect, not merely hidden. |
| 10 | **ACCEPT** | ADR 0020 Consequences bullets amended (halt no longer the ONLY recourse; releaser may see rows CANCELLED under it, never replaced) + the earlier "Resolved by ADR 0021" note. |
| 11 | **REJECT** (skills half) / **ACCEPT** (ADR 0012 half) | `subagent-driven-development` and `executing-plans` exist in this session's skill catalog (the reviewer's sandbox cannot see Claude skills). ADR 0012 attribution is a PRE-EXISTING misattribution in three route comments; the plan now cites the halt/approve `toWire` precedent, fixes the `regenerate` comment while in that file, and records the other two as a follow-up (deviations D3). |
| 12 | **ACCEPT** | Halt-describe range → `:915-1076`; Task 3 updates `scoped-batch-route.ts`'s header (five routes) and its `directory.md` row (`readBatchAsk`, `withdraw`). |

Missing-failing-tests list: 1–2, 4–17, 19–20 absorbed as cases (titles adapted to the file's voice); 3 → the classification property; 18 → satisfied by the new copy (no separate test: the announce test pins the exact sentence).
