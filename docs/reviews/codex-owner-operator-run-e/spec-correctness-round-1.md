# Run E branch review — spec/correctness — round 1

Candidate: `890eea76c8c04b8d2acfcc73a895ec3112560e38`. Base: `30896acbcb2ee127131504e531f230fcfc7e4409`.

Independent native Codex review of Restore, clear override, refusal lifecycle and owner readback. Source was read from the pinned commit with `git show`; no production/test edits, test processes, mutations, provider calls or delegates. The supplied full-review GREEN fingerprint `032ea19aff8d9915e94c6c16fbab2cc037c2551bf344a67aa00c07baead3f9bd` is context from the root, not independently rerun evidence.

Read the committed `docs/reviews/finding-checklists/spec-correctness.md` in full and checked every accepted finding class for applicability. Applied the classes concerning stale UI state, omitted error-path assertions, returned identity binding, exact before/after state, and evidence claims; unrelated page-title, chart, banner and audit-tool classes do not apply to this diff. Closed Runs C/D were not reopened. Documentation closeout, deployed browser verification and staging remain pending, as stated in the brief.

## Finding

| ID | Severity | Confidence | Pinned source | Contract and failing scenario | Smallest correction |
|---|---|---|---|---|---|
| E-SC1 | P2 / medium | 98% | `src/app/(authenticated)/dashboard/operator/useProposalWrites.ts:91-104`; `src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx:86-92` | Spec §6.3 requires a stale card to say so and offer Refresh plan; §6.6 gives Restore the ordinary proposal lifecycle. A pending Restore loaded into the Rules timeline receives a 409 Apply response containing its now-stale or rejected proposal, but the timeline keeps rendering its old pending row and Apply action. The conversation-only patch does not update timeline state, and failure responses do not increment its refresh revision. | Route every returned proposal, including 409 results, into the timeline's displayed proposal state by ID. Preserve the returned terminal Restore card so stale status and Refresh plan render immediately. Cover both a freshly prepared Restore and one loaded after a page reload; do not rely solely on the local preparation slot. |

Concrete trace (source-confirmed, not a claimed browser reproduction):

1. Load Rules timeline with an applied source in `page.proposals` and a pending inverse in `page.pendingRestores`. The existing reload journey at `RestoreWorkflow.test.tsx:64-89` establishes precisely this public component state.
2. Change its parent policy through another owner tab/settings write, then click Apply on the still-visible Restore. `apply.ts:341-345` detects mismatched versions and returns stale. A prior Operator Apply can also have already marked the row stale; either response carries the persisted terminal proposal.
3. `useProposalWrites.ts:91-94` passes the returned row only to `conversation.patchProposal` (`OperatorClient.tsx:334-337`). With a reloaded timeline, `preparedProposal` starts null and the non-Restore setter condition does not populate it. With an immediately prepared Restore, the setter does update that slot, but `RulesTimeline.tsx:87-90` excludes it because its source is already loaded.
4. `useProposalWrites.ts:95-104` sets the error text but runs `reloadTranscript` only for successful HTTP results; the timeline revision therefore does not change. `RulesTimeline` renders the original pending row, so `ProposalCard.tsx:183-214` still offers Apply and never reaches its stale Refresh plan branch. Repeated Apply cannot succeed against that terminal proposal. Manual Refresh timeline or remount is required to reconcile it; the provided server row was already sufficient.

The correction should verify actual rendered state and next request: after a 409 with `status: stale`/`failureReason: version_mismatch`, the timeline card must lose Apply, show its stale explanation and offer Refresh plan; refreshing must POST to the stored source receipt's Restore endpoint. A pure hook test or an assertion only on error text would miss the observed component ownership defect. The current workflow suite covers successful preparation, reload, pagination and failed preparation but has no timeline Apply-409 scenario.

## Other examined contracts

| Area | Review result |
|---|---|
| Restore preparation and provenance | Same-account source reads; applied status, operation/contract, scope, receipt account/location/turn and affects validated. Button accepts only an empty body; model `restore_last` carries no historical state/source ID. Missing or corrupt history yields no settings mutation. |
| Inverse semantics | Nullable tone is restored through the trusted receipt path. Existing one-field changes derive one field; row absence is restored through existing clear semantics. A deleted policy row's inverse restores all three dials together, and undo restores absence. Current suspension survives clear and restore. |
| Freshness, exposure and execution | Fresh tokens are captured under scope locks; location policy tokens include the parent. Apply recomputes exposure from locked current state, requires exact typed expansion confirmation and repeats the shared writer gates. Actual post-write state forms the receipt. |
| Reused Restore and history | Source/version reuse does not move proposal ownership; supersession exempts reused IDs, and account-scoped reference hydration preserves readback outside the 50-turn transcript. Timeline keyset retains PostgreSQL timestamp precision and deterministic ID ties. |
| Refusals | Six strict reason tokens produce server-owned wording and server-minted distinct subjects. Duplicate references reject before writes. Fenced completion binds ledger subjects to stored reply segments; owner GETs expose distinct `refused` arrays. Restraint continues category-only projection. |
| Evidence limits | Test bodies and source were reviewed, not executed. No deployed behavior, actual model classification, migration promotion, or documentation closeout is claimed verified by this report. |

**Verdict: REVISE — E-SC1 is actionable.** Root owns triage, corrections and subsequent verification. No additional speculative findings are promoted.
