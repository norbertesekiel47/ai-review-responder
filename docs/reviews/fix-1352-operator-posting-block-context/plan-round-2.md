I’ll check revision 2 against the round-1 findings, trace the card readers through `mapStoredRows`, and verify the changed citations. I’ll keep this read-only and put any unrelated observations in the appendix.
The shared mapper does reach `getTurnForOwner` and `hydrateProposalReferences`, as well as the timeline and Apply/Restore response paths. `correctionOwed` also has the inputs it needs in the full settings response.

I found a few remaining inconsistencies in revision 2: six new test titles are specified but absent from the intake’s enforced list, T6 adds a file outside the allowed edit surface, and the new prompt rules disagree about whether a block may be mentioned when `correctionOwed` is false. I accept “card guaranteed, chat guided” as a limited delivery choice; I’m not treating the lack of a live-model evaluation as a blocker.
VERDICT: REVISE

The two main architectural fixes are sound: **`mapStoredRows` reaches the owner’s card read paths, and `correctionOwed` has the necessary inputs in `AutoApprovalSettingsResponse`.** The remaining revisions concern inconsistent contracts, missing gate enforcement for the added tests, the edit surface, and several citations.

**“Card guaranteed, chat guided” is a shippable limitation under your explicit decision.** I am not requiring a live-model evaluation or output validator. The prompt should still give internally consistent instructions.

| finding | addressed? | evidence |
|---|---|---|
| **1. D2 excluded pending transcript cards** | **Yes — read-path coverage fixed** | `getConversationForOwner` → `listProposalsForTurns` → `mapStoredRows`; `getTurnForOwner` → `listProposalsForTurn` → the same mapper; `hydrateProposalReferences` → `listProposalsByIds` → the same mapper. The timeline and Apply/Restore response readers also converge there. Moving the pending predicate onto the row is correct. |
| **2. Snapshot cannot distinguish all-off from another location armed** | **Yes — necessary data is available** | [`loadActiveLocationSettings`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/settings.ts:1074) returns **all active account locations**, their override state, and effective thresholds. Together with `accountDefault.threshold` and `posting.blocked`, this is sufficient to compute `correctionOwed` before reducing the snapshot to the selected location. The other-location fixture now explicitly exercises the original blind spot. |
| **3. Two unassigned titles; prompt tests mistaken for behavioral proof** | **Yes, subject to the inconsistencies below** | Both original titles now belong to T3 and assert the deterministic correction decision. T4 explicitly acknowledges that prompt tests do not establish model compliance. Your current instruction authorizes that limitation. The supplied intake does not itself contain the quoted “Card guaranteed, chat guided” decision, so the plan should record its actual provenance rather than claim the JSON contains it. |
| **4. D1’s one-directional staleness rationale** | **Yes** | D1 now covers both stale warnings and missing warnings, and acknowledges Apply’s current-readiness recheck. The blocked → clear → blocked integration test preserves the stored proposal while changing current account state. Its citation needs the correction below. |
| **5. Apply enabled in every blocked case** | **Yes** | T5 now states that posting information adds **no new disable condition**. The test requires an otherwise-applicable proposal, preserving readiness and confirmation requirements. |
| **6. Version/hash ledger explanation** | **Yes** | T4 correctly distinguishes the content-derived hash from the version label and instructs updating the existing version assertion. |
| **7. Stale purchasability comments** | **Partially** | The new T3 type no longer repeats the removed behavior, and T6 names the remaining comment sites. However, T6 adds `posting-status.ts` to the work without adding it to the intake’s allowed edit surface. |
| **8. Citation offsets** | **Partially** | The original bad pointers in the plan were corrected or removed. The two previously identified intake offsets remain, and several newly introduced pointers are inaccurate. Exact corrections are below. |
| **9. `ci:pool-fanout` scope** | **Yes** | T3 now accurately states that sequential reads are a house rule here and that the audit’s scan directories exclude Operator code. |
| **10. `buildSnapshot` ordering** | **Addressed, but the stated dependency is obsolete** | T3 explicitly preserves sequential execution and moves settings earlier. Under the rewritten T5, however, `mapStoredRows` independently reads posting status; it no longer consumes the already-read `settings.posting`. “T5 needs it before” is therefore stale. The reorder is harmless, but it is no longer required by this design. |
| **Added round-1 tests** | **Specified, but not locked into the gate** | All requested additions appear in the plan, including the extra sentence-envelope test. There are **six additions**, making **22 distinct planned titles**, while intake `tests_to_add` still contains only the original **16**. |

For finding 1, the convergence is broader than the plan says. There are **seven current reader functions**, not four: the four listed in T5, plus `listAppliedProposals`, `readProposalForAccount`, and `lockProposalForAccount`. All use [`mapStoredRows`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/proposals.ts:534). This strengthens the selected design; it does not reveal another bypass.

The mapper also dispatches restore cards through `restoreCardFacts`, which calls `policyCardFacts`. The implementation must carry posting status and row status through that branch as well as the ordinary `cardFacts` branch. There is no separate reader-level omission to fix.

## Defects introduced by fixes

**1. Medium — The new correction contract contradicts itself about `sentences`.**

T3 defines `sentences` as the copy map rendered in `reasons` order. But the newly assigned all-off test requires:

```text
blocked = true
reasons = [one or more actual reasons]
correctionOwed = false
sentences = []
```

That makes `sentences` a filtered presentation field rather than the complete account data described by its type and the new completeness requirement. An implementer must choose which instruction to violate.

