# Run E — bounded E-SC1 correction review

Reviewed only the uncommitted correction to `useProposalWrites.ts`, `RulesTimeline.tsx`, and the two parameterized `RestoreWorkflow.test.tsx` regression cases in the Run E worktree. This follow-up does not repeat the branch or database audit. Source/diff inspection only: no tests, provider calls, or production/test edits.

Root reports both intended RED failures reproduced and GREEN across four focused suites / 44 tests in `/private/tmp/run-e-review-corrections-tests.log`. That execution is attributed to root; this reviewer did not rerun it.

| Question | Source evidence | Result |
|---|---|---|
| Apply 409 after preparation in the current session | `useProposalWrites.ts:91-97` records every returned proposal by ID, including errors. `RulesTimeline.tsx:89-93` applies that response after combining local and page rows. | Fixed: the updated terminal row takes precedence even when the loaded source suppresses the local preparation slot. |
| Apply 409 on a Restore loaded after reload | The response map is populated independently of `preparedProposal`; `RulesTimeline.tsx:92` overlays the existing `page.pendingRestores` member. | Fixed: a null local preparation slot no longer prevents the returned stale state reaching the displayed card. |
| Stale recovery and correct source routing | `RulesTimeline.tsx:94-100` passes the overlaid row into the existing card and Refresh plan handler. `useProposalWrites.ts:76-83` targets `restoreSourceProposalId` for a non-applied Restore and sends `{}`. | Fixed: the card leaves its pending action branch and offers Refresh plan, which prepares from the applied source receipt. |
| Regression assertions | `RestoreWorkflow.test.tsx:122-159` starts either with persisted pending history or a fresh preparation, returns a real 409-shaped stale proposal, asserts absence of Apply and enabled Refresh plan, clicks it, and checks the exact source URL, empty request body and fresh returned card. | Both original failure variants are covered through the public component journey. They do not depend on a conversation card being present. |
| Newly introduced behavior | Overlay is keyed by server proposal ID; applied responses are excluded from the pending group and the existing successful-write refresh loads applied history. Other terminal responses pass through to the existing status renderer. | No concrete new actionable issue found within this correction. |

**Verdict: APPROVE — E-SC1 is resolved by the inspected correction.** No new findings. This is bounded correction approval, not a new full-gate, browser, staging, migration or documentation-closeout claim. Root retains final triage and release verification ownership.