The cleaner resolution is to preserve complete `reasons` and `sentences`, and let `correctionOwed` control whether the prompt mentions them. Adjust the all-off test to assert suppression through the boolean rather than erase the underlying sentences.

Missing failing test, **T3**:

`a blocked but unarmed snapshot preserves every Posting block sentence while correctionOwed is false`

Alternatively, explicitly define `sentences` as correction-only data and align the type, completeness test, and prompt rules with that choice.

**2. Medium — T4 introduces contradictory instructions for the same snapshot.**

Rule 2 says that when `correctionOwed` is false, the model must say **nothing** about a Posting block. Rule 4 then says to propose the requested operation **“and state the block alongside it”** without that condition. Rule 5 likewise requires block sentences after suspension without stating how it interacts with rule 2.

A blocked, entirely-off account requesting a supported configuration change triggers both rule 2 and rule 4. This is an instruction conflict, independent of the accepted uncertainty about model compliance.

Make rules 4 and 5 explicitly subordinate to the correction decision: preparation remains permitted regardless, while block wording appears only under the agreed correction predicate.

Missing failing test, **T4**:

`system prompt gates every Posting block mention on correctionOwed while preserving supported proposals`

This can remain a prompt-contract test; it does not require a live-model evaluation.

**3. Medium — The added regression tests are outside the enforced definition of done.**

The plan adds six titles:

- T1: byte-for-byte copy preservation.
- T2: runtime-off rejection through a settings write.
- T3: another location’s armed override.
- T3: complete sentences serialized into the prompt envelope.
- T5: pending transcript card.
- T5: blocked → clear → blocked rereads.

None appears in the revised intake’s `tests_to_add`. The gate reads that array in [`verify-gate.sh`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/scripts/verify-gate.sh:530), so the two tests that close the original production-path counterexample can still be omitted without failing title matching.

Add the six exact plan titles to the intake contract and correct D3/the appendix from **five** additions to **six**. The `240/460` estimates are present as requested; I found no reason to dispute those estimates.

**4. Medium — T6 cannot be implemented within the declared edit surface.**

T6 now explicitly modifies:

`src/lib/auto-approval/posting-status.ts`

That path is absent from `allowed_edit_surface` in the revised intake. Add it and correct D3’s statement that no path changed. This is a consequence of the accepted comment-sweep fix, not a request to broaden the feature.

**5. Low — The citation correction is incomplete, and several new citations need adjustment.**

| citation in revision 2 | actual source / correction |
|---|---|
| T5 `settings.ts:1169` — `loadSettingsAccount` | Line 1169 is blank. Declaration: [`settings.ts:1170`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/settings.ts:1170). |
| T5 `settings.ts:1220` — `buildPostingStatus` | Line 1220 is the last comment line. Declaration: [`settings.ts:1221`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/settings.ts:1221). |
| D1 and review appendix `apply.ts:480` — readiness recheck | Line 480 is blank. Read occurs at [`apply.ts:478`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/apply.ts:478); rejection is at 479. This also corrects the imprecise anchor in my previous report. |
| T4 `render.ts:191` — segment validation | Line 191 initializes the reasons array. [`validateTextSegments` starts at 190](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/render.ts:190), with prose checks at 194–198. It checks metric-adjacent counts and completion claims; it does **not** validate segment structure or prohibit every bare number. The claimed lack of posting-claim enforcement is correct. |
| T4 `model-call.ts:62` — both ledger values | Hash is at 62; version is at **63**. Cite 62–63. |
| T5/D2 `TurnBody.tsx:42` — card rendering | Line 42 builds the proposal lookup map. Actual [`ProposalCard` rendering starts at 49](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/app/(authenticated)/dashboard/operator/TurnBody.tsx:49). The underlying routing claim is correct. |
| Intake `context.ts:96` — `projectPolicyStates` | Still unchanged: declaration **95**, first parameter 96. |
| Intake `proposals.ts:370–397` — complete `CardFacts` / `policyCardFacts` precedent | Still unchanged: type begins **368**; function spans **384–400**. |

The other added or changed citations resolve: `mapStoredRows:534`, the corrected schema/comment/facts pointers, prompt section and hash function, the pool audit’s scan directories, the purchasability comment sites, and the newly cited round-1 report. The new production symbols and three `Create` targets are correctly absent at this pre-implementation stage.

## Appendix — new unrelated findings (untriaged)

None. I kept this pass to the accepted findings and the changes introduced by revision 2.

No files were changed, and no implementation gate was run for this verification-only review.
The stop hook is requiring a review-gate run before this turn can end. I’ll run the requested command and report its result separately from the plan verdict; it will generate verification artifacts, but I won’t edit source files or the plan.
VERDICT: REVISE

The hook-requested command completed and exited **1**:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
```

**25 checks passed; `feature-surface` failed.** Lint, typecheck, and the documentation test suite passed; that suite ran **538 tests across 17 files**.

The failure is specific to this pre-implementation checkout: the intake lists two planned files that do not exist yet:

- `src/lib/auto-approval/posting-block-copy.ts`
- `src/lib/auto-approval/__tests__/posting-block-copy.test.ts`

The gate ran in **docs-only mode**, so it skipped the full test suite, build, promised-test matching, and changed-line coverage. This result does not validate the proposed implementation.

Evidence is recorded in [gate-status.json](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/.feature/gate-status.json) and [feature-surface.log](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/.feature/logs/feature-surface.log). No source files or review documents were edited, and the tracked diff remains empty. I did not create placeholder implementation files to make the gate pass.

The revision-2 review verdict remains **REVISE** for the contract inconsistencies identified in the report.
