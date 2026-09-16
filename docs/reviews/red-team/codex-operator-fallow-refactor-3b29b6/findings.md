# Red-team verification — Owner Operator fallow refactor

## Result

**INCOMPLETE_ORACLE**, HIGH risk, round 1. Root rejected the initially reported P0 as a wrong-target mutation: its receipt timestamp change falls outside the selected case's stated VoiceState assertion. The survivor remains inconclusive, not equivalent. No behavior delta in the unmutated Apply refactor was established. This is an incomplete pass: the generic 30-launch budget measured 15 of 497 in-scope cases; 482 remain unmeasured, and four measured cases have inconclusive mock-fixture failures. Neither green gate evidence nor 100% changed-line coverage removes these limitations.

| Severity | Open | Finding |
| --- | ---: | --- |
| P0 | 0 | RT-001 rejected by root; attempt retained as inconclusive/oracle |
| P1 | 0 | No additional evidenced finding |
| P2 | 0 | No additional evidenced finding |

Counts: {"inventory_total":501,"killed":10,"survived_confirmed_p0":0,"equivalent":0,"inconclusive":5,"skipped_budget":482,"excluded":4,"findings_total":1,"p0_open":0,"p1_open":0,"p2_open":0,"accepted_risk":0,"fixed":0,"rejected":1}. Status precedence selects INCOMPLETE_ORACLE ahead of INCOMPLETE_BUDGET. Five measured cases are inconclusive: four mock-fixture failures and one wrong-target survivor.

## Immutable inputs and restoration

- Branch: codex/operator-fallow-refactor.
- Fork and merge-base: 87591310acb2a0a6edddd2bc8b5ff0cd24c9e301.
- Measured HEAD: 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62.
- Intake SHA-256: e48a127da09d1687186b285c0304b60c58ecc59d110135f7c30658391f3994b0.
- Inventory was complete and frozen before launch 1 at /private/tmp/operator-redteam/inventory-frozen.json (SHA-256 8c9b7e688d921a1429ac9d6be4c267f60f2cbd0c224fbb426da06734b195075b).
- Clean committed tree and watchers-none were independently checked. Round 1 opened through the journaled runner. Every baseline/mutant used its supervised argument-array launcher, regex-escaped full title, 120-second timeout, temporary HOME, approved localhost test DB, and scrubbed dotenv. No schema reset, provider call, runtime fix or test edit occurred. There was one mutant per measured case.
- The runner finalized between pairs. After launch 30 the invoking root separately finalized the last mutation and dotenv swap, confirmed all process groups reaped and journal closed, and confirmed clean tracked status at the pinned HEAD before authorizing these report writes. The verifier rechecked clean tracked status, HEAD and journal before writing. Reports are the only new artifacts.

## Duty 1 — complete inventory and mutation evidence

Direction A: no changed Vitest cases, test fixtures, snapshots or goldens. The executable structured-runner evaluator changed; all its reachable test importers enter Direction B. Direction B searched every tracked TS/TSX/MJS file for relative and @/ module references, resolved direct imports first, then took the complete transitive reverse-import closure of all 18 changed executable files. Existing unchanged tests were retained. All 18 parameterized declarations were expanded from their static tables; duplicate unnamed each cases retain explicit case indices. The inventory contains 501 identities across 44 test files: 497 in scope and four Operator Playwright cases excluded from mutation but reviewed for fragile assertions. No deleted test and no changed production file without covering candidates was found. All 501 rows, including every skipped case and reason, are in findings.json; discovery mappings and declaration locations remain at /private/tmp/operator-redteam/discovery.json. Transitive closure is deliberately conservative and was not narrowed to fit the cap.

### RT-001 — rejected P0 (original attempt preserved)

Location: src/lib/agents/operator/__tests__/apply.integration.test.ts:440.

Exact test: applyProposal (live DB) applyProposal receipt after equals the committed voice state and flags a difference from the stored after.

The live-DB test executes successful voice Apply and receives the persisted Receipt. The mutation replaces updatedAt: facts.updatedAt at apply.ts:315 with the fixed nonempty timestamp 2000-01-01 00:00:00+00. buildVoiceReceipt at apply.ts:852-855 passes that value to computeVoiceVersionToken; version-token.ts:45-49 returns it unchanged, and recordApplied stores the resulting Receipt in the transaction. This is an executed production value, not a mock argument. The test asserts receipt.after, differsFromPreview, applied status and the actual written tone, but never compares receipt.versionToken.after.updatedAt with the committed business timestamp. Both single-test baseline and mutant passed. A year-2000 after token is semantically different from the current write timestamp, so the mutation is neither equivalent nor on an unexecuted branch. The initial verifier interpreted this as an assertion gap; root rejected that interpretation because the selected test specifies VoiceState correctness, while another existing case asserts the exact timestamp. Unmutated HEAD still forwards the correct writer timestamp.

Baseline and mutant evidence: /private/tmp/operator-redteam/case-9-baseline.json and /private/tmp/operator-redteam/case-9-mutant.json, with sibling launch and assert-one-test logs. This finding does not claim the original implementation was wrong, the entire suite would survive the mutant, or that current production has a year-2000 token. The matching timestamp oracle already exists at apply.integration.test.ts:302. The selected state-only case was the wrong target for this mutant. No assertion was added; the attempt is inconclusive/oracle and retains all raw evidence.

### Measurements

| Case | Outcome | Evidence |
| --- | --- | --- |
| rt-0126 | killed | case-0 baseline/mutant and assert-one-test logs |
| rt-0127 | killed | case-1 baseline/mutant and assert-one-test logs |
| rt-0137 | inconclusive | case-2 baseline/mutant and assert-one-test logs |
| rt-0138 | inconclusive | case-3 baseline/mutant and assert-one-test logs |
| rt-0139 | inconclusive | case-4 baseline/mutant and assert-one-test logs |
| rt-0140 | inconclusive | case-5 baseline/mutant and assert-one-test logs |
| rt-0142 | killed | case-6 baseline/mutant and assert-one-test logs |
| rt-0117 | killed | case-7 baseline/mutant and assert-one-test logs |
| rt-0118 | killed | case-8 baseline/mutant and assert-one-test logs |
| rt-0120 | inconclusive (wrong-target survivor) | case-9 baseline/mutant and assert-one-test logs |
| rt-0122 | killed | case-10 baseline/mutant and assert-one-test logs |
| rt-0155 | killed | case-11 baseline/mutant and assert-one-test logs |
| rt-0156 | killed | case-12 baseline/mutant and assert-one-test logs |
| rt-0261 | killed | case-13 baseline/mutant and assert-one-test logs |
| rt-0262 | killed | case-14 baseline/mutant and assert-one-test logs |

The four mock-fixture inconclusive cases are rt-0137, rt-0138, rt-0139 and rt-0140. The fifth inconclusive case is the wrong-target survivor rt-0120. Their changed branch encounters a sequence-dependent mock SQL queue and throws before a behavioral assertion. These are oracle limitations, not kills. Ten other mutants failed semantic assertions on actual result kinds, written field sets, or receipt actor identity. Budget: 30/30 launches, counting baselines; no second round or other-branch grant was used. All unexecuted in-scope rows remain skipped-budget.

## Duty 2 — fragile assertions

There are no changed assertions to classify. Reviewed all four excluded cases in e2e/operator.spec.ts and inspected the existing measured Apply assertions. No newly introduced absence-of-tag proxy, rendered string-count assertion, or unordered-contract order assertion exists in the diff. Apply's lock-order assertions are contractual: account/business locks precede proposal locks. The four sequence-sensitive SQL fixture failures are recorded as oracle limitations above, not mislabeled semantic mutation kills. Existing unrelated assertions were not opened as new review fronts.

## Duty 3 — documentation versus HEAD

Ran the installed prevalidate-plan.py against the changed plan and intake mirror. Intake passed. Plan reported exactly the two unavailable historical refs de433450 and 4cfaac0b; its prose explicitly states they do not resolve and names replacement immutable bases, so these are accurate disclosures rather than false claims. No plan path:line citations exist. The added checklist citation /private/tmp/operator-fallow-plan.md:55 resolves to the original full-audit acceptance paragraph; it is historical review evidence, not the final amended contract. Directory rows were checked against gate.ts, useProposalWrites.ts and useOperatorConversation.ts. Roadmap and architecture entries explicitly describe in-progress verification and do not claim browser or release completion. Existing historical paragraphs outside added hunks were excluded from new findings.

Independent evidence readback: .feature/gate-status.json is full-mode passed; its fingerprint names the pinned HEAD and intake. Gate logs contain 16,218 passing / 11 skipped full local-DB tests; changed coverage is 305/305 added instrumented lines; desktop and mobile E2E each show 30 passing / 54 skipped. Both raw historical-base audits and coverage-informed Fallow are labeled separately and passed in the gate. These are inspected existing gate results, not a rerun by this verifier. Computer Use remains unavailable and Operator journeys at 390/1440 are not claimed verified. The four Operator E2E cases are inventory exclusions, never mutation passes. No PR Fallow result was supplied or inferred.

## Duty 4 — sibling search scope and findings

Exact search families and scope:

1. `requireOwnerWithAccount|requireOperatorReader|withSameOrigin` in src/app/api/operator. Conversation and timeline use the extracted reader; the turn GET retains its existing inline read gate. All POST routes retain their outer same-origin wrappers. The remaining inline turn reader is unchanged and outside the targeted clone group; no missing behavioral fix is asserted.
2. `return writeRefusedResult|writeVoice|preparePolicyPlan|currentVoiceContract|currentPolicyOperation|recordVoiceApplied|recordPolicyApplied` in src/lib/agents/operator/apply.ts. Compared every moved voice/policy contract, writer-plan and receipt branch to the pinned base. The operation/token gates, authority/freshness order, same-transaction settings/Receipt persistence and policy/voice distinctions remain present. No unmutated Apply behavior delta was found.
3. `versionToken|updatedAt|receipt` in src/lib/agents/operator/__tests__/apply.integration.test.ts, plus the exact version-token constructor and receipt builder. The first receipt integration test at lines 300-302 compares before token, verifies that the after timestamp moved, and compares it to the exact database timestamp. The initial review omitted line 302; root caught this, and independent reinspection confirms it. The selected case at line 440 tests receipt.after VoiceState and preview divergence. This evidence rejects RT-001 and identifies the survivor as a wrong-target oracle measurement. The unit replay fixture at apply.test.ts:296-298 also contains WRITTEN_AT; that fixture alone is not an execution-timestamp assertion.
4. Diff comparison of ordinary/Restore card projections in proposals.ts, Restore input derivation/preparation, policy snapshot mapping and turn Restore fencing. Searches were limited to the changed production files and their identified callers/importers, excluding unrelated settings/worker refactors, archived evidence runners, historical sidecars and migrations.
5. `not.toContain|toHaveLength|toHaveBeenCalledTimes|nth|order` in e2e/operator.spec.ts returned no incidental-count/order candidates. Other assertion review remained restricted to changed assertions and measured tests.

Complete import-search scope and all test-to-production mappings are preserved in discovery.json. A zero new sibling defect result is not an assertion of complete mutation coverage.

## Duty 5 — operational completeness

The diff adds no operator-actionable terminal or swallowed failure path. Apply and Restore response switches are moved intact; their existing catch/reportCaughtError sites retain endpoint tags and errors. Existing Apply retained-veto and Restore invariant alert rows (beta-launch-alerting.md rules 12/13) were compared to those unchanged emitters: signal identity and endpoint/message filters, error level, default exception-stack grouping, every-event cadence with 60-minute action throttle, and Discord destination/operator action are unchanged. No orphaned newly emitted signal or newly documented rule appears in the diff. Staging configuration/delivery and production enablement were not reverified or claimed by this static duty.

## Authorizations

None. The authorizations array is empty. Root rejected RT-001 on source evidence; no risk was waived. Generic round-1 execution authority does not waive unresolved oracle results, budget incompleteness or missing browser evidence. Historical Runs C/D/E budgets were not applied.

## Evidence retention

Full raw measurements stay at /private/tmp/operator-redteam/measurements.json (SHA-256 2e3647ab3e07d95112d7d53f2a97d5e4cd532e4936ee3772f81dd88e71772193). Each case retains baseline/mutant JSON, supervisor log, assert-one-test log, and intended mutant source. Those local scratch artifacts are not runtime changes and are not committed. Permanent inventory, classifications, arbiter reasoning, pins and counts are in findings.json. No secret, environment content, review text or response text is reproduced here.

## Red-team findings rejected

Root rejects RT-001: the selected receipt-state test at src/lib/agents/operator/__tests__/apply.integration.test.ts:440 tests VoiceState/preview divergence, while src/lib/agents/operator/__tests__/apply.integration.test.ts:300-302 already asserts the receipt after-version timestamp equals the actual database timestamp. The timestamp mutant targets a different behavioral contract; it proves neither a fake state test nor a product regression.

Disposition: rejected, mirrored in findings.json. Root must include this rejection and its source evidence in the PR description. No measured row was silently omitted or relabeled equivalent.


## Root-reviewed continuation result

Generated: 2026-09-16T05:29:58.549Z. Status: **CLEAR**. Original admission: `03502fdcee60e61b891636a625c95c6a9dadec9b`; corrected controller: `b1fe8af88e84167318e7ba3a662e0be1539560c4`.

Round 1; 354 cumulative launches. Preserved all 501 original identities, 15 verifier identities, 10 historical kills, four historical exclusions, and historical findings including RT-001 rejection. Applied exactly 355 approved discovery corrections with their pinned reasons.

This appendix reports only explicit root decisions. Original measurements and their suggested outcomes are unchanged. Rows without a selected root verdict retain their checkpoint outcome, or remain unmeasured verifier rows; they are not credited as kills.

Counts: `{"inventory_total":516,"killed":157,"survived_confirmed_p0":0,"equivalent":0,"inconclusive":0,"skipped_budget":0,"excluded":359,"findings_total":1,"p0_open":0,"p1_open":0,"p2_open":0,"accepted_risk":0,"fixed":0,"rejected":1}`

### Root-selected verdict evidence

| Candidate | Attempt | Root verdict | Reviewed at | Measurement SHA256 | Reason |
|---|---:|---|---|---|---|
| rt-0005 | 1 | killed | 2026-09-16T04:25:06.124Z | f6f8102b620e6bf4f2f212ea408eb083c72f54c8f4c13efcb2639ce67f1a8173 | Root reviewed the actual failure against this semantic mutation: The changed completion-refresh callback must clear the active turn when the poll becomes completed. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:203:67). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0006 | 1 | killed | 2026-09-16T04:25:06.128Z | ad30d126f38360286e8f12c82b1c488f0da3df4f01f2cf076ba661c0b330bcde | Root reviewed the actual failure against this semantic mutation: The extracted completion callback is a dependency of useTurnPoll's effect. Losing its memoization restarts the poll after the timeout state renders, so the four-minute stop is no longer durable. This measures callback identity in the changed hook, not a mutation of unchanged cadence constants. Observed: AssertionError: expected 75 to be 60 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:236:34). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0007 | 1 | killed | 2026-09-16T04:25:06.132Z | 867ff439d87eb38961fbeb49ba6cc342e9a157e8aa4a620a3f0f07b5b03d708b | Root reviewed the actual failure against this semantic mutation: The conversation GET resolves EMPTY_CONVERSATION and commits a new view, causing a screen rerender. A newly allocated completion callback changes useTurnPoll dependencies, aborts the first unresolved request, and starts a second. This measures the extracted callback's required stable identity while a request is unresolved. Observed: AssertionError: expected 2 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:269:63). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0009 | 1 | killed | 2026-09-16T04:25:06.142Z | 6116236c040ca2cd03299d46c0c73704c23affd6e1cda6d13e0f7b0c862d945f | Root reviewed the actual failure against this semantic mutation: The operator_disabled response runs the extracted screen-state callback; keeping disabled false prevents the terminal screen state. Observed: Error: Unable to find an element with the text: /not available right now/i. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:330:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0010 | 1 | killed | 2026-09-16T04:09:34.342Z | 0a6b1db438abb33257d5b47ff4d36a03f3efb1a86385646887f66a100ea9321a | Forcing composerBlocked false left the message textbox enabled under All locations; the existing toBeDisabled assertion at OperatorClient.test.tsx:347 failed. |
| rt-0011 | 1 | killed | 2026-09-16T04:09:34.342Z | 358da7a1a8f76e3900c1442979b4c6ee9e11bb993e27aa9b8553e246a2244322 | Removing the recovery notice suppressed the Try again action after the lost POST response; the pinned existing query at OperatorClient.test.tsx:390 failed. |
| rt-0012 | 1 | killed | 2026-09-16T04:25:06.151Z | 9eca53750fc6cdeb61a5031c7473ce6dbed7dd91ad0f59756600604832b856b0 | Root reviewed the actual failure against this semantic mutation: The lost-response branch stores a fallback notice through the extracted screen-state setter. SubmissionNotice returns null when its notice prop is null, including the retry affordance. Suppressing only the exported notice preserves submission, abort and canRetry state but hides the recovery action. Observed: Error: Unable to find role="button" and name "Try again" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:459:38). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0013 | 1 | killed | 2026-09-16T04:25:06.160Z | c61a06cc1c4a383a08e02633752852359f008c955e44046aff6be221f879f8fd | Root reviewed the actual failure against this semantic mutation: Extracted screen-state return must expose the notice set by a refused POST; suppressing it loses the server-refusal explanation. Observed: Error: Unable to find an element with the text: Your account can no longer make this change. Nothing was applied.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:489:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0014 | 1 | killed | 2026-09-16T04:25:06.164Z | 8cc65e413adff7751d4bd3068024ca93a2dd23ad33db607d41b8a40ba00f3343 | Root reviewed the actual failure against this semantic mutation: The referenced ordinary card must be placed inline; returning null leaves it unplaced and the existing append fallback puts it after the question. Observed: AssertionError: expected 6 to be less than 5 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:586:20). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0015 | 1 | killed | 2026-09-16T04:25:06.167Z | d5e0750ece51483db9467ad00cb3f98883c2e0db295d14e77ad4f7daa2d174d1 | Root reviewed the actual failure against this semantic mutation: The changed response decoder must adopt a stored proposal from a refused response. Discarding only error rows preserves fetch and error wording. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:644:73). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0016 | 1 | killed | 2026-09-16T04:25:06.175Z | 05de2d90dcbbb3b9335266325a57185ee16b6bb32c6419cfa866356d1b4486f7 | Root reviewed the actual failure against this semantic mutation: The extracted timeline-refresh hook must invoke finishTurn on terminal poll status. Miswiring it to the same-signature startFresh command resets the durable transcript instead of retaining previous turns. The fixture's second submission polls completed, so this branch is reached after the earlier failure/capability assertions pass. Observed: TestingLibraryElementError: Unable to find an element with the text: We tried several times and could not finish this message. Nothing was changed. Start a new conversation to try again.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:697:19). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0017 | 1 | killed | 2026-09-16T04:25:06.183Z | 08e1cc28093924ce0a0559b332d5d59f74cda65bebe64c1c3bdbf5200fe32682 | Root reviewed the actual failure against this semantic mutation: The extracted unfinished-turn helper must resume RUNNING turns loaded from durable conversation state. Both candidates use a running latest turn. Observed: Error: Unable to find an element with the text: Preparing your plan. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:722:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0020 | 1 | killed | 2026-09-16T04:26:11.383Z | e88bdaa1f66ffeb67f19f5084729e0952930c5f2d67b22de5d1bb46a51075198 | Root reviewed the actual failure against this semantic mutation: The extracted unfinished-turn helper must resume RUNNING turns loaded from durable conversation state. Both candidates use a running latest turn. Observed: AssertionError: expected 0 to be greater than 0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:959:45). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0022 | 1 | killed | 2026-09-16T04:26:11.394Z | 92d27270c127aebdbe9af296ac0fabe60b48e64a6b10a2ac7acd0b27536318a4 | Root reviewed the actual failure against this semantic mutation: Conflating composerBlocked with disabled hides Refresh plan under All locations, although only composing should be blocked. Observed: Error: Unable to find role="button" and name "Refresh plan" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:1097:33). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0030 | 1 | killed | 2026-09-16T04:26:11.397Z | d43249b152da3b15339de096251a65cbe8e7776fdf81efb44e4d734f28901205 | Root reviewed the actual failure against this semantic mutation: A referenced expansion must defer to the expansion group, retaining relative ordering and deduplication. Observed: AssertionError: expected [ Array(1) ] to have a length of 2 but got 1 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:248:81). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0035 | 1 | killed | 2026-09-16T04:26:11.406Z | c5c5153183b26050b97a2d8b7b2febeeaa8affb330b333f41310e825b5fc0f4d | Root reviewed the actual failure against this semantic mutation: The extracted panel state must initially show the persisted conversation on each mount; starting on timeline hides the refusal after reload. Observed: Error: Unable to find role="group" and name "Policy refused" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:81:36). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0036 | 1 | killed | 2026-09-16T04:26:11.409Z | 58d5652f557b61b8718af2e1c2228e1d39c88c640f3f2051caa9ff7d1e24fd4f | Root reviewed the actual failure against this semantic mutation: Restored pending proposals use the ordinary Apply request and must retain their prepared token; fetch fixture accepts the URL, so this fails the explicit payload assertion. Observed: AssertionError: expected { expectedVersionToken: null } to deeply equal { expectedVersionToken: { …(2) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:119:53). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0037 | 1 | killed | 2026-09-16T04:26:11.412Z | e05458df89ade9dee82a3b288be69c55b097d0d37a53fe805e9f085bbdbb98b8 | Root reviewed the actual failure against this semantic mutation: Both timeline variants must adopt the rejected Apply row to replace pending Apply with enabled Refresh plan. Ignoring only error rows leaves Apply visible. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:152:65). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0038 | 1 | killed | 2026-09-16T04:26:11.415Z | 89dac8c9e105602b8cd1b01cdff3161ba7224e23e293a00f59ef1fdd5b82beac | Root reviewed the actual failure against this semantic mutation: Both timeline variants must adopt the rejected Apply row to replace pending Apply with enabled Refresh plan. Ignoring only error rows leaves Apply visible. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:152:65). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0039 | 1 | killed | 2026-09-16T04:26:11.424Z | b5552b4e068e99542365b63d13a7fc62dc704c14b4aed2f6f24c2c68ab5d2f01 | Root reviewed the actual failure against this semantic mutation: The extracted Restore action must invoke preparation for a receipt outside the transcript window; removing dispatch leaves timeline without pending restore. Observed: Error: Unable to find role="button" and name "Apply" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:175:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0040 | 1 | killed | 2026-09-16T04:26:11.427Z | 5e723ba30d3fcf6324c38b4bd32f69fbb90ec4008a043ab4911cafa36adaa9a7 | Root reviewed the actual failure against this semantic mutation: Mutate selected-location projection consumed by RulesTimeline while retaining normal rendering and pagination. Observed: AssertionError: expected 'all' to be 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:204:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0041 | 1 | killed | 2026-09-16T04:09:34.342Z | 56ccc3ee123c13f92c91c9e5b4b730cd5040c59b497411604a2b7d8c9484ee97 | Removing the busy disabled state left the Preparing restore control enabled; the existing toBeDisabled assertion at RestoreWorkflow.test.tsx:217 failed. |
| rt-0044 | 1 | killed | 2026-09-16T04:26:11.436Z | b2d34a1f8a2e48e1d7951149b801110c74e90cbb47b20ac3b086222958cab10e | Root reviewed the actual failure against this semantic mutation: Initial selected-location request stays unchanged. Switching to All locations incorrectly keeps the first roster location, so the timeline receives no scope change and never loads current all-scope history. Observed: Error: Unable to find role="heading" and name "Current scope history" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:266:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0045 | 1 | killed | 2026-09-16T04:26:47.076Z | e19d2c609dd850390775268cb5fe7291e0cf12b0f3309497fb27972f8be6b696 | Root reviewed the actual failure against this semantic mutation: The extracted state hook must expose a working panel setter. This candidate explicitly clicks Rules timeline before reading the failure. Dropping only that exported transition prevents entering the requested panel. This is evidence for changed panel-transition wiring, not a mutation of the unchanged timeline retry/error implementation. Observed: Error: Unable to find role="alert" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:283:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0056 | 1 | killed | 2026-09-16T04:26:47.080Z | e0015538fb3dfa6255c637449a430b69174ab1f16b387349d4f72d8a224a2858 | Root reviewed the actual failure against this semantic mutation: Exact typed scope must be sent unchanged; this test supplies a trailing space specifically to detect normalization. Observed: AssertionError: expected { Object (expectedVersionToken, confirmationLevel) } to deeply equal { Object (expectedVersionToken, confirmationLevel) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:78:44). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0057 | 1 | killed | 2026-09-16T04:26:47.083Z | 2698199d92bf327918351b460af2e04b0ee8541cc675e88bd4c72124f84d623b | Root reviewed the actual failure against this semantic mutation: Apply must send the version of the card being decided. Mock fetch resolves normally regardless of body. Observed: AssertionError: expected { expectedVersionToken: null } to deeply equal { expectedVersionToken: { …(2) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:97:26). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0058 | 1 | killed | 2026-09-16T04:26:47.086Z | cf95b8ec015c1414e0eaf64a651c289d0f8ff4ece52bb8a7bb71ed918660b8d8 | Root reviewed the actual failure against this semantic mutation: Decline intentionally sends no body; the extracted request builder must preserve undefined rather than serialize an empty object. Observed: AssertionError: expected {} to be undefined (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:119:26). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0059 | 1 | killed | 2026-09-16T04:27:53.230Z | 8164822e0deedba7d444c076fb3ea8ddddd956e49fda9a2d8ae36b81840a79cd | Root reviewed the actual failure against this semantic mutation: The changed response decoder must adopt a stored proposal from a refused response. Discarding only error rows preserves fetch and error wording. Observed: AssertionError: expected "vi.fn()" to be called with arguments: [ { …(21) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:138:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0060 | 1 | killed | 2026-09-16T04:27:53.235Z | c9a694da5228fdfbe44a3958c0c6543698e4eee76558536291d88bb0f36d9e2c | Root reviewed the actual failure against this semantic mutation: Transport failure must write the fallback per-card error; removing callback leaves error map empty without throwing. Observed: AssertionError: expected undefined to be 'Something went wrong. Nothing was cha…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:154:45). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0061 | 1 | killed | 2026-09-16T04:27:53.237Z | 50764246741de0a3f594bae09201e49d317d10032b7d59ec0c622b8dc7f2a647 | Root reviewed the actual failure against this semantic mutation: A disabled endpoint must invoke the outer session-disabling callback instead of silently returning. Observed: AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:167:24). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0062 | 1 | killed | 2026-09-16T04:27:53.240Z | 3770fba58c3d6e8c4133309959ae4b9279334104487cf69d75b4c854fd45f55c | Root reviewed the actual failure against this semantic mutation: The changed request execution seam must launch one network write. A duplicated concurrent dispatch is meaningful even though the unchanged writing guard still rejects the second public write() call. Both mock requests register their releases before Promise.all waits; the test's existing finally releases both, so this mutation avoids the deadlock of a sequential duplicate. Observed: AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:189:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0066 | 1 | killed | 2026-09-16T04:27:53.242Z | 0799949e0dc3789cff8f9dcae9088fd800d68fae68c20ca567ef5caf3a61af3c | Root reviewed the actual failure against this semantic mutation: Changed Apply result mapper corrupts stale HTTP status while preserving valid response. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/apply-route.test.ts:140:26). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0067 | 1 | killed | 2026-09-16T04:27:53.245Z | 0e8cabaeefc17d76615cd5fda3f8eeffb638f3ab96da499f51b72233774e0978 | Root reviewed the actual failure against this semantic mutation: Changed Apply mapper changes confirmation mismatch response status. Observed: AssertionError: expected 409 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/apply-route.test.ts:214:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0068 | 1 | killed | 2026-09-16T04:29:21.033Z | 6d0a97bba54ffcb4a42da0445673d8e9abefe85b5e978627055b510cbb574156 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:61:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0069 | 1 | killed | 2026-09-16T04:29:21.037Z | 559268156cc674f4e10f9398b7a819e2b5905adfe139160b79f6e3a3dd246899 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:97:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0070 | 1 | killed | 2026-09-16T04:29:21.041Z | c0afd289f44f6496301a9029d5421a541f6da7e385792db2b5633fe5ea5fb75a | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:168:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0071 | 1 | killed | 2026-09-16T04:29:21.043Z | bd4daaf6467a8e200fc04514ac91b5fac75288b4e95022c655fa8269ed71241f | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected { error: 'operator_disabled' } to deeply equal { error: 'location_not_found' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:210:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0072 | 1 | killed | 2026-09-16T04:29:21.046Z | 63ac79dfa30c64926970da4475b8e8c9181372b51a72555e4d922b0644a3eec3 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:252:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0080 | 1 | killed | 2026-09-16T04:29:21.048Z | f9241f966cc7ee7b8580da6636de7df9052e6dcd4a3dc1ce789d79c06eb365dc | Root reviewed the actual failure against this semantic mutation: Changed Restore mapper flips retry identity without altering preparation call. Observed: AssertionError: expected { proposal: { …(2) }, repeated: true } to deeply equal { proposal: { …(2) }, repeated: false } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:39:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0088 | 1 | killed | 2026-09-16T04:30:50.245Z | 17be33412942d0258a3b5797e24d989199dcb9f4137035356b177cd4d82c3933 | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0089 | 1 | killed | 2026-09-16T04:30:50.250Z | 0292de1985302042718d397384b03177be81af532b2d0f650597aa487d351ca7 | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0090 | 1 | killed | 2026-09-16T04:30:50.253Z | dd583d5bc2eb052d5740148d46b070017eed0db20e7785d6d64ee2943e96b72d | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0091 | 1 | killed | 2026-09-16T04:30:50.256Z | 5478c9634b11790d20fd09a3444292adce371e110468840c5cc908ec14587bf5 | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 403 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0092 | 1 | killed | 2026-09-16T04:30:50.258Z | 773a9fd39129e33e6751c8e6a8d6ce4bc2042c7ba1ef1ea1c6400df11432ef49 | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0093 | 1 | killed | 2026-09-16T04:30:50.261Z | 53bd8ea4c9a0ee73c2f63a7f88f288a635d2b33e230a556063f5827ec02d6b2f | Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0094 | 1 | killed | 2026-09-16T04:32:58.953Z | ec5acdb47138db1b23ebf86df820fe0e5568d78babeec1cfb022f28a93659b9c | Root reviewed the actual failure against this semantic mutation: Changed Restore mapper flips retry identity without altering preparation call. Observed: AssertionError: expected { proposal: { …(2) }, repeated: false } to match object { repeated: true } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:93:60). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0095 | 1 | killed | 2026-09-16T04:32:58.956Z | 375f01f1d1db3a5a939ea4ad2617df112f30b51cc1e6341f2b838c840e53a20f | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:34:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0096 | 1 | killed | 2026-09-16T04:32:58.959Z | cdc9b9b5a03f16a23a6c277006b8b9e176cc19658d1fa77283a2310332b5390e | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:42:43). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0097 | 1 | killed | 2026-09-16T04:32:58.961Z | eb6780d0f0a9b4034a92a22f029fed143413b39745004388fd43893f66c35c5c | Root reviewed the actual failure against this semantic mutation: Invert extracted read feature gate. With flag false valid mocked owner permits read; no setup change. Observed: AssertionError: expected 200 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:48:43). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0098 | 1 | killed | 2026-09-16T04:32:58.963Z | 5344baaf7e54cc4679ad2c4ada9ef7c9db1b92ec398cbfaec88d6a1e488a0873 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0099 | 1 | killed | 2026-09-16T04:32:58.966Z | b6d82b531504025048cbf694d92398358b55bacc236529109e7fe170d8910297 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0100 | 1 | killed | 2026-09-16T04:32:58.969Z | 8e8e42cb2b82e1fa69fb2bc32004300b7b4ce46adaad86158394052856a5275e | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0101 | 1 | killed | 2026-09-16T04:37:44.489Z | 01dc258a7383098957e56b6844e7f15658b38aea09e96673bbb0cc1b40603cd6 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0102 | 1 | killed | 2026-09-16T04:37:44.492Z | bb1e20808205d71e8cfb3e417423637900217d802b29d758dde276abd0f95402 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0103 | 1 | killed | 2026-09-16T05:21:35.927Z | aa50a001ec99aeddbf9089583829c35332a3424193ee8dd6da6fa4ed91b890d4 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0104 | 1 | killed | 2026-09-16T04:37:44.495Z | c5c043da77a09f159192d1ea2f015c6f6a31982c2f8cad897d21377dd97117fc | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0105 | 1 | killed | 2026-09-16T04:37:44.497Z | 28a163115c8b6cea87db4e133cefe3b8b75cbd79d4dd46ddb7ba41b3fdb93198 | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0106 | 1 | killed | 2026-09-16T04:37:44.499Z | 083eb98a8921e312b312a88c626ae54aaa3af3395eb45a877b656eb9ddb675fd | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0107 | 1 | killed | 2026-09-16T04:37:44.502Z | 1cce788709eb6ebbd45940b7ea2eefe328c94a5cdd558a620c74ed6a7ed028df | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0108 | 1 | killed | 2026-09-16T04:37:44.505Z | 93a7bf9f32d5cdddd3af5e478100991fcb27a00cb0064d730d27f27f675ee68c | Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 500 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:68:29). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0120 | 2 | killed | 2026-09-16T04:21:49.715Z | 966538406c342f37322913b2f9422b1c7d5f03b2d43168148f3531dc131492f3 | The second attempt substitutes preview productsServices into the committed receipt. The existing receipt.after equality at apply.integration.test.ts:470 fails, proving the test detects receipt state that differs from the actual write; the historical timestamp attempt and RT-001 rejection remain unchanged. |
| rt-0121 | 1 | killed | 2026-09-16T04:37:44.508Z | 9de49d77c62455288858ec92f3d1794649d728ac5e651bf9d72e26265419115d | Root reviewed the actual failure against this semantic mutation: Changed voice orchestration discards the successful recordVoiceApplied result after preserving all writes and returns a valid not_found. 0121's injected transaction still rolls back; its normal retry detects result corruption. No fixture Apply. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:522:26). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0123 | 1 | killed | 2026-09-16T04:37:44.510Z | 7e6a8c233127e81d8fdf683dbb094fc935b963bdc615b994ff9a53d22a367aa6 | Root reviewed the actual failure against this semantic mutation: Changed voice orchestration discards the successful recordVoiceApplied result after preserving all writes and returns a valid not_found. 0121's injected transaction still rolls back; its normal retry detects result corruption. No fixture Apply. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:611:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0124 | 1 | killed | 2026-09-16T04:37:44.512Z | 050e51e1bf011b5036818c7a0a8f612715021544e8bde7278315230a68d33329 | Root reviewed the actual failure against this semantic mutation: Changed voice receipt handoff drops Receipt only from returned success view after persisting original receipt. First Apply still returns applied and all setup assertions pass. Archived repeat takes unchanged settled branch and returns stored non-null receipt, exposing inconsistent initial versus repeat response. Observed: AssertionError: expected { version: 1, …(14) } to deeply equal null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:665:41). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0129 | 1 | killed | 2026-09-16T04:09:34.341Z | 83530d8d25e9d0c818fc499ea39118e204436c9864dcd172539da2b59e56d18f | Moving the voice write before freshness validation caused the existing writer-not-called assertion at apply.test.ts:346 to fail after the stale-result assertion passed. |
| rt-0130 | 1 | killed | 2026-09-16T04:37:44.515Z | e4a9e048945ff043ab3fa32d4bce232edf6c987a0c4c42a3aab21686c736f263 | Root reviewed the actual failure against this semantic mutation: Move the real extracted voice-write phase before authorization and token validation. One statement-block ordering defect; writer called once. Preserve actor/token checks and terminal result. Observed: AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.test.ts:376:33). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0134 | 1 | killed | 2026-09-16T04:37:44.517Z | 68329ffec0c4f9a71b2b8f6cee702e0ed6e5ebeed22bddec0ece9a84860c5d34 | Root reviewed the actual failure against this semantic mutation: Move the real extracted voice-write phase before authorization and token validation. One statement-block ordering defect; writer called once. Preserve actor/token checks and terminal result. Observed: AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.test.ts:477:33). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0137 | 2 | killed | 2026-09-16T04:21:49.716Z | 445275c449b2f139d80d907dbec82287935fc79ce6d7d2559df31f0d5c3489f7 | Adding policy_suspended to remainingBlocked after the original write fails the existing empty-list receipt assertion at apply.test.ts:768. |
| rt-0138 | 2 | killed | 2026-09-16T04:21:49.716Z | 6e5a5e29623f1e92f11318a598d48a92c04e77bb970437592a747c0bfb7b5983 | Replacing the returned typed-scope refusal with not_found fails the existing confirmation_mismatch assertion at apply.test.ts:796. |
| rt-0139 | 2 | killed | 2026-09-16T04:21:49.716Z | 67b0819676a12a9b4964d254ea40315b48d7a1898b5b14a2a67435023f13f8f8 | Replacing the readiness refusal with not_found fails the existing blocked-result assertion at apply.test.ts:817. |
| rt-0140 | 2 | killed | 2026-09-16T04:21:49.717Z | 3541ccc0f1eca3bcd07a6515f4c7d41f52168dd1f699e4008425385ae8be1600 | Replacing the archived-location refusal with not_found fails the existing rejected/location-inactive assertion at apply.test.ts:857. |
| rt-0141 | 1 | killed | 2026-09-16T04:09:34.343Z | dd1b9300298d4f985ac4fa3c1ab4f1a6b3572b835802d5eff968b572a1fecd5e | Moving the policy freshness check after execution caused readiness lookup before stale refusal; the existing settings-not-called assertion at apply.test.ts:898 failed after stale-result and snapshot-count assertions passed. |
| rt-0144 | 1 | killed | 2026-09-16T05:14:17.646Z | 468489f392cedd75a85b6b13892b12eae10028389e6e56223aedc3fedd874f13 | Root and independent reviewer inspected the existing completion-materialization.test.ts:57 resolves.toEqual assertion. Reversing the account ownership comparison rejects the valid request instead of resolving with fenced:true. The original exact baseline passed, and the pinned original mutant produced that promise assertion failure. The original inconclusive measurement remains unchanged; this is separate corrective adjudication under the reviewed classifier. |
| rt-0157 | 1 | killed | 2026-09-16T04:39:13.141Z | d6255dc9dace3bc04e63213ab38cf5b9668b9ac7d7df2c8ead8eb7f83910765a | Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'applied', proposal: { …(1) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:243:20). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0158 | 1 | killed | 2026-09-16T04:39:13.145Z | 732b34e2808787415320af5098309fdc6ed1bfbb6e69b3783994692cc836d38f | Root reviewed the actual failure against this semantic mutation: Changed location snapshot omits parent token during prepare and Apply. Both phases agree on absent parent, so later actual parent form update no longer stales the location proposal. Prepare remains successful. Observed: AssertionError: expected { kind: 'applied', …(2) } to match object { kind: 'stale' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:262:46). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0159 | 1 | killed | 2026-09-16T04:39:13.148Z | 2e288361acf9e38481642933099a390970e3db4801934e955e1fee316ec14cd8 | Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:272:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0160 | 1 | killed | 2026-09-16T04:39:13.150Z | 8511259f892d8e4ee0cb45f67ad3d2778bbfdbe8428743cb2370b74678c77146 | Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:297:41). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0161 | 1 | killed | 2026-09-16T04:39:13.153Z | cc4bc766aa66b4e51817e8d36dedc1d46aa32d46941ad874e1cdc36af3f65af4 | Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:322:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0162 | 1 | killed | 2026-09-16T04:39:13.156Z | 9b662fcc10a841d53bfe0930476679e5f0fe8b1da2df4a5147729414f0c01cad | Root reviewed the actual failure against this semantic mutation: Changed executePolicyPlan still completes original refusal SQL/validation, then returns another valid ApplyResult. No additional statement or fixture queue shift. For 0138/0139/0140 this is the single remaining attempt. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'blocked' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:352:53). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0164 | 1 | killed | 2026-09-16T04:39:13.158Z | 23de9f809104e55bd305df70514b7ebef9c5de7fdb28ba9cf3938fd1e9116e0f | Root reviewed the actual failure against this semantic mutation: Changed extracted location snapshot omits override stamp consistently at preparation and Apply. Same-location/first-override form write then fails to move visible token; raw values stay valid and real account locking/SQL ordering remains intact. Observed: AssertionError: expected 'confirmation_mismatch' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0165 | 1 | killed | 2026-09-16T04:39:13.160Z | dc91b5c61af98c401dfc5b44841c89be6e266352618c55a2a0409e87d6a370ad | Root reviewed the actual failure against this semantic mutation: Changed extracted location snapshot omits override stamp consistently at preparation and Apply. Same-location/first-override form write then fails to move visible token; raw values stay valid and real account locking/SQL ordering remains intact. Observed: AssertionError: expected 'confirmation_mismatch' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0166 | 1 | killed | 2026-09-16T04:45:11.420Z | 14922a04048c79c08343d4acab85b5d0863569bdb4b715be9fd4654b5a03d060 | Root reviewed the actual failure against this semantic mutation: Changed locationSnapshotFields removes parent token both during fixture prepare and real Apply; concurrent parent default-only form update then fails to invalidate expected token. Parent locks/blockedQuery still run unchanged. Observed: AssertionError: expected 'applied' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0167 | 1 | killed | 2026-09-16T04:45:11.426Z | 324cd7df8ba3900827cc0274d1fa5bf6903855f3c683ba974d527793cc269704 | Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected [] to have a length of 1 but got +0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:395:67). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0168 | 1 | killed | 2026-09-16T04:45:11.430Z | 782cab2155253e7414b9549795b1941e04d230a88d1aeb0f7261b7140e27d5d6 | Root reviewed the actual failure against this semantic mutation: Changed policy success handoff discards the valid result after preserving receipt writes and executor post-callback contention hook. Source fixture uses prepare() only. The form still blocks and then completes normally. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:417:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0169 | 1 | killed | 2026-09-16T04:45:11.433Z | 7ecfcccc526f556e259f8dd9b17816ba7442ebbd83b84cb4b7f93a6ddcbfa37d | Root reviewed the actual failure against this semantic mutation: Changed executePolicyPlan still completes original refusal SQL/validation, then returns another valid ApplyResult. No additional statement or fixture queue shift. For 0138/0139/0140 this is the single remaining attempt. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'rejected', …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:435:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0170 | 1 | killed | 2026-09-16T04:45:11.436Z | 37ae650350530c108bb7847da1b356806b8fdb8ee6d0a6769a9591a6db87074c | Root reviewed the actual failure against this semantic mutation: Changed location snapshot omits parent token during prepare and Apply. Both phases agree on absent parent, so later actual parent form update no longer stales the location proposal. Prepare remains successful. Observed: AssertionError: expected 'applied' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:445:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0173 | 1 | killed | 2026-09-16T04:45:11.438Z | 83ba85df670970fddc4c70a43a759db40b6a080f44bcfcd1d0380dd5ada8c7a2 | Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields loses parent row stamp but preserves valid VersionToken and SQL. Both tests directly assert stamped location snapshots. Observed: AssertionError: expected { locationRow: { …(2) }, …(1) } to deeply equal { locationRow: { …(2) }, …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-state.integration.test.ts:478:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0174 | 1 | killed | 2026-09-16T04:45:35.617Z | d16713d9888e6b64b75ab19f3a2184e75be18c60ef16eb0de3058b6c05573804 | Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields loses parent row stamp but preserves valid VersionToken and SQL. Both tests directly assert stamped location snapshots. Observed: AssertionError: expected { locationRow: { …(2) }, …(1) } to deeply equal { locationRow: { …(2) }, …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-state.integration.test.ts:531:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0191 | 1 | killed | 2026-09-16T04:45:35.621Z | c1a87b862ffeb8fccbcf5bb2d76ed7037618018deaeedf6f167cc2dbb1b9bc2e | Root reviewed the actual failure against this semantic mutation: Changed shared policyCardFacts suppresses expansion friction while preserving valid proposal mapping. 0191 directly reads policy card; 0264 source fixture Apply is a contraction and restored expansion remains prepared. Observed: AssertionError: expected { …(21) } to match object { requiresConfirmation: true, …(3) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/proposals.test.ts:460:21). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0198 | 1 | killed | 2026-09-16T04:45:35.624Z | d88e9692adaaf131450d27250e171bb694e096b47a3db2b30b6c9af94f648a83 | Root reviewed the actual failure against this semantic mutation: The new hydration reference record binds every reference list to the first turn instead of its originating turn. All rows and ids remain valid and no query order changes. Test has two populated turns plus a quiet turn: processing turn two's highlight reference appends it to turn one's existing cards. Observed: AssertionError: expected [ { …(3) }, { …(3) }, { …(3) } ] to deeply equal [ { …(3) }, { …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:519:10). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0200 | 1 | killed | 2026-09-16T04:45:35.627Z | 4927ce2b453c47a973d02e2f08650507346e4b47077bf9ece3e2bd41a501466c | Root reviewed the actual failure against this semantic mutation: New hydration enumeration erroneously reverses its caller-owned array in place. This is a single array-order semantic mutation at an added line; hydration must preserve transcript chronology even when reference lists are empty. Source fixtures call createTurn/direct SQL, never this hydrator. Observed: AssertionError: expected 55 to be 6 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:592:39). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0203 | 1 | killed | 2026-09-16T04:45:35.629Z | 3da1faed064755f7f94d798214b8d450f55572f838e889a807281881516e1e0a | Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:741:75). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0204 | 1 | killed | 2026-09-16T04:45:35.632Z | 17115ab653ee1099141cd9f03a1bb6b1cba5ff57a8538d9c5a726c4d7dfb1e67 | Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:741:75). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0205 | 1 | killed | 2026-09-16T04:45:35.635Z | ebc10c8c46caf1a9c70224d6828643b94821f35d6ad505625e048037ec4a6b90 | Root reviewed the actual failure against this semantic mutation: Added hydrateProposalReferences enumeration mutates caller-owned transcript array through reverse() before mapping reference records. Hydration must retain chronological turn order even for turns without proposal references. Existing test asserts per-turn data in transcript order; setup uses createTurn/direct SQL and is unaffected. Observed: AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:802:85). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0206 | 1 | killed | 2026-09-16T04:45:35.638Z | 093ebf2553aedf46c35b7f2426d152062de9edbd68127c53bb8e45f858b983a3 | Root reviewed the actual failure against this semantic mutation: Added hydrateProposalReferences enumeration mutates caller-owned transcript array through reverse() before mapping reference records. Hydration must retain chronological turn order even for turns without proposal references. Existing test asserts per-turn data in transcript order; setup uses createTurn/direct SQL and is unaffected. Observed: AssertionError: expected [] to deeply equal [ { …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:854:36). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0247 | 1 | killed | 2026-09-16T04:45:35.640Z | 1603c3d21f47a5ce38b67b278db3bfa0fb62bca571b8d6c6c3c1f6535e216760 | Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:94:43). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0248 | 1 | killed | 2026-09-16T04:45:35.643Z | 2f30611e16d6391af016984930810426075a70de0f785576a00e6ea0ea269337 | Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0249 | 1 | killed | 2026-09-16T04:45:35.644Z | 71deb7a74938fe59b45d5c9005bd45bc16e588771bc27786f1aa6a9a6174d0c1 | Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0250 | 1 | killed | 2026-09-16T04:45:35.646Z | 1518e9e1d24face1149f48023df2129ad36fcdb0ba7f097028072df4769fc55f | Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0251 | 1 | killed | 2026-09-16T04:46:21.437Z | 52b79075e5304d4bfcd68b63cbd1d229d41397aca82fdbccbe35fe4f573273bd | Root reviewed the actual failure against this semantic mutation: Changed inverse derivation swaps before and after, producing the forward state rather than restoration; valid schema and typed patch. Observed: AssertionError: expected { domain: 'policy', patch: { …(3) } } to deeply equal { domain: 'policy', patch: { …(3) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:112:66). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0252 | 1 | killed | 2026-09-16T04:46:21.439Z | 069e37a9b66644e33e775c05573c8113bf995f3db22475cf41125a29dfc5a70c | Root reviewed the actual failure against this semantic mutation: Changed inverse derivation swaps before and after, producing the forward state rather than restoration; valid schema and typed patch. Observed: AssertionError: expected { domain: 'policy', patch: { …(2) } } to deeply equal { domain: 'policy', patch: { …(3) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:127:58). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0253 | 1 | killed | 2026-09-16T04:46:21.441Z | 398d41231d5ecfe60b2adf6b60465913ad86a06bf173dc65c185f29f11caf64c | Root reviewed the actual failure against this semantic mutation: Extracted receipt provenance gate drops same-account requirement. First invalid candidate otherwise has valid applied source and valid voice receipt; it now returns a derived inverse. Observed: AssertionError: expected { domain: 'voice', …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:154:76). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0254 | 1 | killed | 2026-09-16T04:46:49.760Z | 716fded192873d6ca184a02997eea1561a6fe0d4d93d2f74199b50575c0be033 | Root reviewed the actual failure against this semantic mutation: Changed deriveRestoreInput handoff fabricates an empty valid inverse for malformed receipt instead of refusing; direct test body assertion sees returned object, not a parser exception. Observed: AssertionError: expected { domain: 'voice', input: {}, …(1) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:159:60). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0255 | 1 | killed | 2026-09-16T04:47:30.726Z | 9eea781cbdb428b9cae4221df6f0e2335dd46aaf3afe4f7455da81040bb0b4bd | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:215:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0256 | 1 | killed | 2026-09-16T04:47:30.728Z | 17a3aae5729aec867146ffe63bded75927ce49fd26f3ba557f8c8246198a5b8c | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:215:25). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0258 | 1 | killed | 2026-09-16T04:47:50.959Z | 4cc4f38a9646576668ef6b2a83aa323ef60141a4c377c8885d7a969e02cae4dc | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0259 | 1 | killed | 2026-09-16T04:49:05.667Z | cfda0676c376296917a7957d46abef1e68c089c0b02947179a329b2aea8613b3 | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0260 | 1 | killed | 2026-09-16T04:49:05.670Z | 283cdd2d560d76c770c446ccb8261caea6b5a2b1ab1f53b770dcc73f6840f181 | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0263 | 1 | killed | 2026-09-16T04:49:05.672Z | 23264ae66db1c638fff05a4c88780e024b6ee76fa8d0585b56fc2e7ce48ac877 | Root reviewed the actual failure against this semantic mutation: Extracted policy Restore preparation misreports restored row existence in preview. Source normal Apply and restored() kind check still succeed; proposal remains schema-valid. Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:269:37). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0264 | 1 | killed | 2026-09-16T04:49:37.439Z | 0a9bc8d0ba1d01394f30d2574dcdd00e687f9a9423ee469bd1c48847551eae8c | Root reviewed the actual failure against this semantic mutation: Changed shared policyCardFacts suppresses expansion friction while preserving valid proposal mapping. 0191 directly reads policy card; 0264 source fixture Apply is a contraction and restored expansion remains prepared. Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:279:42). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0265 | 1 | killed | 2026-09-16T04:49:53.122Z | fcab951d9bb7cebd60abe51eb4eb47bb463de3232ab4fec31231b2b2b5b0aa1a | Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields hides parent policy stamp consistently in ordinary source preparation, source Apply, Restore preparation and Restore Apply. All fixtures remain valid because their own expected/current tokens agree. After parent-only form change, Restore Apply wrongly misses stale gate and reaches expansion confirmation instead. Observed: AssertionError: expected { kind: 'confirmation_mismatch', …(1) } to match object { kind: 'stale' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:309:9). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0266 | 1 | killed | 2026-09-16T04:50:50.128Z | 1b1db2b021e0d19f11213a27e58d88a10248cb23063451dd35c31ae62ed0b87a | Root reviewed the actual failure against this semantic mutation: Changed reusable Restore handoff flips repeated identity after real reuse; source fixture Apply and first Restore are unchanged. Observed: AssertionError: expected [ false, false ] to deeply equal [ false, true ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:325:91). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0267 | 1 | killed | 2026-09-16T04:50:50.131Z | ad83905f5bbf3772ccea6f1da6abda61937c843c81e2dc3f41d5aa5a0400a5c3 | Root reviewed the actual failure against this semantic mutation: Changed selectRestoreSource chooses oldest applied receipt. Source fixture preparation/Apply never calls this helper, so first failure is tested selection, not setup. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { Object (kind, proposal) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:349:22). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0268 | 1 | killed | 2026-09-16T04:51:20.011Z | 8a6317070ce456a8bd16bc28088aad6e573719754e93c5d3475eee50a6343781 | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource changes valid domain refusal after source lock. Pending source fixture construction unchanged. Observed: AssertionError: expected { kind: 'invalid_source' } to deeply equal { kind: 'not_applied' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:364:91). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0269 | 1 | killed | 2026-09-16T04:52:10.009Z | d115c637ce8d7186f663aae3e88b4178ef44f4b6a0fece2a267a48a55140f9f9 | Root reviewed the actual failure against this semantic mutation: Changed restoreCardFacts fallback falsely labels missing/corrupt source. Valid initial restore fixture never takes fallback, so failure occurs on asserted tampered-source readback. Observed: AssertionError: expected 'Restore: The source receipt is availa…' to be 'Restore: The source receipt is no lon…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:385:30). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0270 | 1 | killed | 2026-09-16T04:52:10.011Z | 916349a9d8924981933447a0377eb4d1839ec3ba05d2f5bd5d6804a2d2cb47bb | Root reviewed the actual failure against this semantic mutation: Changed restoreCardFacts fallback falsely labels missing/corrupt source. Valid initial restore fixture never takes fallback, so failure occurs on asserted tampered-source readback. Observed: AssertionError: expected 'Restore: The source receipt is availa…' to be 'Restore: The source receipt is no lon…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:404:8). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0271 | 1 | killed | 2026-09-16T04:52:29.794Z | 48b530a9ebf2c16187649313bd243aa0094b85d340448e59be25ed9dee64e3e5 | Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [] to deeply equal [ Array(1) ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:459:62). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0273 | 1 | killed | 2026-09-16T04:54:15.346Z | 9b47c48032e02689ec031657f7017b4e7dd25eb3cbe69030c3d3d71dbeba7f86 | Root reviewed the actual failure against this semantic mutation: Dropping the Restore daily cap causes the successful Restore retry under test to return confirmation_mismatch instead of applied (restore.integration.test.ts:524, through the applied helper assertion at line79). Source fixture application completed normally. The failure occurs before the final persisted-cap assertion. Observed: AssertionError: expected 'confirmation_mismatch' to be 'applied' // Object.is equality (at applied (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:79:23)). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0274 | 1 | killed | 2026-09-16T04:54:29.924Z | b2471852087d8ccde7f65442211bbf475105853685cad0154de627b3c5707e86 | Root reviewed the actual failure against this semantic mutation: Changed reusable Restore handoff flips repeated identity after real reuse; source fixture Apply and first Restore are unchanged. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { kind: 'prepared', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:559:22). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0275 | 1 | killed | 2026-09-16T04:54:29.926Z | e1a1dbad20033fe7fe6e4df7f4242760e1b193a235bdc574f8cd8eef48b58590 | Root reviewed the actual failure against this semantic mutation: Changed selectRestoreSource chooses oldest applied receipt. Source fixture preparation/Apply never calls this helper, so first failure is tested selection, not setup. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { Object (kind, proposal) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:599:23). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0280 | 1 | killed | 2026-09-16T04:55:33.729Z | 71dc61b45b6d22c7228bd418a4296442a036d7566e93ca7caf8286f886449a5d | Root reviewed the actual failure against this semantic mutation: Changed resolveRestoreSource returns invalid_source after validated lookup; seedAppliedTone performs ordinary Apply only and is unaffected. Worker then materializes Restore unavailable notice instead of requested Restore card and completes normally. Observed: AssertionError: expected undefined to be 'pending' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:385:32). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0281 | 1 | killed | 2026-09-16T04:55:33.732Z | f7f2db7f69157eedb97f0c18f517eb542442646ecee452524197423f0bf1f581 | Root reviewed the actual failure against this semantic mutation: changed proposal-reference extraction destructively consumes the original rendered segment array instead of reading it. A realistic collection-mutation regression: same typed references computed, no fabricated IDs or throws. getTurnForOwner builds independent refused array before hydration, so original segments becomes empty while refused remains populated. Only actual GET exercises mutation; worker setup has no owner GET. Observed: AssertionError: expected [] to deeply equal [ { type: 'refusal', …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:435:32). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0283 | 1 | killed | 2026-09-16T04:56:15.950Z | b8094077382a0930bfb4dc9a2d72e69371370ffd49817e760d1585d41d358fe3 | Root reviewed the actual failure against this semantic mutation: Dropping the worker owning turn inserts the prepared Restore under the historical turn. The existing in-transaction probe at turn-worker.integration.test.ts:480 sees zero proposals instead of one; its AssertionError then fails the expected SQL22012 rejection assertion at line488. This is the target completion behavior, after normal source setup. Observed: Error: expected AssertionError: expected [] to have a len… { …(3) } to match object { code: '22012' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:488:12). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0284 | 1 | killed | 2026-09-16T04:09:34.343Z | 0831d93f41814b736c5017e8ec6c2fd945eb38492b7fbd2fc2d15eb209ee37ba | Skipping Restore processing after successful request validation produced an empty reply instead of the restore-unavailable notice; the explicit reply equality at turn-worker.integration.test.ts:506 failed after the awaited worker call completed. |
| rt-0285 | 1 | killed | 2026-09-16T04:56:49.416Z | 11e4d878d3952c3795a5c9f77ae5e3b37afcf44447839ade0078f42c5c04214f | Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource drops the worker's owning turn and returns the historical source's owner. seedAppliedTone uses ordinary Apply and is untouched. Restore still passes owningTurn validation, inserts a valid pending row, and holds the original scope/conversation locks; the row belongs to source turn rather than completed turn. Observed: AssertionError: expected [] to have a length of 1 but got +0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:568:103). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0333 | 1 | killed | 2026-09-16T04:56:49.419Z | ad08362ca9109375b6893c577c8b6771995eb86def3d0582cf3ea3b29c5efa1f | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 3 to be +0 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:121:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0335 | 1 | killed | 2026-09-16T04:57:12.207Z | db9165e66a8500bec47ac792478a54e63a9b30d85bdc8b3b662a370ba121f6d9 | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 4 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:173:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0336 | 1 | killed | 2026-09-16T04:57:33.847Z | 2bd5a46e26cab4074ced651055a23a1bbe25a555bef9e451b57b9db9dd4134cf | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:196:42). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0337 | 1 | killed | 2026-09-16T04:58:06.231Z | 1ce3dd57898d0566c30999be9b749c7f7dabc016a2d95fa5f7131bd019f3c8f8 | Root reviewed the actual failure against this semantic mutation: Extracted shared reference checker incorrectly resets accumulated semantic failures before checking presentation. Caller appends checkOperatorProposal failures immediately before this helper; dropping those is an extraction-boundary regression. Subsequent validator failures have different text. Observed: AssertionError: expected [ Array(1) ] to deeply equal ArrayContaining{…} (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:212:31). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0341 | 1 | killed | 2026-09-16T04:58:40.412Z | 5a3b9dcebe57b377a3456a31080b538314cc4d7e325f2fbdf0afd37114506ec8 | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 4 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:268:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0344 | 1 | killed | 2026-09-16T04:59:02.918Z | e045c2fd0167d2b7d9d53f096811b63a7bb468efa4bee647dbaf099f6ca959d5 | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected [ Array(1) ] to deeply equal [] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:311:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0345 | 1 | killed | 2026-09-16T04:59:42.023Z | 37f400f21c8508fe523cf6a139a14360b63aacecfc98721c3cb97fc81536f9b8 | Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected [ Array(1) ] to deeply equal [] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:311:35). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0502 | 2 | killed | 2026-09-16T05:22:34.941Z | c4cf19122b9c4bc6e7e851622ad845cdac48620737222933612ba1da9d8cd7c6 | Root reviewed the actual failure against this semantic mutation: Off-by-one rejection of the last authorized launch Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2276:49). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0503 | 2 | killed | 2026-09-16T05:22:34.945Z | eb2a60c44ee6d2a26922ecdef3bbf6596a58f57fcac6772121ece890894c00e7 | Root reviewed the actual failure against this semantic mutation: Accept a zero-millisecond continuation timeout Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2314:50). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0504 | 2 | killed | 2026-09-16T05:23:06.061Z | 2d27bf10571d3be561cd3bd370ad4bcd2acd67d035eb46b4ef59684f052e13c1 | Root reviewed the actual failure against this semantic mutation: Forget the original mutation-journal prefix Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2324:95). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0505 | 2 | killed | 2026-09-16T05:23:52.725Z | d759710362103b62657339418d579b9001cb928a3540147bf3ccdac49b400a4d | Root reviewed the actual failure against this semantic mutation: Ignore the legacy mapping semantic-attempt number Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2389:97). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0506 | 2 | killed | 2026-09-16T05:23:52.728Z | ff8aa5d209c6e3e1d6f23c10c94d4ee49a97b8bbad03c255281ac40678142282 | Root reviewed the actual failure against this semantic mutation: Allow an unapproved suffix test file Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2401:97). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0507 | 2 | killed | 2026-09-16T05:24:56.835Z | 1e00ce921ac6dcec41883f6b9e6486a34cdc693373faf56d837f5feffddcc5c2 | Root reviewed the actual failure against this semantic mutation: Permit a third semantic mutant for one canonical case Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2414:85). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0508 | 2 | killed | 2026-09-16T05:24:56.838Z | ef42a030daff4cb98b7efa7e2c3468023a9abcd7f4a54fd08a8efbd9c1c766ff | Root reviewed the actual failure against this semantic mutation: Treat round zero as the continuing first round Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2425:91). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0509 | 2 | killed | 2026-09-16T05:25:50.072Z | 8b535f8d85855c9a2996ad5825f435a512b3fac2567f89ae5dcda695e4dc5764 | Root reviewed the actual failure against this semantic mutation: Lose admission ancestry when the branch is renamed Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2435:39). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0510 | 2 | killed | 2026-09-16T05:25:50.076Z | 409e5d21fa3ad325c090fd2446fb311cc8f64e6a54ed341e2fad994ad2361679 | Root reviewed the actual failure against this semantic mutation: Require a committed document before recognizing the exact protected branch Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2443:97). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0511 | 2 | killed | 2026-09-16T05:26:36.024Z | 16a25c0c3a038dcf243c09d7e5bfcf70c9c84d651d8da1c14b27c37d41775544 | Root reviewed the actual failure against this semantic mutation: Trust retained artifact bytes without checking their digest Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2453:95). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0512 | 2 | killed | 2026-09-16T05:27:37.822Z | ee3129fa370ef87509d617a95201241d01776d4f475a9dc4291470df37ade193 | Root reviewed the actual failure against this semantic mutation: Require an assertion-failing baseline instead of a green baseline Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2073:86). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0513 | 2 | killed | 2026-09-16T05:27:37.825Z | ae58e8f04381003c02c93081609e3b7107700a4274a26a75d232f6ab658cbb92 | Root reviewed the actual failure against this semantic mutation: Ignore the canonical selector when binding kill evidence Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2133:68). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0514 | 2 | killed | 2026-09-16T05:28:12.327Z | 2ad741467670301fb82ba5df00af7212ac070167606f9431ecf682099b17803d | Root reviewed the actual failure against this semantic mutation: Ignore supervisor exit status when validating an assertion result Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2164:64). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0515 | 2 | killed | 2026-09-16T05:28:12.331Z | d4c2a00e78a7ad52ac1488594c31035a1a6a71fdcd8e7c47f378c17cac3f2181 | Root reviewed the actual failure against this semantic mutation: Base missing-report refusal on a mutable journal pin instead of durable lineage Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2217:27). The exact baseline passed and the mutant failed the existing behavioral assertion. |
| rt-0516 | 1 | killed | 2026-09-16T05:29:47.987Z | 860cc091826239887652048dda77b7da92d5b6945aa28ef7914531db8b49d2ab | Root reviewed the actual failure against this semantic mutation: Allow the mutation file to differ from the baseline-bound target Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2605:130). The exact baseline passed and the mutant failed the existing behavioral assertion. |

### Every retained launch

| Launch | Candidate | Attempt | Phase | Controller | Target | Result SHA256 | Root selection |
|---:|---|---:|---|---|---|---|---|
| 1 | rt-0126 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 6a8dea5be7f8d9080ceb0179b330cc1a30ae6e7c43e26d5efd3e10307c3bf52e | historical record unchanged |
| 2 | rt-0126 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 6822cc7f7890df980a1f45b9202870ed52594df62328e6e980e3eb5101d17377 | historical record unchanged |
| 3 | rt-0127 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 06bafac740f631f6ddad596b6f42b34c156ba954cbf93ddef983476e6ae4cda0 | historical record unchanged |
| 4 | rt-0127 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 89a684f93f656aac021193ab95ffda7af0caae8feff2b17d0714200a5d9d57f6 | historical record unchanged |
| 5 | rt-0137 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | ce617f650eb8458a9c2fdf983750f56396d23729131a9405b7d92430d75e353f | historical record unchanged |
| 6 | rt-0137 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 5f8ea5c2f2a702d4c588e43478b425d7e83cef8a83ab0beea8154bdd11c2e5d3 | historical record unchanged |
| 7 | rt-0138 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 3011c28d735b5e94acc3e10980e42a62723dab7396020399141004ccee8bb43b | historical record unchanged |
| 8 | rt-0138 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | c343156503b2a31554929dffe24ec0cd6449e6fd7f9e28790510cca5a242f40b | historical record unchanged |
| 9 | rt-0139 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | deb41b05e720397e143c8fee267da616ce3f5dfa57cc917a1777eeca3ddc2141 | historical record unchanged |
| 10 | rt-0139 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | ebc07bca02e41b1ee0f735a95fed2bb669452e64eea75ced68371b5c57fd2631 | historical record unchanged |
| 11 | rt-0140 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 7f9f7a5625b714233e15bb0546b1276b3a0194d3411443777033fdfe060ffac3 | historical record unchanged |
| 12 | rt-0140 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | a4ab8c14ff748e95f0e16cbd4ad9b8d37f735eb3501cc59a08cb6d644ea1c5ce | historical record unchanged |
| 13 | rt-0142 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | c7893a1f84eb17eb3d488329ae695ea89550eed629f732dc8953e14d3ff18825 | historical record unchanged |
| 14 | rt-0142 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 5e810090a9822ccca1da2d8cc503757dfb6ae9a7011d2f25a591abdc627f9539 | historical record unchanged |
| 15 | rt-0117 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 93354c5bb6a5a49fccd695e80ab401aabd8c429cf655898249400060a37a95f6 | historical record unchanged |
| 16 | rt-0117 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | ff974a16a7ed5902b3ea1c4a2eec105b2f716fe94c7b14bc0a1769dfe3488527 | historical record unchanged |
| 17 | rt-0118 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | b500a6061f67855e4ffa1adfd9b325cce210b32c6956a50f6797950d5db4fce6 | historical record unchanged |
| 18 | rt-0118 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 8cb55af5729ae4d752b0e7da806c861be00770f71814eb9abb0f073f72b34bef | historical record unchanged |
| 19 | rt-0120 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 7dec33381ee144882b5ffe889d84c3708b73e59908274c71dae3b38de07a8bff | historical record unchanged |
| 20 | rt-0120 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | fbe97d1421ac25f93f25a2194a738f571d3e5bb5fca2d7b69d082bf27d47a0f4 | historical record unchanged |
| 21 | rt-0122 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 6b226f2066d9e8b1fb9442a39a9a2a8e6ffb545708b9c7f4d0a76bb2e53baaa7 | historical record unchanged |
| 22 | rt-0122 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 8479dcd8f28e39aa908ef15e5708bd030e35afd2e026412a9fcacefa7e6ef00b | historical record unchanged |
| 23 | rt-0155 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 8756fd180a033c034832f6d17a187cf9caf9308730ab77d3b44c7bf79047cfc7 | historical record unchanged |
| 24 | rt-0155 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | c1ed2d99a88d612a2f9da26362e8842dd9febace7ccc8acc59e33d24c9072f67 | historical record unchanged |
| 25 | rt-0156 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | a2b83a97e2189cbd5537d882858933a0ee6dd345eec2c8b7df67f0df64d32e3a | historical record unchanged |
| 26 | rt-0156 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | c4c95c15232e09ca0b8deae5a8e72786a952ce084d5c93b8f193e8e5f2f16e80 | historical record unchanged |
| 27 | rt-0261 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | c341f158ce179ea7888ed9e2a7d003e590684636a3b9718e9a073985f13d42c5 | historical record unchanged |
| 28 | rt-0261 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 7aaaef86febe9711f17293f16a272a6139db8721c4fca4e4601acc1d9b7f15a0 | historical record unchanged |
| 29 | rt-0262 | 1 | baseline | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 63a743fa2eb2278a7a78eee4394e6fbfc012e61023de6aec36cbafbec6e6b630 | historical record unchanged |
| 30 | rt-0262 | 1 | mutant | 2ac6ff871b4496f996c37aaaaade9bdc7eee9a62 | src/lib/agents/operator/apply.ts | 940883e24482fdced1e14cece2dfb943625aeb144fdfcc6573fc0b64b112ae71 | historical record unchanged |
| 31 | rt-0129 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/apply.ts | eb8d015895fadfbbcf048227305b2b35587459ae35417d8ff76ee9c9c4609a97 | killed |
| 32 | rt-0129 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/apply.ts | cc906f6c5fdc0bf2fc5122cfa1764da52c8e4deff62764a8133a7b33921d1962 | killed |
| 33 | rt-0010 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | bf65939deb3b1edc8827af398c430205c54559b8a2bafbcfba4c7172f2de1cd4 | killed |
| 34 | rt-0010 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 7a02132b6055cf32360e0eb073aad4399d20a849471323abb46f90ed0c84f6cf | killed |
| 35 | rt-0011 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 090b2a2bf2961dd4ceae530db188ffe42c1ab032bc03c41cdef544a1ef250004 | killed |
| 36 | rt-0011 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 5f0fa9b1b25bf9f566f6a4dce251cafe25a078dba407303059c3015cbf4eb37c | killed |
| 37 | rt-0041 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/ProposalCard.tsx | 16568726640ea4a9d146b7535be3a43d3f8bb4bc7ab670da03c2fbe4e5374d50 | killed |
| 38 | rt-0041 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/app/(authenticated)/dashboard/operator/ProposalCard.tsx | a1640a9e104ca51275308f4f86c1072477ad3e26d65188f1ca7a7bf12e64dbe6 | killed |
| 39 | rt-0141 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/apply.ts | 9266e2be758e2257b8aee5497822f11107b50fc5d6e28b348a5089e3d3aad916 | killed |
| 40 | rt-0141 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/apply.ts | 4280fa1bc45f8371e94c1f5f8aa0c1fcd1ee8c0b541f238f651eed63510fe56f | killed |
| 41 | rt-0284 | 1 | baseline | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/turns.ts | 5a5f2fd067d67ce4f7df0bb6e5320b16e02e32f574c9d57d1b1cc0a56ae79cb5 | killed |
| 42 | rt-0284 | 1 | mutant | 03502fdcee60e61b891636a625c95c6a9dadec9b | src/lib/agents/operator/turns.ts | 450d54a69faed9a3f250da190d1514708145124ebd4665b57d48fa1326cc7fe3 | killed |
| 43 | rt-0120 | 2 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | fa1f6b4a15f43fa123731b42b95d105e62a41160dc03ae1b24a12224463af296 | killed |
| 44 | rt-0120 | 2 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | a83b579b9ca40b9a23907b3e4472700c90073116cc60891c3b76ee5eec13c22a | killed |
| 45 | rt-0137 | 2 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | f85302d276886021149659f38f75075d04565642e4a24f46dcf9b3227965ce27 | killed |
| 46 | rt-0137 | 2 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 09deec240e5e6eafe0fcf5a790707158b3ef1dfd388c2ee97cad6577ae41e5f9 | killed |
| 47 | rt-0138 | 2 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 8f049b6bc4ae08c0264368dd650a0de69962570a1eba178c24cde20e1e4a3fce | killed |
| 48 | rt-0138 | 2 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 7d409ef16153d6334ef9086d7df613dde6c36ad6e3ccd68e690d9e88ad88a3ae | killed |
| 49 | rt-0139 | 2 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | a8c5fa117695a57162a70b33e6eadab7d4fbb77df6c2c8ecff336dbccf043f3b | killed |
| 50 | rt-0139 | 2 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 2a49e0cfab09976e11658a147216c2edf96e5f2d3e673fc70f522e3c043b9eed | killed |
| 51 | rt-0140 | 2 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | bc55cf5e40ea222148ed3c045ce1b2477f4d3be9fa2fa2b2e5c04661e8749f2a | killed |
| 52 | rt-0140 | 2 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 502a6f736f7440c3dcb70d7ebb9a896642196c905e65c50ee13286aa7bfb29a1 | killed |
| 53 | rt-0502 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | a2cd7fff6c5e4f6ccdca764e090740bc2563f9e870981680afde1bef2e55b259 | not selected by root |
| 54 | rt-0502 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 1c4ce0d8ea002166831eb89b4aa0913a746712b5cf154a508884a4dc47bd54d9 | not selected by root |
| 55 | rt-0503 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 455c0eebc706d4b874bd9b35c4a9381e184f1239919a1597ac5dc2ecbb64bee2 | not selected by root |
| 56 | rt-0503 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | e75b3a6d9c8404c497a66abf96aac36b07e217644e6541e854a5d7cb55358528 | not selected by root |
| 57 | rt-0504 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 6d2553dfde1b89ae56b9185e5e817d44f0b5c0c51eaa05c29b776efe72a11404 | not selected by root |
| 58 | rt-0504 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 312e9444f9e415c5c99f4a8677cd4acdfaf155dd6f4708a767a11e28636d9b1d | not selected by root |
| 59 | rt-0505 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 4e1ff4ce3477a05dc45d32c8f9b17f2bb337877562939ebe6f725d391a5ab599 | not selected by root |
| 60 | rt-0505 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 930c952a5c21c3db6c828e89174499a12dee87f523fdb4b4b40b8bd2e1e4b318 | not selected by root |
| 61 | rt-0506 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 6138ecdcb8d16ad3a34f0bea0624a69c267842d3174f0cdce251d0676afb0eed | not selected by root |
| 62 | rt-0506 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 29eb92bbfcef8a118995a4dc399577865f4793038fc4ebc8db94aae7be3aa1d1 | not selected by root |
| 63 | rt-0005 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 70911a87a97836ffb5e9a3ebe63138f6f2fe467bca4fbf7883e85aac3eac54ce | killed |
| 64 | rt-0005 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 2cddc184cf1c7b548fb4680bde994e1b5586db0cd59ea8793a1e569de58583ce | killed |
| 65 | rt-0006 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | f7159ea43924cc4ae5eddce3facb6e44043e25cfaacfd6c41d212f16c5ef4a96 | killed |
| 66 | rt-0006 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 74fba04ed57734920831a64e5108970be4c3c00c0536fef5872a83228b02a368 | killed |
| 67 | rt-0007 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 710f6115b9743f1be5b290d22d27ddcd75302c244a1f005cf9d5fa2118923c64 | killed |
| 68 | rt-0007 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 84d1097e41dd19372ead98663bcda3340ce579945dc2d0cbe7e0978b28c302ef | killed |
| 69 | rt-0009 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 3ebcdbf16e2c57d041594ba27e2f099570d4c4de0705646c3dc6c909ac853119 | killed |
| 70 | rt-0009 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 8b0e89d5d38bfc902875c6663fa189206b28f713a833a44dc195cf06dc0f9eb9 | killed |
| 71 | rt-0012 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | a4f902a3c152ab2ca71ae714baca014ebe724f1241ca518a3157b276c03d5c84 | killed |
| 72 | rt-0012 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 4502b5df59a00a6bb61a247704d0469c49b21e2a78c0cb5c7caef434433440dd | killed |
| 73 | rt-0013 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 2db26f85ff49f163b6064bb4f71b5be2901756e16085f37f65e1afeabb3b1b5c | killed |
| 74 | rt-0013 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 7d87feb7b5a0c7324bcb2ac4743bac2758ad07ffa5eca15cd89c94d37b85b47a | killed |
| 75 | rt-0014 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/TurnBody.tsx | cfe45d79e68239957d11a336e60167578383d75c01c386f321b8d83190717846 | killed |
| 76 | rt-0014 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/TurnBody.tsx | f328c8d621477bbb70feb393d5a3a73296779e2c827178fcd27b1e9e8b657113 | killed |
| 77 | rt-0015 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | a9e07fbe193c5e3683cd2a47e001106d1451cf41d1a46b7b77fc625c0e2061cf | killed |
| 78 | rt-0015 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 54f5f08cc065fbac2341a9ed70af638160460633d636623f9c7b4a5e6b6e1ed9 | killed |
| 79 | rt-0016 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 2baaf72556f2d18a928a8d85129712e449f57cf61507d7a79f7c57220cc59257 | killed |
| 80 | rt-0016 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 35372b5cb8a59073385ffdf9090211576b21185eba84610b91eceb0dca419970 | killed |
| 81 | rt-0017 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 28c98a4a811dd34160aba8b6ce29969a8a319a01a67b4925573ee92600e8d771 | killed |
| 82 | rt-0017 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 35cc0617e10bdd3f6f9423f41cf5fd09220b7d263dcacc70b315f9d7d797d59a | killed |
| 83 | rt-0020 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 3dc8aaeaf03a9a1e3dfca963c4da74fbb87866f3b8158f913ce77113414387e1 | killed |
| 84 | rt-0020 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 0d566421c1c8d12721aa8865b8b9ac37607610abae362fe2e8321d22407fdd0e | killed |
| 85 | rt-0022 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 8d264ef1907debfbfc66740048e1fbeeb45b2fc2dfc7c95ec1445de26a6d04d7 | killed |
| 86 | rt-0022 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 8bcdd409bff5abff2907f13fd4265d56dbe61f91dd46b8cb1f7c0bd174130cac | killed |
| 87 | rt-0030 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/TurnBody.tsx | 88dd7d0a3de70546587b12402b40502cbfbed4c7a536284cabec569d6c05d842 | killed |
| 88 | rt-0030 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/TurnBody.tsx | 68e1fd174a6d70db8f328600934d1e7d9f396fd2fe1e450be641072fde2d6213 | killed |
| 89 | rt-0035 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | df75a5c7b691f9a3806ed9a11207bb66608c225944d10f4b6e92420a2e98cbe9 | killed |
| 90 | rt-0035 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | d59bc8cf69043da146fdfbaa3d33af18df5bdae8bdbdf1807ebde33960b811e1 | killed |
| 91 | rt-0036 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 2cc9ee15e934cfaf6cbb78c2dfac5123dcd3351f86fdfa552cbab4cd5032ffe7 | killed |
| 92 | rt-0036 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | f68354970c646c71a4f5729d994183914e800505ae525a83bb3616e4396970c7 | killed |
| 93 | rt-0037 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | fb356baf62b8e5cc07e9a800f4100cb798232096b0c949890f780cacb0dbb45c | killed |
| 94 | rt-0037 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | a2d57e759699c16cbfbce287c032640774e6a8e72fbc41cce58d5725c97b4ccc | killed |
| 95 | rt-0038 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 60976e4b3dd91357aba38fe388649d67ae83898c52c75162efc282a93deb98e1 | killed |
| 96 | rt-0038 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | b6ab03aceb6e8b4adc0aa0f2c0388aef3c455ae8b8cfb35ebef8d57a67db59bc | killed |
| 97 | rt-0039 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/ProposalCard.tsx | 0264911aefe0e748b9abccc54d6a46a09c4f80bb98e8a0f2576f4fd5f95a9109 | killed |
| 98 | rt-0039 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/ProposalCard.tsx | 9418e187ab2b375cf95ebe82924276f203f9f0fd6b0db0844fb1eca921068210 | killed |
| 99 | rt-0040 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 6a8a851413eb6cdb05a9d7a47305cd6c64a78e4ac0b50be22e60a63ab593c6d6 | killed |
| 100 | rt-0040 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 0c5300eb102c2cd1deaa71b4f4318d25d4c707bc8b308086e7d7cfd597675399 | killed |
| 101 | rt-0044 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 3734e47433de6ea444ac4df590dac10778e74f503e0f8bd4df19a12e7d39e3f9 | killed |
| 102 | rt-0044 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 6f96e5cdcf041da4917fe97b0926afa8ff929d2b8830d384299dcd8b7bf9cc14 | killed |
| 103 | rt-0045 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | 19d4724616d31fdc1f98b945b05d221195fa5337423287bf39d8500e94b866f0 | killed |
| 104 | rt-0045 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts | b98b52126ca43eee255f1cc7008eb7cd32509a675510b251f961a8650410ada2 | killed |
| 105 | rt-0056 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | c2a22a44e33fb2505e093a3b4adf3e024ed329ebd14786be28a0c41dca0c8d40 | killed |
| 106 | rt-0056 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 47ca20f6e8a3308a83c24edb7087940913f6e1b1d39dd24b102be71515a2c298 | killed |
| 107 | rt-0057 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 20f29244e082b6381b9a7ba44c31cb1005444f4788730ae63da6392c54bc71f0 | killed |
| 108 | rt-0057 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | c958c1a2251fb5aa1cfa8670508a1e333ca2aab56f7130255296940cf629d9fc | killed |
| 109 | rt-0058 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 35970c2caf6821c5ad062bb466d61e86abed5458eac30fe023ebafaceeddad38 | killed |
| 110 | rt-0058 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | b208b0f60bb49060cc1a266c238967be45a77dfe2814065f4c5f983961feb4ec | killed |
| 111 | rt-0059 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | da1c24cd47dedfc94ea5f86315d9971c975d01c0527e804e984e88a09265033e | killed |
| 112 | rt-0059 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | ebd4edb723acb3b4808e65890be726b913b14ba76a40bd2db65c43b2ca51e9a7 | killed |
| 113 | rt-0060 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 78fed9a9959925066bd95b6af11c3af259343be02d4e8231e2d8c58f9c002de1 | killed |
| 114 | rt-0060 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 7b33861e3022e11d4091efafdd3f5d88bdcfcac89422168b7fa55f3a0e7579b2 | killed |
| 115 | rt-0061 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | b23e4c1fccc1fe2b50caff33930124f07450aab0c86c990e70cdbc34b67f8286 | killed |
| 116 | rt-0061 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | b2a30444643f2cf1e3ddc5fb733e6f686c99abd768c13fd0e0982c4b6f2fb26e | killed |
| 117 | rt-0062 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 6f607909a136a140d1ac0362003981bd0ec631486d5f9ce625a6ebc967920f41 | killed |
| 118 | rt-0062 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/(authenticated)/dashboard/operator/useProposalWrites.ts | 83d23b4909b8072ea1ef71c2038d84eb447ba830cf129b9c570dc172053398e2 | killed |
| 119 | rt-0066 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/apply/route.ts | 9ae48d49dd50ed3f1a76dfacebccdc145596dd83d90dc520bea8278080f0cabc | killed |
| 120 | rt-0066 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/apply/route.ts | 30523dff2871d4bae6aa4fff696da3cb49749fd79b5544834e5deeaabdff943d | killed |
| 121 | rt-0067 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/apply/route.ts | 29e242a1edbd6a0e72193f61252f5150ab591896d283b11a102ec92118da70ee | killed |
| 122 | rt-0067 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/apply/route.ts | c29bde4b0a8eac3f2f13e78b50edee490c3966b956eddac61cbee46f919cefc6 | killed |
| 123 | rt-0068 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 8a8fc122058ca83678dcd3464722783a335997fbd069aa99f7550a6a31881214 | killed |
| 124 | rt-0068 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 90cd25d28f567d795c80475299d0fc82a329a5c0889eaadca3b735989c3bb42f | killed |
| 125 | rt-0069 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 5ff41b39c1d8b301f5a27d982fd37690b8dc13c3f96993966dd6c7a36e0f0204 | killed |
| 126 | rt-0069 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 39ef170c37f1790ff493cc7f81f9bebd967f2dca430ed7976f7196c9ff6b3d79 | killed |
| 127 | rt-0070 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 06f5e5ab12b5d679e3742af1b2d59ffd961dd5cebdbce9659aac37191d26cbb7 | killed |
| 128 | rt-0070 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 6d4d53ed824f4415e0e367305a1316917f8908c851ba2b5169c4441e8348d147 | killed |
| 129 | rt-0071 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | c8a3d03c956294812397991fdbe51eb4e6014984fd4d3bb35465c68f7b94bc22 | killed |
| 130 | rt-0071 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 10a8ee62dc4c0566df66551f6495192f5be96e92d5fcbd0a255ce5b4138dde6b | killed |
| 131 | rt-0072 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 33815121291e3ab8fa489519b22d444fd13f714777f926d4a303221e7a2eb81a | killed |
| 132 | rt-0072 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 3a4cf73c6fdebb0b76b237061534b617076a0adba396b47b32827ec818756ce2 | killed |
| 133 | rt-0080 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 0e9c0ab368bf977d26b4051fa2afdc5a5ac02a017763e12d0498681d141e616e | killed |
| 134 | rt-0080 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 9826336aa09a7f4bf7ce3942489addf5814879e1ffc9db1b1ad59d7e779c3f30 | killed |
| 135 | rt-0088 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 22a1dfe7ebeed67c99bee762637e6d12669566234ce38478347341ba68b28781 | killed |
| 136 | rt-0088 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 1da0f8b5217421ec5ee7dc55e7b75f69b8a379ce9c03dcccaa175741c8f8210a | killed |
| 137 | rt-0089 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 20af589315a4c6095e6e4b684738f6217845c66bd8400a3d8d5680a2f348da3f | killed |
| 138 | rt-0089 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 0be4860612e70136cda768d2da822e590c897e4b88bf865f88534e4d4d543d17 | killed |
| 139 | rt-0090 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 6dc7e4a72209fcb930e7c63a256bd0a20f5d4675469532e57eabd6994fecadc3 | killed |
| 140 | rt-0090 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 1754ac411acfc265b040ba0a94c53cbb1f48fbf78bfb369db424b9ab79949be6 | killed |
| 141 | rt-0091 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 0451a834f28d67f07696f78fb5517f62f2c1e70e3f688e94e9310a71ca117717 | killed |
| 142 | rt-0091 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 9fc561ea8f0e1ac497ae56a31339db51b1d11f27f00733ee88ddf17204027af0 | killed |
| 143 | rt-0092 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | ce19bb45b64def4d030295c91d77f54ebbde60a727788230c5abb12ba17a69ee | killed |
| 144 | rt-0092 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 1d3593fa0175f6185090fa1a484ce2f447ce7d4cf0c402de824dd9725cb68309 | killed |
| 145 | rt-0093 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | ea47aa62105f512d7071665b5904498f06b8ce5cf4e0ab30d1ac7f21e8e4e983 | killed |
| 146 | rt-0093 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 076bb5990b8c959200383dba09e59a6f04d84539c0360a175a33c73d2d063469 | killed |
| 147 | rt-0094 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | f0261be342dfa5b10845d6990a0e42ff7d38ffea4d045317d33096a4cfde4b17 | killed |
| 148 | rt-0094 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/proposals/[id]/restore/route.ts | 9884ece5afcf1fdb51c36ede516ac1024fb3fe92d2bec8f7c077567c3e910466 | killed |
| 149 | rt-0095 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 71966ddcb9de66bac26bec840b89ac562fd9c66430d8d2acb6e0856bd7d3f8d5 | killed |
| 150 | rt-0095 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | a8bfd6df670484c658519ba08c433a9e6b32d316e16ed94f7ca252db13ba8e3e | killed |
| 151 | rt-0096 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 63cae7a0dba2474a79ba27e269f54c3e829fbaa0aa8eef42e3b94c5a2ef6c83f | killed |
| 152 | rt-0096 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | e00ebc5d7801f15b8f91160166f2f594f2b2cb02a60e34ae01a4487f749695d5 | killed |
| 153 | rt-0097 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 65884851c8280aabe7932c8299bdd045ababca5e7e9b723117dad8d777b94d9d | killed |
| 154 | rt-0097 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 0cadf97137313dfd84fecbee8b9a4d81c7dc39dbc60039adcb6ad08edcef14fd | killed |
| 155 | rt-0098 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 7d75d8f122a10c744e93c737325498f730afe13d8e1a39b608b9aae8eb088ddf | killed |
| 156 | rt-0098 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 6f89e168c5799d566a7f692e91cf355dbac5fab93f5dc138aaf114d2c3976ea3 | killed |
| 157 | rt-0099 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | accfad9e928c6093b23fdab3773369c7586805891b39051e2e44529b406502df | killed |
| 158 | rt-0099 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | ca6dc85b4025f277c614609de294895aaad752f6361ff926e20bff6b88fbb96c | killed |
| 159 | rt-0100 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | c465c9b08d076cbcb82fa580ed13886f701807966764acb74e3355f1c2a1ecad | killed |
| 160 | rt-0100 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 0d357e37d6f7b9aa6b03ca44fbb4ffea0b639c6fc31be118944a1a9a77ed4136 | killed |
| 161 | rt-0101 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 65e8d70eeef01fca625b64a4c9f438264239cf50b1fcd17ae33bc44ffc231020 | killed |
| 162 | rt-0101 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | ac218650b7c074bf5d71e3e5fe2c1bffc1477b85ad2d150ced9091eb34f9cd85 | killed |
| 163 | rt-0102 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 4e6e1f1c74879c818e404b980935f819e8b9de49c5fd75764c8606f5de765d5e | killed |
| 164 | rt-0102 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 4817f6bcde5842bd235b67fd76b7fe98a4c7290a2e1430c156b9dd15c4a8dac2 | killed |
| 165 | rt-0103 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 8491ee4b5ed68d07d145c8863f4b86eb9ff7bcee6d478e5035d641b17da797e3 | not selected by root |
| 166 | rt-0104 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 94ffe92a3100c27a4f7bde3f67541ee411a4d65e560a63c52430e9bf1452c460 | killed |
| 167 | rt-0104 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 7a546ecb554b24a4604f3fc5b0875d6eedbbba6f91524cf4bc6ba4ee63dcf2ca | killed |
| 168 | rt-0105 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 07211da5e3ce4f780dcb654686547bcf82974a2bdceccd6ceece501e37808807 | killed |
| 169 | rt-0105 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 8fc39faa0bae8af96d7da5f8df3d50161d9099b8bbadae723e08e53c4c0e0106 | killed |
| 170 | rt-0106 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 7626df8a3e4fba42866ffc382198c9c1d6268edebde0b7957322769b3bad2811 | killed |
| 171 | rt-0106 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | a59e86b77e939b3d770095770f6e45329d64e70943d2d331648e2c18c3ad91f5 | killed |
| 172 | rt-0107 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 4c973435f59773ad13ca1192a500e93e1f45437ee9903b85d187054ac1ad80ea | killed |
| 173 | rt-0107 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | aa3befc03290d4163c292e0cf1fc601a37b1eab638c6e15568c8fa140eee2eb0 | killed |
| 174 | rt-0108 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | e125ffb6b4a11a5fedd1593807d78c5cbbdf36451e354ee13fd25f433ab56cbd | killed |
| 175 | rt-0108 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/app/api/operator/gate.ts | 536b70c18db8c12108a5d72c8b4c15d19eb93aff65b2ec128800bcd0bb64ea52 | killed |
| 176 | rt-0121 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 2a17a9aff44deb5c948dfaba16cc96fd4be132eaa02987188264fe15b9e2e9e2 | killed |
| 177 | rt-0121 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 12eff0c7ede755800f631fb136e200b57f06764f6859c571b4844018c7eb13df | killed |
| 178 | rt-0123 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 71a5186f19b598f2a1280b4895aa301f47fe18739b9655013c10af76efadd2fb | killed |
| 179 | rt-0123 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 949dbae83d1b65b56775ff075936ee265c16a37d27216772475e3d1c1d6c75da | killed |
| 180 | rt-0124 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 35d1ab7574dd6cb59d2a2c1ca86699074144d4d8c34c4e09a880c7578ac2e93b | killed |
| 181 | rt-0124 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 36d4d18f9615147908c32651ee195bd254ba8928b7b52bd9b17f0f13286ca472 | killed |
| 182 | rt-0130 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | fdbe0fb80d505766d762994c55bd7ecbcf3d1a3c7cf48ba3f69755c8830cb97f | killed |
| 183 | rt-0130 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 64216db4b3faf7f4cba343f46de5f83865f94b3303e8f832ac6f04f7222755f3 | killed |
| 184 | rt-0134 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 997c44c00b298daee59a3b1c84618171f1d8c6ce9a580c49eeaf0d9c47fbf9f6 | killed |
| 185 | rt-0134 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | be5bc9d5c4384768db22f71d0705e24685e746c6d2e66cdd0741438dc5fd9772 | killed |
| 186 | rt-0144 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/turns.ts | 2e64d4871d966dfaddb1ed10522606c153b7a0de01a76c7843148a5ac6b312b8 | killed |
| 187 | rt-0144 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/turns.ts | c84275a14ab16f30c45c95afe844fe6de50f01566a09e73eaec55c004e419ab3 | killed |
| 188 | rt-0157 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | bbf04e4f9036f3cab20b3311251c95ce9b3c663121e53563e6ae364e68c34451 | killed |
| 189 | rt-0157 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 58e520a669d40f13e90897745453986f7ffdeec2040f3ba02a80ec3aa8aaf128 | killed |
| 190 | rt-0158 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | a52edcf8aac46ff19271420348796ce4c14c79c2dee11cb6e1e604894cfb4582 | killed |
| 191 | rt-0158 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 3df520611e3e0418c8a210165a581d0a59e7280a54db221c5e1cc54f88fbdfc5 | killed |
| 192 | rt-0159 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | d67350e2271995613585fe334458c3be8faae52936e58351eea752b26eeaac16 | killed |
| 193 | rt-0159 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | abf046eb7d8a3b702df1f9b5d5effdbee660915a558600b4181c11b2a82fe33c | killed |
| 194 | rt-0160 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 22700092fa9f624cd7881ebb911207801dc9a6c0df9bb93812b22451d23e93ac | killed |
| 195 | rt-0160 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 43ab5f4d747d182ec3541a27abbbbe252af1eb3964a731cffb8a908de140b8db | killed |
| 196 | rt-0161 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | c9f3c0b6a8e5f03a32313a945fa2a9417c21ed2087192075ee85bacdecb4022d | killed |
| 197 | rt-0161 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 17c2ed31c86d5f0b3573463c89b5a68e45ca0f9bcb964f3709bf822b410e4dbf | killed |
| 198 | rt-0162 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 20fa2e887455331e04d0bd8b7361709b2a124c7bac223a21ae703deb3c66f50d | killed |
| 199 | rt-0162 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 9f5caf8714d914b5731e4ea89d347f7c79fc3da6be1261502b4f672f16fa6921 | killed |
| 200 | rt-0164 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | d0587c83ccfe5d0dca9c9034263e22f5508ba85677ebbe7436c7bda7ce95d2f5 | killed |
| 201 | rt-0164 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 8b802548af37cd48be01a9361e3290d3331cca511a0dec9ff3034e0303127eeb | killed |
| 202 | rt-0165 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | be8ad88a8d4ddd9abd5ae6bf547cee051f231b0bf3d711932a8aaf8d5d942435 | killed |
| 203 | rt-0165 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 047262eed0f8706e7c76fbb4a884f90ba286535d3acd4fec6de69667df7edade | killed |
| 204 | rt-0166 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 2a61fe0567fd1cf0f3a9708fbf72dd3f8e7fb9dbe1bcc71e482de7c75e99549d | killed |
| 205 | rt-0166 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | e6064ff78c79d0892487a76eb884beec602a0e6e31fa5b03af7a759c2d88a35c | killed |
| 206 | rt-0167 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | cade80d1e7bf2a0e38ae9be0d2cb5685620d84d3db244bb7dfe10e573e0155d1 | killed |
| 207 | rt-0167 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 6775fb01c9cec3b67ebe26f7f48f727c88c8d5078b44bde342ce2f2c8c27871e | killed |
| 208 | rt-0168 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | cb61166183db40be0972b8e2f4949964476fa28889268d7dfcb0ae00def6e352 | killed |
| 209 | rt-0168 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 5797be07933e8fab1ed4c30cbf340c3ee11a60e8704ec5f46f0911f83a20d6fa | killed |
| 210 | rt-0169 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 0cb29be397005a4944eafa21bbee8c4d4b55eb75af4b22fa47da9e9331b6294a | killed |
| 211 | rt-0169 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 12aef70ae6ab60e939c0788c8179046300781da6b5a37c034817752adcc41a7e | killed |
| 212 | rt-0170 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 92c9e2684d6217ae1caaecb6e6c8aec632896f4937b8b06ccc7c092a365558e7 | killed |
| 213 | rt-0170 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 075c7a596be217993ad57f07d536a5e28e9161080c254282bfc77bb9f3c093ef | killed |
| 214 | rt-0173 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | f36fbe3c65911526817407f64722b78815aa87f8fbbfae7f811c1c670c7f4360 | killed |
| 215 | rt-0173 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | eb144939d4ed5694121db0982a03da38fedf3009fdef1db68ffd50e083dd1316 | killed |
| 216 | rt-0174 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | bbbb8e2d934e834340a2b2cfcebc219fb33e801d4532802875c738e802529cf5 | killed |
| 217 | rt-0174 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 430e926ee14a731f9ad1cd8c105140334d43173ed1021442592a638d0a8dec12 | killed |
| 218 | rt-0191 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 2ea218be2345e5908a324b2974e47d8d41fe5bbacfc7bf86c21ed85857f77ed6 | killed |
| 219 | rt-0191 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | f720f17a6daafec69bfde560dc35e1d45cd003f20ffdeb551b05205be5a1612e | killed |
| 220 | rt-0198 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | c7f2df3cb4635e0288aa7069859abee2280c3a5ae45137ca8ff730a2a1ae892f | killed |
| 221 | rt-0198 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | f21fc5803b4209f20aa0e33585209d78e3097a6bf0d1928215b5664f140e1a4a | killed |
| 222 | rt-0200 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | fd37e06b7a2985b4cec8f6421b14ae4c81ccd5ae4af82c6a8c5e0532b6230488 | killed |
| 223 | rt-0200 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | e6260aa8e8f65d4fc53b9b3a16295b26df6eb18fe944b9bc597a7b7bd7cde6b3 | killed |
| 224 | rt-0203 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 364e0657bd5570101ee10addcf3888bd8579df22424cf25f68f6caf94333785f | killed |
| 225 | rt-0203 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 0f7a084cb2048c7c6f19fae5fc2261ffdc36a86e0c62e9eb1586fce0b05789de | killed |
| 226 | rt-0204 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | cd2e84a77264ca273a2bdbf0bc71a11f53523d689e9e08f63a2db382f11f61ba | killed |
| 227 | rt-0204 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | cf6c21cedf7b4b3631d1077cf3e377c4ebc510254c5bfd9038afa012ae88b9fe | killed |
| 228 | rt-0205 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 3478035a0ecf1fd9bcdc92e0ab426f1169f546e9bceabc758e0607d915e907b2 | killed |
| 229 | rt-0205 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | dea7c3e5c53148b82d995bf1fa834caacff18111932e469ce7f536a9444161dc | killed |
| 230 | rt-0206 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 4078dfbf16f9eff50fb1e081ae31e98ac744cbb629c505f7611ad75a12044142 | killed |
| 231 | rt-0206 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 5c1341ae3142ae496f87435b9c55a1bacc05580009fe1dc2845ef477147b75ca | killed |
| 232 | rt-0247 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | ab2936ef3c39d2c2f35fa9872575ca9f0ff2209d4514c3fd074203ddd0c75db3 | killed |
| 233 | rt-0247 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 04fb49f43644d3fe5dd5873ec32c9c3595aec7b537ccd4d3f3f89338d8693050 | killed |
| 234 | rt-0248 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | fa4808ce1ccb851aabcb62e46b55d05c1d776b9b80f99ef54ff60d724e887e0f | killed |
| 235 | rt-0248 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | afbf2879eb7549ae8d758e36822eac46f0797fae98633c047224c730e2898924 | killed |
| 236 | rt-0249 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 2a1fb0da03ec65bbb085afccf59f9f96cce97a2348293a9e0a848a06cb6d683b | killed |
| 237 | rt-0249 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 1d9a9349316656f84c137fd9369fbfbb9a7c284a5d6e3b9aa7a2ccaec308d939 | killed |
| 238 | rt-0250 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 7124e1b9edc22863a061cf77668940fa3c93d586c47db6f4af95e171c84d7fa8 | killed |
| 239 | rt-0250 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | b0812aab8650202287fa25681fb229cd7724a5f1b755e359318dfe55b359cb42 | killed |
| 240 | rt-0251 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | beffbcac2a12f63d562f4dc5a116ee9919e6dff92fb7e5df68dbfb7f44ab4290 | killed |
| 241 | rt-0251 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 47a9395acd803c7ac08548ed29b575a0ee5311e3c184ead9709cfff9a27d5b44 | killed |
| 242 | rt-0252 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | f9fee2ba9e5ffb8a513f16db1b871680d9b29eaecf1aa389d719ccc89cdbb4a3 | killed |
| 243 | rt-0252 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 1cb324f91a3a81b36458db8ec6cb52a80fbae989c87927187c14ec3c558cc180 | killed |
| 244 | rt-0253 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 0155e5dbee99d690d5358e9c57ad4c3782e6dfe7bbad0f52bbc21ee9a5e48403 | killed |
| 245 | rt-0253 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 74feffbf665941b17721776fe2f061dbd4f1a94e357083d2d3ee77a831563c82 | killed |
| 246 | rt-0254 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 598833922d3b1d22ef353781d518dcdacbe6cfb2e52b9553f84244e24aa7fa88 | killed |
| 247 | rt-0254 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore-inputs.ts | 678af259bbcc6513091fb4c5d136a822da2d00017172850e7a6df24247cf535a | killed |
| 248 | rt-0255 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 7b2a3099140511153184a61968217a7ca7290b5f28ea082b47cc95d1f32906ca | killed |
| 249 | rt-0255 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 2d3502b457abc3ce74d6aa0cd85643c2cb06d5e96cb4a6d9c7d0d4961a1cc480 | killed |
| 250 | rt-0256 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 5457ce65345d271518f7995be2c5e0fd222c48aa3265398f9e8280b164c95c70 | killed |
| 251 | rt-0256 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | a33fb7349d5f822d3f9f34cb02b6e0452150884b7317597f3deb2e84560be27a | killed |
| 252 | rt-0258 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 60eb0b09a46e49ed7ba6457a0195632f7d649ca67036eb5f88609d15f3603c66 | killed |
| 253 | rt-0258 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 9998f8fd4d9ac99812b332fe695740a6c028d9617f0aa503639f40972fe5e04c | killed |
| 254 | rt-0259 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | c5c2cd8fff23ddd473f4cf4b60f93816cb2b98e4df22e6cd70068c558f955715 | killed |
| 255 | rt-0259 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 8188964bb203edab91fbdbbbcb09695497a47bd363188bbd0b1986b2ee33c3fe | killed |
| 256 | rt-0260 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 3d3103bee44e4d6a1fb71b510cd370d8e1835344a3250f858ca485729fd11f1c | killed |
| 257 | rt-0260 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 897d564b1f5e4a6d7838aa2a27d6cae1c1aa26b2c39dcbf053f1336da639ef3a | killed |
| 258 | rt-0263 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | bf111ed58d26fe6a251484b8ae45f8473ce3a494d2e389776ec2571bf54374c4 | killed |
| 259 | rt-0263 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | f7e7e215ff7efe485021aecf0fe4af18e6f24f241bab6e8b9df337f301b60fa2 | killed |
| 260 | rt-0264 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 2a5518092179dc53943c50d82645260de6041ae737978191a54f406a69d3dd9a | killed |
| 261 | rt-0264 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | f396f2e148dd40c01ac48799013999a887e1867b9ad6781eb2ff2391628dc147 | killed |
| 262 | rt-0265 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | ddd01442d96f917d91a0e9940ff8d1dd7fd7abde92f1d9509c51155fa7ba3668 | killed |
| 263 | rt-0265 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/policy-state.ts | 1a2aaff2c6426c65e0862d421c568aba47c3325c8a9e643033bc45d0e42f941b | killed |
| 264 | rt-0266 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | cc8a187f173ecef54a3470e1a0002657954a44b632ef35626306e55ec4783741 | killed |
| 265 | rt-0266 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | cc7b94365e6ccb6bf3db3013b10e9f4be2fb3504103aefdf7f2674ef10c281e1 | killed |
| 266 | rt-0267 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 5a32fb9874aca5836da928100600d5891a2ac10ff6bac12afbb7177b8e86a612 | killed |
| 267 | rt-0267 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 8581042874cfbfa594b8731c63edc607ba564a655295ffa0f64b3ae9bb6666a6 | killed |
| 268 | rt-0268 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | d34ec822b27df5e4e715b47d411fd92ce06317b8bd4dadd7d0af5b33651edd90 | killed |
| 269 | rt-0268 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 714366325a5ec16e1be5408b6cc6c7f1001dec1f7c5afc4eccbc39a9c9062480 | killed |
| 270 | rt-0269 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 5a480e3248c335acbb083d9ec8edbb14b5c2fcf46bdeb66972db98399c0360bb | killed |
| 271 | rt-0269 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 7f03e7abb621ba9819326803265c7e9978fd07992e383f337a7bd4a66d0d6a37 | killed |
| 272 | rt-0270 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 6445a22f649766f56ce79dbdbdd75949f680c67da44c00268b232f9c5e726ed7 | killed |
| 273 | rt-0270 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/proposals.ts | 4ccb344949f6b4cf7b0c51e107ec9d92955e9e36661e574bd3e128e2f8ac79a3 | killed |
| 274 | rt-0271 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | f998a244eab1f7ed841d38afa455993decf42722bd80d153333713ce6d8e521e | killed |
| 275 | rt-0271 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | adc00ee8207c4ee3f6ed94f40d9c66a94733b5701d0b7cd2c87d7c207b16c224 | killed |
| 276 | rt-0273 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 435d69befb577d3b586b2d5e5e5970d01e7a0f8b0d13e2d7e20712a0d8057f28 | killed |
| 277 | rt-0273 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/apply.ts | 23866cad9414a21ad62177de986cd28ef20c5d6776c0ba7982785bd8016cf415 | killed |
| 278 | rt-0274 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | bbe42881c1e0416f8bab930d4fbc5f03c6c74238e3ea38f94ed07eeb0fffbaa2 | killed |
| 279 | rt-0274 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | ae42f61b09eccf9559b2ab51f6bf6dc86073f15d64711b739cc831d7540f9dbd | killed |
| 280 | rt-0275 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 22964c94a2c09caa660c44a1997842b059ec8a7e365cdc7e5510a6cf18563907 | killed |
| 281 | rt-0275 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 7a8e4104bbc5a919b34fd305f44012dcc283dbddeb75b1c547faa0c54c68cbb1 | killed |
| 282 | rt-0280 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | c32b577467124a99e6923f376b74bb997e1f3cc86ae322a2ea1633e7c961a33b | killed |
| 283 | rt-0280 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | e1e1fb1866905c65811d39cacec17a96cb59c6c7e35009ae5f2c21df27b2c52e | killed |
| 284 | rt-0281 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 309d13a010a8d1ae7ad87ae9eaecd8e32414ec3040d0816d8c6b674ed682587b | killed |
| 285 | rt-0281 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/reads.ts | 7354997513a7c4ded73ef882e8c4c83d180979c824c460cdd91ab22338d086b1 | killed |
| 286 | rt-0283 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | fcff0da86c802b86d9c94360fc801562a6add5f9bd3d82cb4c10c09bbc063e1d | killed |
| 287 | rt-0283 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 18de5f74176e0a1939f3587ec06db8a0a33bf2a0dfcdc2b5c613482e1bcdd933 | killed |
| 288 | rt-0285 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 17d619058b0018fcb1fc92d0270c1832cf9b8d2736940fac7e58b6f320e40e05 | killed |
| 289 | rt-0285 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | src/lib/agents/operator/restore.ts | 7fba60443f10df78780696626190ebe85f62840783c03319e8ba04785d9cf854 | killed |
| 290 | rt-0333 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 3cfd0b9e485227c906d0701fc596c53c6d56949e83b2eddb587b789e154d0bc1 | killed |
| 291 | rt-0333 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 6216e9781be9ba6c1fc3bcad2a0a8a944480d52dd8a92a064ecd33ed94e85fc2 | killed |
| 292 | rt-0335 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 243aa92a85de843d105e70b3788741005f05f345f26d8271588191fd942b809b | killed |
| 293 | rt-0335 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 3884f5ab46351e721db8e05b91a97d76317141dcb3eb9ff555b05be2711ca258 | killed |
| 294 | rt-0336 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 7cb4b3ef4fe33121d496c0dc3d6ddf70d3d87c4f5e665829786dec68add8af45 | killed |
| 295 | rt-0336 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | c66a66e8d1d4652606c99f1d1b7016bcff44fd81397ff7c53db16ae6f0897e24 | killed |
| 296 | rt-0337 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 86518112617e8fe0a26bcad3691063e671bf041b803e14b7a921db3fa8206527 | killed |
| 297 | rt-0337 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 8a789d40837cd39d5f346b66ea884633bd22935266208abf5770c7a8a6d3569a | killed |
| 298 | rt-0341 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | c9be2b8fe9155fa462c93f36f9cde5f0229c8720d015747e480f1ddcd8c3e078 | killed |
| 299 | rt-0341 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 2279bf35d942b79ef0838ed9b4a2912b3855f593e4a12b1c566456900fe85c5e | killed |
| 300 | rt-0344 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | b5fc0c7906703a61b2fb028a277e459351e25bb5c64cc8527c00065d1d3b3a96 | killed |
| 301 | rt-0344 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | eaa22e48c52981b18e0eff441b974f99bc08b79c7aaf71b7aa900c991a56f405 | killed |
| 302 | rt-0345 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | 3cbeb19ae52b696c34911dbbcc4a235e90b6e299c06a4ff454452e7b2f4230fc | killed |
| 303 | rt-0345 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | tests/llm-eval/structured-runner.ts | cab9fbb6b96455dfb20513d1eb67091beb3438bc8a071c71f4bba5644a6884fa | killed |
| 304 | rt-0507 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | b72b2e7c948805119dc8bea343578ed11b5475e2315ace1657de52b9430af2bc | not selected by root |
| 305 | rt-0507 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 692ea25dc07d29f8c705e2ae077665f9827a4b66d76752d60774b257247130be | not selected by root |
| 306 | rt-0508 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 29e760fc61318824ff04b3329b6466d4841fb9c6c227a8578f3a8a2b81a9f35c | not selected by root |
| 307 | rt-0508 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 5f6d431468a8bd0ad813bc94bea519f4f8d16d6eb19e2b5b3577af5260cb8aba | not selected by root |
| 308 | rt-0509 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 4b52806e8762744577b479826e7eb6d6274a6b545d50f99f41189fe4d9b86986 | not selected by root |
| 309 | rt-0509 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | e58db77ec13767595ba82b9162d0acdcd7692b6415d686b2e02882cbc8a120e7 | not selected by root |
| 310 | rt-0510 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | d01353c718809bb5d7e909a23a7dd3dea8f724ab603fff54ebc28a4d741b0e14 | not selected by root |
| 311 | rt-0510 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | a547762f0d97f5da5c07df1fe742f57fc712abf335dd69e9c9bf4b3aed673109 | not selected by root |
| 312 | rt-0511 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | c4676b388fc37a63a29878483b2653bcb622a2c12041e88b6954364ed1ea260e | not selected by root |
| 313 | rt-0511 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 8e4599e8f44f8e9a1f1ad8e8714c0be0946feab82b31664f6f628986d96e5181 | not selected by root |
| 314 | rt-0512 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 65df55d09f6b1779d6c8dd29a6ef99d07d4cda77d9591a080ea3f1d91cb7ae41 | not selected by root |
| 315 | rt-0512 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | ea66be7306244777013616341d725555d18d503866a90ce6f679e58609d28b63 | not selected by root |
| 316 | rt-0513 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 53ac8c3ce50059418bfe6009c243c366ed03966cca4c0bca59d07d14250457d4 | not selected by root |
| 317 | rt-0513 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 025a4576dc3de485e71d5053169efe42846d8a11863e19feaecec8ed8ede82d8 | not selected by root |
| 318 | rt-0514 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 70abfe5de60bf04705b3b0930b4c2f9ed733e45eaabac9d770d660d5dfedd35d | not selected by root |
| 319 | rt-0514 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 1f5113ea0e4f8eae377cf33b4004bd31b4b7ed07d3dfa898175a0a4401176546 | not selected by root |
| 320 | rt-0515 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/feature/scripts/red-team-status.mjs | a8ed5c91ecda23e1a443d36902921dd3c7b2f1e3c4fe305eac6732190f2f5db3 | not selected by root |
| 321 | rt-0515 | 1 | mutant | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/feature/scripts/red-team-status.mjs | 3cd724feccc5172efbe736ca6f0631e8d6b15cdfe4cce1eda3e756bd4dbbcafe | not selected by root |
| 322 | rt-0516 | 1 | baseline | e3bd968ae9fca8e0d787291cf067c266e67d89f9 | .agents/skills/red-team/scripts/mutation-runner.mjs | 2bc0dcd7d4999d3eb769198ea2d3375c5b9be7229991b9f7018c28e1e38e389a | not selected by root |
| 323 | rt-0103 | 1 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | src/app/api/operator/gate.ts | 0d2440ff926d88c080570af71dc9e8b18f3bdc43212456b2f149c4429bf11a77 | killed |
| 324 | rt-0103 | 1 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | src/app/api/operator/gate.ts | 3c973052d5d6e3bc286cab649cb5439da00b1701609c93e8b5aab149e2bd38e1 | killed |
| 325 | rt-0502 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 32c9205c2b37521b7ac3e88b8cb0f59b972ab78b5708a7724fa7aacf32995a2f | killed |
| 326 | rt-0502 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 4a418667aec7b44ccf22467150171827076ddcf2d724ff76cd2ad0f1ad841826 | killed |
| 327 | rt-0503 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | c2d5892031dfea4907d803db852662da82109cc184943422aae53788e7948bd8 | killed |
| 328 | rt-0503 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 3479939a9994a7dcd18eed25e55cd8db78e1e71dcfd5b0f0fb0e62418ddfdd4e | killed |
| 329 | rt-0504 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 96347a6f3788b000098d68b6005ca059a5a93bfc67516967f98c81eb159b5b2a | killed |
| 330 | rt-0504 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | ea9e7403c5bbd280204b35fae322635d4422445151fa60a8bf296b5bdbfcd9d9 | killed |
| 331 | rt-0505 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 7c602a5491ee67a9b8c9ab4a91811b08b6bacc15432394b10b963b5c7c9673bf | killed |
| 332 | rt-0505 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 26f959d093a8563d48218a891c526bf14ed89356bd8f279944e4550938a532d0 | killed |
| 333 | rt-0506 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 0a8a62902e10384fb75da702f1b26e19aa5504eaee9e99e80f28359a7a95add0 | killed |
| 334 | rt-0506 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 2f057d3b12f8117735c54aac19db2fd8a24c1c19096ebce8e7604c29c806a01c | killed |
| 335 | rt-0507 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | f6d77d9d0e1414cc3b5542a5fe716a3cf737de212ab5f2eeab9f59f1413f4cb5 | killed |
| 336 | rt-0507 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 0822166870aa59dbf1f586df97b365f91745d67e47e837c2eae67ac4847a4673 | killed |
| 337 | rt-0508 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 2b8b35cca25e68aa2e9cd474458c67924049a13b74a4fa2e72334f977fd773ba | killed |
| 338 | rt-0508 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 39bc9f84631fb2c2d5a846daeb7991bfd13a2af9a851327d0e9f2aa69f1f43f9 | killed |
| 339 | rt-0509 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 820649c444ef1e97db684f9e8745a070f9639c974fcd66e3107d3389077d5adb | killed |
| 340 | rt-0509 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 44a40c163d5aa337236269514c237d32bbea64621e28b1b4a960032c7fcd4388 | killed |
| 341 | rt-0510 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | e0b1b395c1ff223e6423adc6dc499825c78579466f4d4c661287cc7c218d6075 | killed |
| 342 | rt-0510 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 1749babd15684431509efea7e92430b98bc76336d6a36db228c53d7066c6070e | killed |
| 343 | rt-0511 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | a2876225413564bde7eb32c3431dcf9c639740040d217c09c6a19c4850639116 | killed |
| 344 | rt-0511 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 73e17a5f6aacaa8a3992da81041a4fd094db3c1397ab83ca5d35bed58b8683dc | killed |
| 345 | rt-0512 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | afd7cf9f9fc95cf350b22f674ded35ccf0327d2fdf5b08bd06dc24c4bd6d3100 | killed |
| 346 | rt-0512 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 6bc11ab877ac49830d2d239feea84098e941a1af3c7e76840663f402e760acae | killed |
| 347 | rt-0513 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 17863eb6448500d3886750fe641f039014b1586cbe98be5ddcf1a8085e2b253f | killed |
| 348 | rt-0513 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 125de38c7ae3a0825c0ba42916e1d6e2bda3c8f89536bf3b56173335521b0f9b | killed |
| 349 | rt-0514 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 981aad055dd1b26254157f714ea1fdf449b9e01470b9689f03e02f4c8e542958 | killed |
| 350 | rt-0514 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 21f842ce2977a061fcd662d83386bafe3ab23d4f67fc61f4daa1467bf82f9794 | killed |
| 351 | rt-0515 | 2 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/feature/scripts/red-team-status.mjs | da5cdfd7f23f53491bda735d0ce4184728274bda7bfb991669940adda5eeade6 | killed |
| 352 | rt-0515 | 2 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/feature/scripts/red-team-status.mjs | b495220374e0dcbb09620b4092535179fe16606334a63b86222bf73af544f10e | killed |
| 353 | rt-0516 | 1 | baseline | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | 26d441e980613b145cca2272027463a5b968be972664aa8032fd6bebf79a5ebd | killed |
| 354 | rt-0516 | 1 | mutant | b1fe8af88e84167318e7ba3a662e0be1539560c4 | .agents/skills/red-team/scripts/mutation-runner.mjs | d6c496053dcdb4af3c072a37f5b199ed04eaba3f973522d55a5185002c19b5ee | killed |

### Selected artifact bindings

The following retained paths and digests bind each explicit root decision to its source, mutant, and exact execution pair. The first six continuation pairs retain their original inconclusive suggestions under the file-accounting controller. The separate selection correction preserves the original two-test rt-0103 baseline and records rt-0144 reevaluation. The failed rt-0516 baseline is retained separately from any later baseline sharing its first semantic-attempt number.

```json
[
  {
    "candidateId": "rt-0005",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/measurement.json",
    "measurementSha256": "f6f8102b620e6bf4f2f212ea408eb083c72f54c8f4c13efcb2639ce67f1a8173",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The changed completion-refresh callback must clear the active turn when the poll becomes completed. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:203:67). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.124Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "88eba3f0e76581bfdf86754cef9d27c62d4794fc1af679fd45c949cfb0cc90f2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 63,
        "resultPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/baseline.json",
        "resultSha256": "70911a87a97836ffb5e9a3ebe63138f6f2fe467bca4fbf7883e85aac3eac54ce",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/baseline.json.supervisor.json",
        "supervisorSha256": "96b6818e28cc7af4a1cd68d818f3523733fb51a8679a7c9a0b08b127ab7c9708"
      },
      {
        "phase": "mutant",
        "launch": 64,
        "resultPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/mutant.json",
        "resultSha256": "2cddc184cf1c7b548fb4680bde994e1b5586db0cd59ea8793a1e569de58583ce",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/mutant.json.supervisor.json",
        "supervisorSha256": "af1b66bbb44b0ca51822114202190905b2d87d4ca621ba988e056e4edf29693f"
      }
    ]
  },
  {
    "candidateId": "rt-0006",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/measurement.json",
    "measurementSha256": "ad30d126f38360286e8f12c82b1c488f0da3df4f01f2cf076ba661c0b330bcde",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted completion callback is a dependency of useTurnPoll's effect. Losing its memoization restarts the poll after the timeout state renders, so the four-minute stop is no longer durable. This measures callback identity in the changed hook, not a mutation of unchanged cadence constants. Observed: AssertionError: expected 75 to be 60 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:236:34). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.128Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "phases": [
      {
        "phase": "baseline",
        "launch": 65,
        "resultPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/baseline.json",
        "resultSha256": "f7159ea43924cc4ae5eddce3facb6e44043e25cfaacfd6c41d212f16c5ef4a96",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/baseline.json.supervisor.json",
        "supervisorSha256": "bdc8ad0e9e1ff1a69f911623491317ed5bab202fbf4afe541f914fee3951df48"
      },
      {
        "phase": "mutant",
        "launch": 66,
        "resultPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/mutant.json",
        "resultSha256": "74fba04ed57734920831a64e5108970be4c3c00c0536fef5872a83228b02a368",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/mutant.json.supervisor.json",
        "supervisorSha256": "e37cdde428d85c1b827dacde7f154b97987d1eeb22f765cea2fef81f3bf2dfba"
      }
    ]
  },
  {
    "candidateId": "rt-0007",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/measurement.json",
    "measurementSha256": "867ff439d87eb38961fbeb49ba6cc342e9a157e8aa4a620a3f0f07b5b03d708b",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The conversation GET resolves EMPTY_CONVERSATION and commits a new view, causing a screen rerender. A newly allocated completion callback changes useTurnPoll dependencies, aborts the first unresolved request, and starts a second. This measures the extracted callback's required stable identity while a request is unresolved. Observed: AssertionError: expected 2 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:269:63). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.132Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "phases": [
      {
        "phase": "baseline",
        "launch": 67,
        "resultPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/baseline.json",
        "resultSha256": "710f6115b9743f1be5b290d22d27ddcd75302c244a1f005cf9d5fa2118923c64",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/baseline.json.supervisor.json",
        "supervisorSha256": "9e02fc060801c071f46badbfbd34cab3bd86191b221ae76f09c57bb89575db63"
      },
      {
        "phase": "mutant",
        "launch": 68,
        "resultPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/mutant.json",
        "resultSha256": "84d1097e41dd19372ead98663bcda3340ce579945dc2d0cbe7e0978b28c302ef",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/mutant.json.supervisor.json",
        "supervisorSha256": "cb09c13be56a0e04cafd02d046e87870a5e4fc42d2b882a2504ed773d6bb486a"
      }
    ]
  },
  {
    "candidateId": "rt-0009",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0009-45207U/measurement.json",
    "measurementSha256": "6116236c040ca2cd03299d46c0c73704c23affd6e1cda6d13e0f7b0c862d945f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The operator_disabled response runs the extracted screen-state callback; keeping disabled false prevents the terminal screen state. Observed: Error: Unable to find an element with the text: /not available right now/i. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:330:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.142Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "fc44b7818ebc025c4cfe7ea594830cbf90491683880d06322b1b2765b212077a",
    "phases": [
      {
        "phase": "baseline",
        "launch": 69,
        "resultPath": "/private/tmp/operator-continuation-rt-0009-45207U/baseline.json",
        "resultSha256": "3ebcdbf16e2c57d041594ba27e2f099570d4c4de0705646c3dc6c909ac853119",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0009-45207U/baseline.json.supervisor.json",
        "supervisorSha256": "fbf082e3b093f396fd695d94cf44d8390b36e976ea8208c1d9b1648141bf2f9c"
      },
      {
        "phase": "mutant",
        "launch": 70,
        "resultPath": "/private/tmp/operator-continuation-rt-0009-45207U/mutant.json",
        "resultSha256": "8b0e89d5d38bfc902875c6663fa189206b28f713a833a44dc195cf06dc0f9eb9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0009-45207U/mutant.json.supervisor.json",
        "supervisorSha256": "5d6d2f8101dea92d0189c0e95e8d65b4a2ed38594c31bad79a62368f87841c0c"
      }
    ]
  },
  {
    "candidateId": "rt-0010",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/measurement.json",
    "measurementSha256": "0a6b1db438abb33257d5b47ff4d36a03f3efb1a86385646887f66a100ea9321a",
    "verdict": "killed",
    "reason": "Forcing composerBlocked false left the message textbox enabled under All locations; the existing toBeDisabled assertion at OperatorClient.test.tsx:347 failed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.342Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2a0dcbeb98b119d2632512e865dbe1b042c0fb828163d7f1fe257d5d330d2852",
    "phases": [
      {
        "phase": "baseline",
        "launch": 33,
        "resultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/baseline.json",
        "resultSha256": "bf65939deb3b1edc8827af398c430205c54559b8a2bafbcfba4c7172f2de1cd4",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/baseline.json.supervisor.json",
        "supervisorSha256": "7b198e181dcf16615d281addeedbe183dd56240ebf05982f9c169a33bd0389be"
      },
      {
        "phase": "mutant",
        "launch": 34,
        "resultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/mutant.json",
        "resultSha256": "7a02132b6055cf32360e0eb073aad4399d20a849471323abb46f90ed0c84f6cf",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/mutant.json.supervisor.json",
        "supervisorSha256": "49dc15544e9bcb97516ddf1bbfb335047bba05dfa41a472d6e6c043414af2f42"
      }
    ]
  },
  {
    "candidateId": "rt-0011",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/measurement.json",
    "measurementSha256": "358da7a1a8f76e3900c1442979b4c6ee9e11bb993e27aa9b8553e246a2244322",
    "verdict": "killed",
    "reason": "Removing the recovery notice suppressed the Try again action after the lost POST response; the pinned existing query at OperatorClient.test.tsx:390 failed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.342Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "phases": [
      {
        "phase": "baseline",
        "launch": 35,
        "resultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/baseline.json",
        "resultSha256": "090b2a2bf2961dd4ceae530db188ffe42c1ab032bc03c41cdef544a1ef250004",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/baseline.json.supervisor.json",
        "supervisorSha256": "160bca276a28a5f03efa5a895f8ec180d41fb37b7be3abbc4e857acd3dfef6cf"
      },
      {
        "phase": "mutant",
        "launch": 36,
        "resultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/mutant.json",
        "resultSha256": "5f0fa9b1b25bf9f566f6a4dce251cafe25a078dba407303059c3015cbf4eb37c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/mutant.json.supervisor.json",
        "supervisorSha256": "26ac3c0f44aa19cced086e0c98677cadf08cc6f86ed55bacf97c7ce2e592e92c"
      }
    ]
  },
  {
    "candidateId": "rt-0012",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/measurement.json",
    "measurementSha256": "9eca53750fc6cdeb61a5031c7473ce6dbed7dd91ad0f59756600604832b856b0",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The lost-response branch stores a fallback notice through the extracted screen-state setter. SubmissionNotice returns null when its notice prop is null, including the retry affordance. Suppressing only the exported notice preserves submission, abort and canRetry state but hides the recovery action. Observed: Error: Unable to find role=\"button\" and name \"Try again\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:459:38). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.151Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "phases": [
      {
        "phase": "baseline",
        "launch": 71,
        "resultPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/baseline.json",
        "resultSha256": "a4f902a3c152ab2ca71ae714baca014ebe724f1241ca518a3157b276c03d5c84",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/baseline.json.supervisor.json",
        "supervisorSha256": "0d8829f409e41a6ce0efed849cc74f2e254eaf3788a2aec05ff588be0948103c"
      },
      {
        "phase": "mutant",
        "launch": 72,
        "resultPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/mutant.json",
        "resultSha256": "4502b5df59a00a6bb61a247704d0469c49b21e2a78c0cb5c7caef434433440dd",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/mutant.json.supervisor.json",
        "supervisorSha256": "17dd74c69971114e9f31dd082049970a853be31d9df172963aa09869c741f513"
      }
    ]
  },
  {
    "candidateId": "rt-0013",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/measurement.json",
    "measurementSha256": "c61a06cc1c4a383a08e02633752852359f008c955e44046aff6be221f879f8fd",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted screen-state return must expose the notice set by a refused POST; suppressing it loses the server-refusal explanation. Observed: Error: Unable to find an element with the text: Your account can no longer make this change. Nothing was applied.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:489:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.160Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "phases": [
      {
        "phase": "baseline",
        "launch": 73,
        "resultPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/baseline.json",
        "resultSha256": "2db26f85ff49f163b6064bb4f71b5be2901756e16085f37f65e1afeabb3b1b5c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/baseline.json.supervisor.json",
        "supervisorSha256": "c5953b73d3d04b6bdace57ec697ab4971b59c3518969d3e5b9968e258257f6f6"
      },
      {
        "phase": "mutant",
        "launch": 74,
        "resultPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/mutant.json",
        "resultSha256": "7d87feb7b5a0c7324bcb2ac4743bac2758ad07ffa5eca15cd89c94d37b85b47a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/mutant.json.supervisor.json",
        "supervisorSha256": "fcc892a8078fb9be22898a83e89a137da4938fcfd2b80eac653f4d4d75eb920e"
      }
    ]
  },
  {
    "candidateId": "rt-0014",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/measurement.json",
    "measurementSha256": "8cc65e413adff7751d4bd3068024ca93a2dd23ad33db607d41b8a40ba00f3343",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The referenced ordinary card must be placed inline; returning null leaves it unplaced and the existing append fallback puts it after the question. Observed: AssertionError: expected 6 to be less than 5 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:586:20). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.164Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "1a25a5f250b2c224be8c18a4172fce0ad3c9195d914a10e71dd74d4bab260dae",
    "phases": [
      {
        "phase": "baseline",
        "launch": 75,
        "resultPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/baseline.json",
        "resultSha256": "cfe45d79e68239957d11a336e60167578383d75c01c386f321b8d83190717846",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/baseline.json.supervisor.json",
        "supervisorSha256": "a777209ce6cae35974474fb7e112708be82aecb7b8c158d73805952ca4226138"
      },
      {
        "phase": "mutant",
        "launch": 76,
        "resultPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/mutant.json",
        "resultSha256": "f328c8d621477bbb70feb393d5a3a73296779e2c827178fcd27b1e9e8b657113",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/mutant.json.supervisor.json",
        "supervisorSha256": "e0cb1a4d8b543e91717e695a88f7aac0c93ad2de77cae53a4d8446876de93c03"
      }
    ]
  },
  {
    "candidateId": "rt-0015",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/measurement.json",
    "measurementSha256": "d5e0750ece51483db9467ad00cb3f98883c2e0db295d14e77ad4f7daa2d174d1",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The changed response decoder must adopt a stored proposal from a refused response. Discarding only error rows preserves fetch and error wording. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:644:73). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.167Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 77,
        "resultPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/baseline.json",
        "resultSha256": "a9e07fbe193c5e3683cd2a47e001106d1451cf41d1a46b7b77fc625c0e2061cf",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/baseline.json.supervisor.json",
        "supervisorSha256": "0885b45291cf366d78e23d4c34b8c4418d6b9296940a075fe16e11d2331f1586"
      },
      {
        "phase": "mutant",
        "launch": 78,
        "resultPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/mutant.json",
        "resultSha256": "54f5f08cc065fbac2341a9ed70af638160460633d636623f9c7b4a5e6b6e1ed9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/mutant.json.supervisor.json",
        "supervisorSha256": "50f75b3f466e26767b35f7202e98fa3c027a54563637137dbe06b79486553ceb"
      }
    ]
  },
  {
    "candidateId": "rt-0016",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/measurement.json",
    "measurementSha256": "05de2d90dcbbb3b9335266325a57185ee16b6bb32c6419cfa866356d1b4486f7",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted timeline-refresh hook must invoke finishTurn on terminal poll status. Miswiring it to the same-signature startFresh command resets the durable transcript instead of retaining previous turns. The fixture's second submission polls completed, so this branch is reached after the earlier failure/capability assertions pass. Observed: TestingLibraryElementError: Unable to find an element with the text: We tried several times and could not finish this message. Nothing was changed. Start a new conversation to try again.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:697:19). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.175Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "9670b21a4e5ee3d5e8f296675fe2ef7efcdb21ec19e99342316416f67e75e996",
    "phases": [
      {
        "phase": "baseline",
        "launch": 79,
        "resultPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/baseline.json",
        "resultSha256": "2baaf72556f2d18a928a8d85129712e449f57cf61507d7a79f7c57220cc59257",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/baseline.json.supervisor.json",
        "supervisorSha256": "fd3ed84ba769867d048823713f3d10d4b14239843d11669291ba5ca2209f478f"
      },
      {
        "phase": "mutant",
        "launch": 80,
        "resultPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/mutant.json",
        "resultSha256": "35372b5cb8a59073385ffdf9090211576b21185eba84610b91eceb0dca419970",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/mutant.json.supervisor.json",
        "supervisorSha256": "18aa6e77657e89e2be465a5f4269f0e262ee87a6221438536750a76b08673c33"
      }
    ]
  },
  {
    "candidateId": "rt-0017",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/measurement.json",
    "measurementSha256": "08e1cc28093924ce0a0559b332d5d59f74cda65bebe64c1c3bdbf5200fe32682",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted unfinished-turn helper must resume RUNNING turns loaded from durable conversation state. Both candidates use a running latest turn. Observed: Error: Unable to find an element with the text: Preparing your plan. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible. (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:722:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:25:06.183Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "phases": [
      {
        "phase": "baseline",
        "launch": 81,
        "resultPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/baseline.json",
        "resultSha256": "28c98a4a811dd34160aba8b6ce29969a8a319a01a67b4925573ee92600e8d771",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/baseline.json.supervisor.json",
        "supervisorSha256": "b1e5f5bea6f67736daccd7e23421e725a40f99bb0d11469a7f494898e174b929"
      },
      {
        "phase": "mutant",
        "launch": 82,
        "resultPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/mutant.json",
        "resultSha256": "35cc0617e10bdd3f6f9423f41cf5fd09220b7d263dcacc70b315f9d7d797d59a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/mutant.json.supervisor.json",
        "supervisorSha256": "d844f7bfe7b889d8f80a97c2a37717452b20b9ec37c5780c7258f0f0a968da15"
      }
    ]
  },
  {
    "candidateId": "rt-0020",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/measurement.json",
    "measurementSha256": "e88bdaa1f66ffeb67f19f5084729e0952930c5f2d67b22de5d1bb46a51075198",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted unfinished-turn helper must resume RUNNING turns loaded from durable conversation state. Both candidates use a running latest turn. Observed: AssertionError: expected 0 to be greater than 0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:959:45). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.383Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "phases": [
      {
        "phase": "baseline",
        "launch": 83,
        "resultPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/baseline.json",
        "resultSha256": "3dc8aaeaf03a9a1e3dfca963c4da74fbb87866f3b8158f913ce77113414387e1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/baseline.json.supervisor.json",
        "supervisorSha256": "7e2a33b55853b79736e38336df5db851e300e4b8d5f4cefa228772805543cc47"
      },
      {
        "phase": "mutant",
        "launch": 84,
        "resultPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/mutant.json",
        "resultSha256": "0d566421c1c8d12721aa8865b8b9ac37607610abae362fe2e8321d22407fdd0e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/mutant.json.supervisor.json",
        "supervisorSha256": "0998d9840fd22badb10e81e1e46231eb75b8d64f06ab042af140be7cd2681063"
      }
    ]
  },
  {
    "candidateId": "rt-0022",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/measurement.json",
    "measurementSha256": "92d27270c127aebdbe9af296ac0fabe60b48e64a6b10a2ac7acd0b27536318a4",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Conflating composerBlocked with disabled hides Refresh plan under All locations, although only composing should be blocked. Observed: Error: Unable to find role=\"button\" and name \"Refresh plan\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx:1097:33). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.394Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "0d0c893cd91ab3e1fff5bc8d7552b44033dce3deb074f10dbe3ccb20a89e178c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 85,
        "resultPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/baseline.json",
        "resultSha256": "8d264ef1907debfbfc66740048e1fbeeb45b2fc2dfc7c95ec1445de26a6d04d7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/baseline.json.supervisor.json",
        "supervisorSha256": "b233694ff7bd69df98e98932f482836fa1a2803d22fe57467799b3db534b0762"
      },
      {
        "phase": "mutant",
        "launch": 86,
        "resultPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/mutant.json",
        "resultSha256": "8bcdd409bff5abff2907f13fd4265d56dbe61f91dd46b8cb1f7c0bd174130cac",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/mutant.json.supervisor.json",
        "supervisorSha256": "2521f61cbaa151a50fa6b4fd13c9dd63babab7d593c9853c6bf14e471ca66b75"
      }
    ]
  },
  {
    "candidateId": "rt-0030",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/measurement.json",
    "measurementSha256": "d43249b152da3b15339de096251a65cbe8e7776fdf81efb44e4d734f28901205",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: A referenced expansion must defer to the expansion group, retaining relative ordering and deduplication. Observed: AssertionError: expected [ Array(1) ] to have a length of 2 but got 1 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:248:81). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.397Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "c74b40d44fca72f45c279021f00e4b2564049c9d66fdfea2ea497f95b9f9007a",
    "phases": [
      {
        "phase": "baseline",
        "launch": 87,
        "resultPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/baseline.json",
        "resultSha256": "88dd7d0a3de70546587b12402b40502cbfbed4c7a536284cabec569d6c05d842",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/baseline.json.supervisor.json",
        "supervisorSha256": "7430e98fd2099bd5902121f1274343577bce33d58c83c39ac80a0d6191966190"
      },
      {
        "phase": "mutant",
        "launch": 88,
        "resultPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/mutant.json",
        "resultSha256": "68e1fd174a6d70db8f328600934d1e7d9f396fd2fe1e450be641072fde2d6213",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/mutant.json.supervisor.json",
        "supervisorSha256": "055886b0d627097e5dfa9301373845b08dd7684e131fa731d20e92ca8539ca87"
      }
    ]
  },
  {
    "candidateId": "rt-0035",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/measurement.json",
    "measurementSha256": "c5c5153183b26050b97a2d8b7b2febeeaa8affb330b333f41310e825b5fc0f4d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted panel state must initially show the persisted conversation on each mount; starting on timeline hides the refusal after reload. Observed: Error: Unable to find role=\"group\" and name \"Policy refused\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:81:36). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.406Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2ba3dcac4aab92e8fb59893a5f7d2bd82fe3d9e7465a01636a11f4043990a60c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 89,
        "resultPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/baseline.json",
        "resultSha256": "df75a5c7b691f9a3806ed9a11207bb66608c225944d10f4b6e92420a2e98cbe9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/baseline.json.supervisor.json",
        "supervisorSha256": "ad7c41470d9709a3f9057e0d9e0b140e7961ee96a164a18f07bcc853a38da049"
      },
      {
        "phase": "mutant",
        "launch": 90,
        "resultPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/mutant.json",
        "resultSha256": "d59bc8cf69043da146fdfbaa3d33af18df5bdae8bdbdf1807ebde33960b811e1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/mutant.json.supervisor.json",
        "supervisorSha256": "14be4150f4b012907dd61463e736648f6457a38fcc22fe8dcea3079a89f4958d"
      }
    ]
  },
  {
    "candidateId": "rt-0036",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0036-dYi301/measurement.json",
    "measurementSha256": "58d5652f557b61b8718af2e1c2228e1d39c88c640f3f2051caa9ff7d1e24fd4f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Restored pending proposals use the ordinary Apply request and must retain their prepared token; fetch fixture accepts the URL, so this fails the explicit payload assertion. Observed: AssertionError: expected { expectedVersionToken: null } to deeply equal { expectedVersionToken: { …(2) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:119:53). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.409Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 91,
        "resultPath": "/private/tmp/operator-continuation-rt-0036-dYi301/baseline.json",
        "resultSha256": "2cc9ee15e934cfaf6cbb78c2dfac5123dcd3351f86fdfa552cbab4cd5032ffe7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0036-dYi301/baseline.json.supervisor.json",
        "supervisorSha256": "4845a6ae9da030b9b92edba9db2ce1f65a27edd8a0f0d33791039e1daf9db9b4"
      },
      {
        "phase": "mutant",
        "launch": 92,
        "resultPath": "/private/tmp/operator-continuation-rt-0036-dYi301/mutant.json",
        "resultSha256": "f68354970c646c71a4f5729d994183914e800505ae525a83bb3616e4396970c7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0036-dYi301/mutant.json.supervisor.json",
        "supervisorSha256": "20c6e05bc794822e2473b2a8172dc9b1165b764235bd941304b0f71f57b5149d"
      }
    ]
  },
  {
    "candidateId": "rt-0037",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/measurement.json",
    "measurementSha256": "e05458df89ade9dee82a3b288be69c55b097d0d37a53fe805e9f085bbdbb98b8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Both timeline variants must adopt the rejected Apply row to replace pending Apply with enabled Refresh plan. Ignoring only error rows leaves Apply visible. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:152:65). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.412Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 93,
        "resultPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/baseline.json",
        "resultSha256": "fb356baf62b8e5cc07e9a800f4100cb798232096b0c949890f780cacb0dbb45c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/baseline.json.supervisor.json",
        "supervisorSha256": "13fbdefbf9cc7acba653c1d39dcfdf3fa36c1237b137a1a88a9f0fea6e67fa08"
      },
      {
        "phase": "mutant",
        "launch": 94,
        "resultPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/mutant.json",
        "resultSha256": "a2d57e759699c16cbfbce287c032640774e6a8e72fbc41cce58d5725c97b4ccc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/mutant.json.supervisor.json",
        "supervisorSha256": "9a67bd40cc0bb526b0c43072f3e1ea5ab1428508302f5b9218e2933381d4a0a8"
      }
    ]
  },
  {
    "candidateId": "rt-0038",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/measurement.json",
    "measurementSha256": "89dac8c9e105602b8cd1b01cdff3161ba7224e23e293a00f59ef1fdd5b82beac",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Both timeline variants must adopt the rejected Apply row to replace pending Apply with enabled Refresh plan. Ignoring only error rows leaves Apply visible. Observed: Error: expect(element).not.toBeInTheDocument() (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:152:65). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.415Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 95,
        "resultPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/baseline.json",
        "resultSha256": "60976e4b3dd91357aba38fe388649d67ae83898c52c75162efc282a93deb98e1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/baseline.json.supervisor.json",
        "supervisorSha256": "6fbc3ff8c3c90c9bdbb088deb53724e5548529ca5fe7a1b3e121b2b135aa0ad4"
      },
      {
        "phase": "mutant",
        "launch": 96,
        "resultPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/mutant.json",
        "resultSha256": "b6ab03aceb6e8b4adc0aa0f2c0388aef3c455ae8b8cfb35ebef8d57a67db59bc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/mutant.json.supervisor.json",
        "supervisorSha256": "52b6a683583ba1c63d5a825efe7fbe6563e21dc2c9039e54fc2d5c8de9bace4a"
      }
    ]
  },
  {
    "candidateId": "rt-0039",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/measurement.json",
    "measurementSha256": "b5552b4e068e99542365b63d13a7fc62dc704c14b4aed2f6f24c2c68ab5d2f01",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted Restore action must invoke preparation for a receipt outside the transcript window; removing dispatch leaves timeline without pending restore. Observed: Error: Unable to find role=\"button\" and name \"Apply\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:175:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.424Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "bac4f0615c272ef3ad934026fc372aedf08d1283b502b87acbe22e5aaaa74905",
    "phases": [
      {
        "phase": "baseline",
        "launch": 97,
        "resultPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/baseline.json",
        "resultSha256": "0264911aefe0e748b9abccc54d6a46a09c4f80bb98e8a0f2576f4fd5f95a9109",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/baseline.json.supervisor.json",
        "supervisorSha256": "270c286281926bfa7d40f425ba113b02b532b44dd3caf85f6b29fe68602ca5f0"
      },
      {
        "phase": "mutant",
        "launch": 98,
        "resultPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/mutant.json",
        "resultSha256": "9418e187ab2b375cf95ebe82924276f203f9f0fd6b0db0844fb1eca921068210",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/mutant.json.supervisor.json",
        "supervisorSha256": "9a33851444829d5bff255bb65eef6a4092eb73fb2eed38fbbc670c2baa8d6a23"
      }
    ]
  },
  {
    "candidateId": "rt-0040",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/measurement.json",
    "measurementSha256": "5e723ba30d3fcf6324c38b4bd32f69fbb90ec4008a043ab4911cafa36adaa9a7",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Mutate selected-location projection consumed by RulesTimeline while retaining normal rendering and pagination. Observed: AssertionError: expected 'all' to be 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:204:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.427Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7abd2dcfa98e6985dcf68efde0763762013efe3e6c0abbded4fe88c0666f8c6e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 99,
        "resultPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/baseline.json",
        "resultSha256": "6a8a851413eb6cdb05a9d7a47305cd6c64a78e4ac0b50be22e60a63ab593c6d6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/baseline.json.supervisor.json",
        "supervisorSha256": "14dacbbbd262cb5a7d5f189a7e2f80e2b20bb7a6252f7c27b146feac6f9864c0"
      },
      {
        "phase": "mutant",
        "launch": 100,
        "resultPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/mutant.json",
        "resultSha256": "0c5300eb102c2cd1deaa71b4f4318d25d4c707bc8b308086e7d7cfd597675399",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/mutant.json.supervisor.json",
        "supervisorSha256": "8fa91668ab0ad255a31f802a51ecff2ce892cc188ac97d30ee2c46b79b034429"
      }
    ]
  },
  {
    "candidateId": "rt-0041",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/measurement.json",
    "measurementSha256": "56ccc3ee123c13f92c91c9e5b4b730cd5040c59b497411604a2b7d8c9484ee97",
    "verdict": "killed",
    "reason": "Removing the busy disabled state left the Preparing restore control enabled; the existing toBeDisabled assertion at RestoreWorkflow.test.tsx:217 failed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.342Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "36986d07441fcc05bcf0eb0a6cf2e39044d82a3599ef389f923157e427f0425c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 37,
        "resultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/baseline.json",
        "resultSha256": "16568726640ea4a9d146b7535be3a43d3f8bb4bc7ab670da03c2fbe4e5374d50",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/baseline.json.supervisor.json",
        "supervisorSha256": "de717aaa395343afc0e9111099ab4f5697b2241ff1a1d8d73d3e305c367017b1"
      },
      {
        "phase": "mutant",
        "launch": 38,
        "resultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/mutant.json",
        "resultSha256": "a1640a9e104ca51275308f4f86c1072477ad3e26d65188f1ca7a7bf12e64dbe6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/mutant.json.supervisor.json",
        "supervisorSha256": "d82f1bcdc2b68b0c1ee55411c4d317ef84683c5b6521fc37629e41c4978a3395"
      }
    ]
  },
  {
    "candidateId": "rt-0044",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/measurement.json",
    "measurementSha256": "b2d34a1f8a2e48e1d7951149b801110c74e90cbb47b20ac3b086222958cab10e",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Initial selected-location request stays unchanged. Switching to All locations incorrectly keeps the first roster location, so the timeline receives no scope change and never loads current all-scope history. Observed: Error: Unable to find role=\"heading\" and name \"Current scope history\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:266:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:11.436Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "31f157b11041735feeec5165a4f2ebf75c8fa7130478655f5f0ca3b74179db89",
    "phases": [
      {
        "phase": "baseline",
        "launch": 101,
        "resultPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/baseline.json",
        "resultSha256": "3734e47433de6ea444ac4df590dac10778e74f503e0f8bd4df19a12e7d39e3f9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/baseline.json.supervisor.json",
        "supervisorSha256": "cce2a01eb8e9892a5265fd7f0889dadc00c5557afab95c346de8c0f6ed7c8ce4"
      },
      {
        "phase": "mutant",
        "launch": 102,
        "resultPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/mutant.json",
        "resultSha256": "6f96e5cdcf041da4917fe97b0926afa8ff929d2b8830d384299dcd8b7bf9cc14",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/mutant.json.supervisor.json",
        "supervisorSha256": "a635f6b0752c8e1b3ce558f49cce3eae3420d7070a6ac7abc48a209f2dde04c0"
      }
    ]
  },
  {
    "candidateId": "rt-0045",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/measurement.json",
    "measurementSha256": "e19d2c609dd850390775268cb5fe7291e0cf12b0f3309497fb27972f8be6b696",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The extracted state hook must expose a working panel setter. This candidate explicitly clicks Rules timeline before reading the failure. Dropping only that exported transition prevents entering the requested panel. This is evidence for changed panel-transition wiring, not a mutation of the unchanged timeline retry/error implementation. Observed: Error: Unable to find role=\"alert\" (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:283:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:47.076Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "c5c4045ef07a3bb912bb4f993618893bc80722527ab467bb5d1c70322fa99b34",
    "phases": [
      {
        "phase": "baseline",
        "launch": 103,
        "resultPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/baseline.json",
        "resultSha256": "19d4724616d31fdc1f98b945b05d221195fa5337423287bf39d8500e94b866f0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/baseline.json.supervisor.json",
        "supervisorSha256": "2db7624b42a4b945f0be53a5ab877283d70a161481a7d009fd23d292993e4df9"
      },
      {
        "phase": "mutant",
        "launch": 104,
        "resultPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/mutant.json",
        "resultSha256": "b98b52126ca43eee255f1cc7008eb7cd32509a675510b251f961a8650410ada2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/mutant.json.supervisor.json",
        "supervisorSha256": "f23fce71c30632607208820ef203799c349f512678cfdd0d089d412be6eadcd5"
      }
    ]
  },
  {
    "candidateId": "rt-0056",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/measurement.json",
    "measurementSha256": "e0015538fb3dfa6255c637449a430b69174ab1f16b387349d4f72d8a224a2858",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Exact typed scope must be sent unchanged; this test supplies a trailing space specifically to detect normalization. Observed: AssertionError: expected { Object (expectedVersionToken, confirmationLevel) } to deeply equal { Object (expectedVersionToken, confirmationLevel) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:78:44). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:47.080Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "a534f2cabff2cb66a4129bc380526d614564e66f01535e49e01c5de44a2b0c03",
    "phases": [
      {
        "phase": "baseline",
        "launch": 105,
        "resultPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/baseline.json",
        "resultSha256": "c2a22a44e33fb2505e093a3b4adf3e024ed329ebd14786be28a0c41dca0c8d40",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/baseline.json.supervisor.json",
        "supervisorSha256": "7abe198d8f32e50931d77d1d1f5bcee1826693512e58d39bf8b2f80d63b51bfd"
      },
      {
        "phase": "mutant",
        "launch": 106,
        "resultPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/mutant.json",
        "resultSha256": "47ca20f6e8a3308a83c24edb7087940913f6e1b1d39dd24b102be71515a2c298",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/mutant.json.supervisor.json",
        "supervisorSha256": "4174b0bda01df943a92e73a4c27f4be2fa4db593eb8a1931a100974db93d0047"
      }
    ]
  },
  {
    "candidateId": "rt-0057",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/measurement.json",
    "measurementSha256": "2698199d92bf327918351b460af2e04b0ee8541cc675e88bd4c72124f84d623b",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Apply must send the version of the card being decided. Mock fetch resolves normally regardless of body. Observed: AssertionError: expected { expectedVersionToken: null } to deeply equal { expectedVersionToken: { …(2) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:97:26). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:47.083Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 107,
        "resultPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/baseline.json",
        "resultSha256": "20f29244e082b6381b9a7ba44c31cb1005444f4788730ae63da6392c54bc71f0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/baseline.json.supervisor.json",
        "supervisorSha256": "9c812f9e186ae6704177653a3a37843201c1003dce08c520174bc9d1a07c7857"
      },
      {
        "phase": "mutant",
        "launch": 108,
        "resultPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/mutant.json",
        "resultSha256": "c958c1a2251fb5aa1cfa8670508a1e333ca2aab56f7130255296940cf629d9fc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/mutant.json.supervisor.json",
        "supervisorSha256": "c2214751120ebc79cc1a2ea5c305b0d5d19f3d5ec8677fe22b467b864c5d7fe4"
      }
    ]
  },
  {
    "candidateId": "rt-0058",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/measurement.json",
    "measurementSha256": "cf95b8ec015c1414e0eaf64a651c289d0f8ff4ece52bb8a7bb71ed918660b8d8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Decline intentionally sends no body; the extracted request builder must preserve undefined rather than serialize an empty object. Observed: AssertionError: expected {} to be undefined (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:119:26). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:26:47.086Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "c4343bdd40b42972e8816c631504a332db4e95aa5cb8e394c47b47525f5b36b4",
    "phases": [
      {
        "phase": "baseline",
        "launch": 109,
        "resultPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/baseline.json",
        "resultSha256": "35970c2caf6821c5ad062bb466d61e86abed5458eac30fe023ebafaceeddad38",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/baseline.json.supervisor.json",
        "supervisorSha256": "888f24165b8fb858d163405844a31b029796d5b28336a77a7609880a50f37905"
      },
      {
        "phase": "mutant",
        "launch": 110,
        "resultPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/mutant.json",
        "resultSha256": "b208b0f60bb49060cc1a266c238967be45a77dfe2814065f4c5f983961feb4ec",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/mutant.json.supervisor.json",
        "supervisorSha256": "147ed582389aea3756a935fc68a04ce6dc00c39f142efcd05e4ee46f1121974b"
      }
    ]
  },
  {
    "candidateId": "rt-0059",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/measurement.json",
    "measurementSha256": "8164822e0deedba7d444c076fb3ea8ddddd956e49fda9a2d8ae36b81840a79cd",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The changed response decoder must adopt a stored proposal from a refused response. Discarding only error rows preserves fetch and error wording. Observed: AssertionError: expected \"vi.fn()\" to be called with arguments: [ { …(21) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:138:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.230Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 111,
        "resultPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/baseline.json",
        "resultSha256": "da1c24cd47dedfc94ea5f86315d9971c975d01c0527e804e984e88a09265033e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/baseline.json.supervisor.json",
        "supervisorSha256": "3a9133993b5928696bab5684e627bbb51a06ad4403f3a2d07e98736dcd1e4d6f"
      },
      {
        "phase": "mutant",
        "launch": 112,
        "resultPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/mutant.json",
        "resultSha256": "ebd4edb723acb3b4808e65890be726b913b14ba76a40bd2db65c43b2ca51e9a7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/mutant.json.supervisor.json",
        "supervisorSha256": "28ea56b9695d2109d4e9790d93f01ce80488723b325dad4539a5ce6e178f67c7"
      }
    ]
  },
  {
    "candidateId": "rt-0060",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/measurement.json",
    "measurementSha256": "c9a694da5228fdfbe44a3958c0c6543698e4eee76558536291d88bb0f36d9e2c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Transport failure must write the fallback per-card error; removing callback leaves error map empty without throwing. Observed: AssertionError: expected undefined to be 'Something went wrong. Nothing was cha…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:154:45). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.235Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f302727add526b9da23c7ef5b40b375a09173bc2531e7cd3c95d06113810d0f8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 113,
        "resultPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/baseline.json",
        "resultSha256": "78fed9a9959925066bd95b6af11c3af259343be02d4e8231e2d8c58f9c002de1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/baseline.json.supervisor.json",
        "supervisorSha256": "4f4083def32d7a650dd5bffbc3214709bdf5e0281ee1fefc9f4e34ad9c97665b"
      },
      {
        "phase": "mutant",
        "launch": 114,
        "resultPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/mutant.json",
        "resultSha256": "7b33861e3022e11d4091efafdd3f5d88bdcfcac89422168b7fa55f3a0e7579b2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/mutant.json.supervisor.json",
        "supervisorSha256": "31ce9fc6c840b9217f7f023f3fb99d3a2cd73406c28a158c2eedbb7d2b225be8"
      }
    ]
  },
  {
    "candidateId": "rt-0061",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/measurement.json",
    "measurementSha256": "50764246741de0a3f594bae09201e49d317d10032b7d59ec0c622b8dc7f2a647",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: A disabled endpoint must invoke the outer session-disabling callback instead of silently returning. Observed: AssertionError: expected \"vi.fn()\" to be called 1 times, but got 0 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:167:24). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.237Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "131b86df43c7e8ae2557755f45981e85bc9205cf53f5ee520dd021acf726ad38",
    "phases": [
      {
        "phase": "baseline",
        "launch": 115,
        "resultPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/baseline.json",
        "resultSha256": "b23e4c1fccc1fe2b50caff33930124f07450aab0c86c990e70cdbc34b67f8286",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/baseline.json.supervisor.json",
        "supervisorSha256": "4162f5f9998572ccbd531217956cb2213d89bf311d6a8144bf969bfd42e1c67e"
      },
      {
        "phase": "mutant",
        "launch": 116,
        "resultPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/mutant.json",
        "resultSha256": "b2a30444643f2cf1e3ddc5fb733e6f686c99abd768c13fd0e0982c4b6f2fb26e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/mutant.json.supervisor.json",
        "supervisorSha256": "3a48f19969169e0604234e35201defd8774b8f52f3aeaf9da589afb62e47bdac"
      }
    ]
  },
  {
    "candidateId": "rt-0062",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/measurement.json",
    "measurementSha256": "3770fba58c3d6e8c4133309959ae4b9279334104487cf69d75b4c854fd45f55c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The changed request execution seam must launch one network write. A duplicated concurrent dispatch is meaningful even though the unchanged writing guard still rejects the second public write() call. Both mock requests register their releases before Promise.all waits; the test's existing finally releases both, so this mutation avoids the deadlock of a sequential duplicate. Observed: AssertionError: expected \"vi.fn()\" to be called 1 times, but got 2 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx:189:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.240Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "9bc3bf4f04dc42e0c72bd29584412a2750814e4eea0926d3c7735eacf677b886",
    "phases": [
      {
        "phase": "baseline",
        "launch": 117,
        "resultPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/baseline.json",
        "resultSha256": "6f607909a136a140d1ac0362003981bd0ec631486d5f9ce625a6ebc967920f41",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/baseline.json.supervisor.json",
        "supervisorSha256": "d913837542e08869e6f063de024a7a324a13c71fa616bda8b91316434e4bf2ac"
      },
      {
        "phase": "mutant",
        "launch": 118,
        "resultPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/mutant.json",
        "resultSha256": "83d23b4909b8072ea1ef71c2038d84eb447ba830cf129b9c570dc172053398e2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/mutant.json.supervisor.json",
        "supervisorSha256": "20a9b45d745ab073c7502cf46ff9a1f30577fe2cc35d21b020869a4e32fecd87"
      }
    ]
  },
  {
    "candidateId": "rt-0066",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/measurement.json",
    "measurementSha256": "0799949e0dc3789cff8f9dcae9088fd800d68fae68c20ca567ef5caf3a61af3c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed Apply result mapper corrupts stale HTTP status while preserving valid response. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/apply-route.test.ts:140:26). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.242Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "3c7cfa5f0cc9b9adb27785e4c032113922fe3fdc1f963218a37d26e892b3f6d4",
    "phases": [
      {
        "phase": "baseline",
        "launch": 119,
        "resultPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/baseline.json",
        "resultSha256": "9ae48d49dd50ed3f1a76dfacebccdc145596dd83d90dc520bea8278080f0cabc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/baseline.json.supervisor.json",
        "supervisorSha256": "0d5bf7a3a1681e65aff48c2e9236f35e66494f82067e9d1e29933645a5542ce5"
      },
      {
        "phase": "mutant",
        "launch": 120,
        "resultPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/mutant.json",
        "resultSha256": "30523dff2871d4bae6aa4fff696da3cb49749fd79b5544834e5deeaabdff943d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/mutant.json.supervisor.json",
        "supervisorSha256": "fd729c668fe92a8c65730cafa2129f45baaf77940b11a280b0929e6503e570e1"
      }
    ]
  },
  {
    "candidateId": "rt-0067",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/measurement.json",
    "measurementSha256": "0e8cabaeefc17d76615cd5fda3f8eeffb638f3ab96da499f51b72233774e0978",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed Apply mapper changes confirmation mismatch response status. Observed: AssertionError: expected 409 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/apply-route.test.ts:214:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:27:53.245Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "692d6de1676071497eef06fcbda889d5e52de4f79b3182bcd83b0f56e0943eab",
    "phases": [
      {
        "phase": "baseline",
        "launch": 121,
        "resultPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/baseline.json",
        "resultSha256": "29e242a1edbd6a0e72193f61252f5150ab591896d283b11a102ec92118da70ee",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/baseline.json.supervisor.json",
        "supervisorSha256": "54888be39356f4ed0df4c150ef913e3ea3a7b1c62e3babbd0dfd18f17051aab0"
      },
      {
        "phase": "mutant",
        "launch": 122,
        "resultPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/mutant.json",
        "resultSha256": "c29bde4b0a8eac3f2f13e78b50edee490c3966b956eddac61cbee46f919cefc6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/mutant.json.supervisor.json",
        "supervisorSha256": "90457f3df7a80f621ca004833f454553d42fc808929aac62973938397cc4bd5e"
      }
    ]
  },
  {
    "candidateId": "rt-0068",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/measurement.json",
    "measurementSha256": "6d0a97bba54ffcb4a42da0445673d8e9abefe85b5e978627055b510cbb574156",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:61:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.033Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 123,
        "resultPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/baseline.json",
        "resultSha256": "8a8fc122058ca83678dcd3464722783a335997fbd069aa99f7550a6a31881214",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/baseline.json.supervisor.json",
        "supervisorSha256": "b0ad99e3b79689ff6c7254f44670eb9900319de37c695e2ce755578a3e66f9e7"
      },
      {
        "phase": "mutant",
        "launch": 124,
        "resultPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/mutant.json",
        "resultSha256": "90cd25d28f567d795c80475299d0fc82a329a5c0889eaadca3b735989c3bb42f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/mutant.json.supervisor.json",
        "supervisorSha256": "e6d00db78095b5a3cbfa7caa554507d49258a78d5a61298b4fba5905c4868199"
      }
    ]
  },
  {
    "candidateId": "rt-0069",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/measurement.json",
    "measurementSha256": "559268156cc674f4e10f9398b7a819e2b5905adfe139160b79f6e3a3dd246899",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:97:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.037Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 125,
        "resultPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/baseline.json",
        "resultSha256": "5ff41b39c1d8b301f5a27d982fd37690b8dc13c3f96993966dd6c7a36e0f0204",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/baseline.json.supervisor.json",
        "supervisorSha256": "3c618eb30d6eff1eaf934df3e4213a67c49a8e64aa088d335dc44be7c2df522f"
      },
      {
        "phase": "mutant",
        "launch": 126,
        "resultPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/mutant.json",
        "resultSha256": "39ef170c37f1790ff493cc7f81f9bebd967f2dca430ed7976f7196c9ff6b3d79",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/mutant.json.supervisor.json",
        "supervisorSha256": "1be93df860661e1d04a187f5b8158166881b4d2affd80994f30cfb048e1954f1"
      }
    ]
  },
  {
    "candidateId": "rt-0070",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/measurement.json",
    "measurementSha256": "c0afd289f44f6496301a9029d5421a541f6da7e385792db2b5633fe5ea5fb75a",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:168:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.041Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 127,
        "resultPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/baseline.json",
        "resultSha256": "06f5e5ab12b5d679e3742af1b2d59ffd961dd5cebdbce9659aac37191d26cbb7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/baseline.json.supervisor.json",
        "supervisorSha256": "ca93c3e36456fee8b9bbab78de0aed72abc9003e8e655ec851fd012d12ef721b"
      },
      {
        "phase": "mutant",
        "launch": 128,
        "resultPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/mutant.json",
        "resultSha256": "6d4d53ed824f4415e0e367305a1316917f8908c851ba2b5169c4441e8348d147",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/mutant.json.supervisor.json",
        "supervisorSha256": "1df33aa02e811906fd50f54e466fc578003a27c4e95f2ef3a7fe7b13972405b0"
      }
    ]
  },
  {
    "candidateId": "rt-0071",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/measurement.json",
    "measurementSha256": "bd4daaf6467a8e200fc04514ac91b5fac75288b4e95022c655fa8269ed71241f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected { error: 'operator_disabled' } to deeply equal { error: 'location_not_found' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:210:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.043Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 129,
        "resultPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/baseline.json",
        "resultSha256": "c8a3d03c956294812397991fdbe51eb4e6014984fd4d3bb35465c68f7b94bc22",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/baseline.json.supervisor.json",
        "supervisorSha256": "21092dff97ca3fb72b5f68330fc9e9b878b129240b6f78228db6d1d26404e18e"
      },
      {
        "phase": "mutant",
        "launch": 130,
        "resultPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/mutant.json",
        "resultSha256": "10a8ee62dc4c0566df66551f6495192f5be96e92d5fcbd0a255ce5b4138dde6b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/mutant.json.supervisor.json",
        "supervisorSha256": "6b662be2cbe9ef54472f6780b9f284f4cbda181e27ccb98142d84ff2ddd93b1a"
      }
    ]
  },
  {
    "candidateId": "rt-0072",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/measurement.json",
    "measurementSha256": "63ac79dfa30c64926970da4475b8e8c9181372b51a72555e4d922b0644a3eec3",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/conversation-route.test.ts:252:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.046Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 131,
        "resultPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/baseline.json",
        "resultSha256": "33815121291e3ab8fa489519b22d444fd13f714777f926d4a303221e7a2eb81a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/baseline.json.supervisor.json",
        "supervisorSha256": "6d527182d1207b1cc33d7b21ccd7777f8677d0a47fdd393a14ac4fe5b67a4542"
      },
      {
        "phase": "mutant",
        "launch": 132,
        "resultPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/mutant.json",
        "resultSha256": "3a4cf73c6fdebb0b76b237061534b617076a0adba396b47b32827ec818756ce2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/mutant.json.supervisor.json",
        "supervisorSha256": "eb5fae7ca0e2caa1b9c59a9004bfbbf0691440cd160f8897adcde70deb65b647"
      }
    ]
  },
  {
    "candidateId": "rt-0080",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/measurement.json",
    "measurementSha256": "f9241f966cc7ee7b8580da6636de7df9052e6dcd4a3dc1ce789d79c06eb365dc",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed Restore mapper flips retry identity without altering preparation call. Observed: AssertionError: expected { proposal: { …(2) }, repeated: true } to deeply equal { proposal: { …(2) }, repeated: false } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:39:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:29:21.048Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "phases": [
      {
        "phase": "baseline",
        "launch": 133,
        "resultPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/baseline.json",
        "resultSha256": "0e9c0ab368bf977d26b4051fa2afdc5a5ac02a017763e12d0498681d141e616e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/baseline.json.supervisor.json",
        "supervisorSha256": "833fbecdcb0da4aa0546141b17b823275d18c92f1cfd942932e73d951f84da86"
      },
      {
        "phase": "mutant",
        "launch": 134,
        "resultPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/mutant.json",
        "resultSha256": "9826336aa09a7f4bf7ce3942489addf5814879e1ffc9db1b1ad59d7e779c3f30",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/mutant.json.supervisor.json",
        "supervisorSha256": "190b39f849f5baa275bf78a7fd368c77fbbf192989ad89b153fbf4d2bb3b106c"
      }
    ]
  },
  {
    "candidateId": "rt-0088",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/measurement.json",
    "measurementSha256": "17be33412942d0258a3b5797e24d989199dcb9f4137035356b177cd4d82c3933",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.245Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "bf21fb043cbc0fb27e9867a45a7377a7c8149bb8add330ac67bcf1b49241b192",
    "phases": [
      {
        "phase": "baseline",
        "launch": 135,
        "resultPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/baseline.json",
        "resultSha256": "22a1dfe7ebeed67c99bee762637e6d12669566234ce38478347341ba68b28781",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/baseline.json.supervisor.json",
        "supervisorSha256": "faee57a6be279cb0695ec733dafe098ca96b1c8a4e756d812495e5cf16be357f"
      },
      {
        "phase": "mutant",
        "launch": 136,
        "resultPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/mutant.json",
        "resultSha256": "1da0f8b5217421ec5ee7dc55e7b75f69b8a379ce9c03dcccaa175741c8f8210a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/mutant.json.supervisor.json",
        "supervisorSha256": "452bffd90275e4b5eab6f35c20ae14f519c21f1801161278f9a00e1a6f5020c1"
      }
    ]
  },
  {
    "candidateId": "rt-0089",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/measurement.json",
    "measurementSha256": "0292de1985302042718d397384b03177be81af532b2d0f650597aa487d351ca7",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.250Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "038c113fd0aafbd051be59871f184f307e43e75fafb106f2b6b5fa08ce6329a7",
    "phases": [
      {
        "phase": "baseline",
        "launch": 137,
        "resultPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/baseline.json",
        "resultSha256": "20af589315a4c6095e6e4b684738f6217845c66bd8400a3d8d5680a2f348da3f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/baseline.json.supervisor.json",
        "supervisorSha256": "a97cc481c944e63d5838d4de4ee46ee77052d18c01221b911dcb8ed3afc8c512"
      },
      {
        "phase": "mutant",
        "launch": 138,
        "resultPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/mutant.json",
        "resultSha256": "0be4860612e70136cda768d2da822e590c897e4b88bf865f88534e4d4d543d17",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/mutant.json.supervisor.json",
        "supervisorSha256": "e3cf6301f0037ea8a2cfcabdccca987f8a587d1a24136f5656d789dbd0821a8b"
      }
    ]
  },
  {
    "candidateId": "rt-0090",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/measurement.json",
    "measurementSha256": "dd583d5bc2eb052d5740148d46b070017eed0db20e7785d6d64ee2943e96b72d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.253Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "36e20709e98692586b6560df0ff1c961afbdea52582a25758ad4a5904e30df12",
    "phases": [
      {
        "phase": "baseline",
        "launch": 139,
        "resultPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/baseline.json",
        "resultSha256": "6dc7e4a72209fcb930e7c63a256bd0a20f5d4675469532e57eabd6994fecadc3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/baseline.json.supervisor.json",
        "supervisorSha256": "950a556d49b66fd26d43a78e1ebe66f44c285810d3888b2d31bd9b2350a34717"
      },
      {
        "phase": "mutant",
        "launch": 140,
        "resultPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/mutant.json",
        "resultSha256": "1754ac411acfc265b040ba0a94c53cbb1f48fbf78bfb369db424b9ab79949be6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/mutant.json.supervisor.json",
        "supervisorSha256": "f754da4b84362dac6a0c131d7d9a6cd506c63f9d7fc79a3367fd297abe57e3d6"
      }
    ]
  },
  {
    "candidateId": "rt-0091",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/measurement.json",
    "measurementSha256": "5478c9634b11790d20fd09a3444292adce371e110468840c5cc908ec14587bf5",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 403 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.256Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "514604a7388c46d2ce2b5e670a51abb41995c0631cf3b87e05bbc54c98624389",
    "phases": [
      {
        "phase": "baseline",
        "launch": 141,
        "resultPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/baseline.json",
        "resultSha256": "0451a834f28d67f07696f78fb5517f62f2c1e70e3f688e94e9310a71ca117717",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/baseline.json.supervisor.json",
        "supervisorSha256": "c544990aee409ced239d9fb081eff6ff60516d5f08c88527c59df18def9255c3"
      },
      {
        "phase": "mutant",
        "launch": 142,
        "resultPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/mutant.json",
        "resultSha256": "9fc561ea8f0e1ac497ae56a31339db51b1d11f27f00733ee88ddf17204027af0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/mutant.json.supervisor.json",
        "supervisorSha256": "c9780aa908feb62829224c5ac7f7e2405ee8f67c8a0201213d0b819cbe4ea111"
      }
    ]
  },
  {
    "candidateId": "rt-0092",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/measurement.json",
    "measurementSha256": "773a9fd39129e33e6751c8e6a8d6ce4bc2042c7ba1ef1ea1c6400df11432ef49",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.258Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "f5b645527b042b05f84ba6b311b8f25082ec3b59f8e10639c391f51f5492ab38",
    "phases": [
      {
        "phase": "baseline",
        "launch": 143,
        "resultPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/baseline.json",
        "resultSha256": "ce19bb45b64def4d030295c91d77f54ebbde60a727788230c5abb12ba17a69ee",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/baseline.json.supervisor.json",
        "supervisorSha256": "4c619265b66249e1f7f1e18b8a352bf40c0f939159f9bdd92042178b064806f8"
      },
      {
        "phase": "mutant",
        "launch": 144,
        "resultPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/mutant.json",
        "resultSha256": "1d3593fa0175f6185090fa1a484ce2f447ce7d4cf0c402de824dd9725cb68309",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/mutant.json.supervisor.json",
        "supervisorSha256": "6c710115929a8b73e72faeac119d14206f0754f80a59fcc47b85ade0cb7d43f8"
      }
    ]
  },
  {
    "candidateId": "rt-0093",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/measurement.json",
    "measurementSha256": "53bd8ea4c9a0ee73c2f63a7f88f288a635d2b33e230a556063f5827ec02d6b2f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted Restore mapper returns wrong status for existing domain refusal. Observed: AssertionError: expected 400 to be 409 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:87:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:30:50.261Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "c5710880bc312d1514fdca00a24a3099fd5383eef94817cf54daeff4055b7e6c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 145,
        "resultPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/baseline.json",
        "resultSha256": "ea47aa62105f512d7071665b5904498f06b8ce5cf4e0ab30d1ac7f21e8e4e983",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/baseline.json.supervisor.json",
        "supervisorSha256": "c799e0588d4c48ec6909a6971d5833216d1e7508158b090ff0af2512090c2c03"
      },
      {
        "phase": "mutant",
        "launch": 146,
        "resultPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/mutant.json",
        "resultSha256": "076bb5990b8c959200383dba09e59a6f04d84539c0360a175a33c73d2d063469",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/mutant.json.supervisor.json",
        "supervisorSha256": "1a4681d6d3cf1e38c3b749f942d17c4bc96a7b860b4daac5b63e9bc0c246fbdd"
      }
    ]
  },
  {
    "candidateId": "rt-0094",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/measurement.json",
    "measurementSha256": "ec5acdb47138db1b23ebf86df820fe0e5568d78babeec1cfb022f28a93659b9c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed Restore mapper flips retry identity without altering preparation call. Observed: AssertionError: expected { proposal: { …(2) }, repeated: false } to match object { repeated: true } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/restore-route.test.ts:93:60). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.953Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "phases": [
      {
        "phase": "baseline",
        "launch": 147,
        "resultPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/baseline.json",
        "resultSha256": "f0261be342dfa5b10845d6990a0e42ff7d38ffea4d045317d33096a4cfde4b17",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/baseline.json.supervisor.json",
        "supervisorSha256": "861c00f1c21a73e3bbb4daf5423a8da1aa002032e6767ff12cdea12637392216"
      },
      {
        "phase": "mutant",
        "launch": 148,
        "resultPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/mutant.json",
        "resultSha256": "9884ece5afcf1fdb51c36ede516ac1024fb3fe92d2bec8f7c077567c3e910466",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/mutant.json.supervisor.json",
        "supervisorSha256": "9268fc44aff5454323e0dd78770619b1b59228e615bd0a5ae497202bba9dbcaf"
      }
    ]
  },
  {
    "candidateId": "rt-0095",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/measurement.json",
    "measurementSha256": "375f01f1d1db3a5a939ea4ad2617df112f30b51cc1e6341f2b838c840e53a20f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:34:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.956Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 149,
        "resultPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/baseline.json",
        "resultSha256": "71966ddcb9de66bac26bec840b89ac562fd9c66430d8d2acb6e0856bd7d3f8d5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/baseline.json.supervisor.json",
        "supervisorSha256": "30fae850a11597694dae09df688025f16ca5fcf98210c20d390e85bba88da13b"
      },
      {
        "phase": "mutant",
        "launch": 150,
        "resultPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/mutant.json",
        "resultSha256": "a8bfd6df670484c658519ba08c433a9e6b32d316e16ed94f7ca252db13ba8e3e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/mutant.json.supervisor.json",
        "supervisorSha256": "587e93bd08953f7b17228f291a6fe5247b25f1b9e27b41f7cd3b0b5884b2eed2"
      }
    ]
  },
  {
    "candidateId": "rt-0096",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/measurement.json",
    "measurementSha256": "cdc9b9b5a03f16a23a6c277006b8b9e176cc19658d1fa77283a2310332b5390e",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 200 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:42:43). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.959Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 151,
        "resultPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/baseline.json",
        "resultSha256": "63cae7a0dba2474a79ba27e269f54c3e829fbaa0aa8eef42e3b94c5a2ef6c83f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/baseline.json.supervisor.json",
        "supervisorSha256": "1b3d9ed94844ac2c85a19e407306117336baef061d3e75377339710b499bdb62"
      },
      {
        "phase": "mutant",
        "launch": 152,
        "resultPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/mutant.json",
        "resultSha256": "e00ebc5d7801f15b8f91160166f2f594f2b2cb02a60e34ae01a4487f749695d5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/mutant.json.supervisor.json",
        "supervisorSha256": "b0621255219badc9473d3b4748229a8234d5f5dc95e921576f6cb49c92db96c7"
      }
    ]
  },
  {
    "candidateId": "rt-0097",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/measurement.json",
    "measurementSha256": "eb6780d0f0a9b4034a92a22f029fed143413b39745004388fd43893f66c35c5c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Invert extracted read feature gate. With flag false valid mocked owner permits read; no setup change. Observed: AssertionError: expected 200 to be 404 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:48:43). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.961Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "6991fef051c29d38f32f5b9413fedcc99f61986859386761e5169f9182ca3544",
    "phases": [
      {
        "phase": "baseline",
        "launch": 153,
        "resultPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/baseline.json",
        "resultSha256": "65884851c8280aabe7932c8299bdd045ababca5e7e9b723117dad8d777b94d9d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/baseline.json.supervisor.json",
        "supervisorSha256": "d46cea95b02afe0f689f81170338d3a628596b5048a183f7f734427377d574c4"
      },
      {
        "phase": "mutant",
        "launch": 154,
        "resultPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/mutant.json",
        "resultSha256": "0cadf97137313dfd84fecbee8b9a4d81c7dc39dbc60039adcb6ad08edcef14fd",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/mutant.json.supervisor.json",
        "supervisorSha256": "38d8773d7afd7f16ae2bf2823d6bf7ab3fc0e1c6b76aa718856f13deac7c70b7"
      }
    ]
  },
  {
    "candidateId": "rt-0098",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/measurement.json",
    "measurementSha256": "5344baaf7e54cc4679ad2c4ada9ef7c9db1b92ec398cbfaec88d6a1e488a0873",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.963Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 155,
        "resultPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/baseline.json",
        "resultSha256": "7d75d8f122a10c744e93c737325498f730afe13d8e1a39b608b9aae8eb088ddf",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/baseline.json.supervisor.json",
        "supervisorSha256": "303abfb56789db2f09f38bbee80af4834130a6199bf061af6b039bf66a0be72e"
      },
      {
        "phase": "mutant",
        "launch": 156,
        "resultPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/mutant.json",
        "resultSha256": "6f89e168c5799d566a7f692e91cf355dbac5fab93f5dc138aaf114d2c3976ea3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/mutant.json.supervisor.json",
        "supervisorSha256": "c89a5043669feaca0a5d324ef710870e61db3b96daf8deea58a6dacd5f0df0b3"
      }
    ]
  },
  {
    "candidateId": "rt-0099",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/measurement.json",
    "measurementSha256": "b6d82b531504025048cbf694d92398358b55bacc236529109e7fe170d8910297",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.966Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 157,
        "resultPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/baseline.json",
        "resultSha256": "accfad9e928c6093b23fdab3773369c7586805891b39051e2e44529b406502df",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/baseline.json.supervisor.json",
        "supervisorSha256": "b3d4b241ab530e1df288a7dc7e694f8863278ea1d97c22ab3c98539ca40fade9"
      },
      {
        "phase": "mutant",
        "launch": 158,
        "resultPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/mutant.json",
        "resultSha256": "ca6dc85b4025f277c614609de294895aaad752f6361ff926e20bff6b88fbb96c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/mutant.json.supervisor.json",
        "supervisorSha256": "db2832daadc9fd0a63ee318e03a9e66f597b252e5a1271531c01c758d0c486e1"
      }
    ]
  },
  {
    "candidateId": "rt-0100",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/measurement.json",
    "measurementSha256": "8e8e42cb2b82e1fa69fb2bc32004300b7b4ce46adaad86158394052856a5275e",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:32:58.969Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 159,
        "resultPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/baseline.json",
        "resultSha256": "c465c9b08d076cbcb82fa580ed13886f701807966764acb74e3355f1c2a1ecad",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/baseline.json.supervisor.json",
        "supervisorSha256": "1a712a468936fa586072e4cff263c04d36fe8217c49adeebb86e3c0485a0c3d1"
      },
      {
        "phase": "mutant",
        "launch": 160,
        "resultPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/mutant.json",
        "resultSha256": "0d357e37d6f7b9aa6b03ca44fbb4ffea0b639c6fc31be118944a1a9a77ed4136",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/mutant.json.supervisor.json",
        "supervisorSha256": "7c3f5cac53aa76a75db28686223bc9e88369ba88d330a93c6d3ed06a79915ed7"
      }
    ]
  },
  {
    "candidateId": "rt-0101",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/measurement.json",
    "measurementSha256": "01dc258a7383098957e56b6844e7f15658b38aea09e96673bbb0cc1b40603cd6",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.489Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 161,
        "resultPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/baseline.json",
        "resultSha256": "65e8d70eeef01fca625b64a4c9f438264239cf50b1fcd17ae33bc44ffc231020",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/baseline.json.supervisor.json",
        "supervisorSha256": "6f5fc53d410e3fcebddbd42f7d6ec5738027638931b16bd01bedd772beeee247"
      },
      {
        "phase": "mutant",
        "launch": 162,
        "resultPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/mutant.json",
        "resultSha256": "ac218650b7c074bf5d71e3e5fe2c1bffc1477b85ad2d150ced9091eb34f9cd85",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/mutant.json.supervisor.json",
        "supervisorSha256": "75982a6be81ed09e1e282a6ec42d3e6e648678919e13fab7eb59a6c9cce9349f"
      }
    ]
  },
  {
    "candidateId": "rt-0102",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/measurement.json",
    "measurementSha256": "bb1e20808205d71e8cfb3e417423637900217d802b29d758dde276abd0f95402",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.492Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 163,
        "resultPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/baseline.json",
        "resultSha256": "4e6e1f1c74879c818e404b980935f819e8b9de49c5fd75764c8606f5de765d5e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/baseline.json.supervisor.json",
        "supervisorSha256": "b61c0ebae4d45339ec4a59d360ca3f753a3dca1967a3a908efeb30d4ad41d15e"
      },
      {
        "phase": "mutant",
        "launch": 164,
        "resultPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/mutant.json",
        "resultSha256": "4817f6bcde5842bd235b67fd76b7fe98a4c7290a2e1430c156b9dd15c4a8dac2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/mutant.json.supervisor.json",
        "supervisorSha256": "fa0b581d13ff1795ac4806b96ac3ed1af6f5366813d93e702b8055307af5884a"
      }
    ]
  },
  {
    "candidateId": "rt-0103",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/measurement.json",
    "measurementSha256": "aa50a001ec99aeddbf9089583829c35332a3424193ee8dd6da6fa4ed91b890d4",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:21:35.927Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 323,
        "resultPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/baseline.json",
        "resultSha256": "0d2440ff926d88c080570af71dc9e8b18f3bdc43212456b2f149c4429bf11a77",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/baseline.json.supervisor.json",
        "supervisorSha256": "b5ce4809f4ebbf1579e2730626d73ca503c4bafc1730f3adaf5163796f615ade"
      },
      {
        "phase": "mutant",
        "launch": 324,
        "resultPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/mutant.json",
        "resultSha256": "3c973052d5d6e3bc286cab649cb5439da00b1701609c93e8b5aab149e2bd38e1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/mutant.json.supervisor.json",
        "supervisorSha256": "e77eeb0db09562fae1aba1871681b339d4c9866fc440cd613d4d2314ddf0abdf"
      }
    ]
  },
  {
    "candidateId": "rt-0104",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/measurement.json",
    "measurementSha256": "c5c043da77a09f159192d1ea2f015c6f6a31982c2f8cad897d21377dd97117fc",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.495Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 166,
        "resultPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/baseline.json",
        "resultSha256": "94ffe92a3100c27a4f7bde3f67541ee411a4d65e560a63c52430e9bf1452c460",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/baseline.json.supervisor.json",
        "supervisorSha256": "bb155a5dab54d19675f0e1810981a8a268865f4aa8c4951368580044a2e64c16"
      },
      {
        "phase": "mutant",
        "launch": 167,
        "resultPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/mutant.json",
        "resultSha256": "7a546ecb554b24a4604f3fc5b0875d6eedbbba6f91524cf4bc6ba4ee63dcf2ca",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/mutant.json.supervisor.json",
        "supervisorSha256": "ebf0c601a8fc8dcdf8948a8b686f0cb1adcf696420e664a6a3251e3dc9d4c1e6"
      }
    ]
  },
  {
    "candidateId": "rt-0105",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/measurement.json",
    "measurementSha256": "28a163115c8b6cea87db4e133cefe3b8b75cbd79d4dd46ddb7ba41b3fdb93198",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.497Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 168,
        "resultPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/baseline.json",
        "resultSha256": "07211da5e3ce4f780dcb654686547bcf82974a2bdceccd6ceece501e37808807",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/baseline.json.supervisor.json",
        "supervisorSha256": "9b71fcc42b67924437fe71a85decc102f4ce27a18760df4d1cb65c3ded5ef995"
      },
      {
        "phase": "mutant",
        "launch": 169,
        "resultPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/mutant.json",
        "resultSha256": "8fc39faa0bae8af96d7da5f8df3d50161d9099b8bbadae723e08e53c4c0e0106",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/mutant.json.supervisor.json",
        "supervisorSha256": "ca06d2947d3fa96dad4031ccaf2312dd2a1eba0a8e42e949b04bca90d229215e"
      }
    ]
  },
  {
    "candidateId": "rt-0106",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/measurement.json",
    "measurementSha256": "083eb98a8921e312b312a88c626ae54aaa3af3395eb45a877b656eb9ddb675fd",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.499Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 170,
        "resultPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/baseline.json",
        "resultSha256": "7626df8a3e4fba42866ffc382198c9c1d6268edebde0b7957322769b3bad2811",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/baseline.json.supervisor.json",
        "supervisorSha256": "5f125c54db71b101c111a6f3054788e9ba942952e39bc36107858cf690f5bbc1"
      },
      {
        "phase": "mutant",
        "launch": 171,
        "resultPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/mutant.json",
        "resultSha256": "a59e86b77e939b3d770095770f6e45329d64e70943d2d331648e2c18c3ad91f5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/mutant.json.supervisor.json",
        "supervisorSha256": "18e2f9aff6de20cc89f6628727fd1d54429cad1da687f18939008b96449754b6"
      }
    ]
  },
  {
    "candidateId": "rt-0107",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/measurement.json",
    "measurementSha256": "1cce788709eb6ebbd45940b7ea2eefe328c94a5cdd558a620c74ed6a7ed028df",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 400 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:61:48). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.502Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 172,
        "resultPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/baseline.json",
        "resultSha256": "4c973435f59773ad13ca1192a500e93e1f45437ee9903b85d187054ac1ad80ea",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/baseline.json.supervisor.json",
        "supervisorSha256": "d449e7f941928127e6590eba9ba5ab59c79387703ebfdcfca6df05a1cdf1654e"
      },
      {
        "phase": "mutant",
        "launch": 173,
        "resultPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/mutant.json",
        "resultSha256": "aa3befc03290d4163c292e0cf1fc601a37b1eab638c6e15568c8fa140eee2eb0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/mutant.json.supervisor.json",
        "supervisorSha256": "7982632bac04f534ba4cfaa5fa3ea246c91ac35ee90d026f6eb3b2d15ea48241"
      }
    ]
  },
  {
    "candidateId": "rt-0108",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/measurement.json",
    "measurementSha256": "93a7bf9f32d5cdddd3af5e478100991fcb27a00cb0064d730d27f27f675ee68c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted reader gate incorrectly denies an enabled owner. The GET body calls the real gate, which produces a valid response without extra SQL or exception; route assertions observe wrong status/body. Observed: AssertionError: expected 404 to be 500 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/app/api/operator/__tests__/rules-timeline-route.test.ts:68:29). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.505Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "phases": [
      {
        "phase": "baseline",
        "launch": 174,
        "resultPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/baseline.json",
        "resultSha256": "e125ffb6b4a11a5fedd1593807d78c5cbbdf36451e354ee13fd25f433ab56cbd",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/baseline.json.supervisor.json",
        "supervisorSha256": "ea649ee704de63ac87deae3a1813fd7ff62c1bac81d602082378600b0d552ec9"
      },
      {
        "phase": "mutant",
        "launch": 175,
        "resultPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/mutant.json",
        "resultSha256": "536b70c18db8c12108a5d72c8b4c15d19eb93aff65b2ec128800bcd0bb64ea52",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/mutant.json.supervisor.json",
        "supervisorSha256": "688c497b63796b0854fd603ed4a65675f6d190d4cb215ebbb7a8753b86b97946"
      }
    ]
  },
  {
    "candidateId": "rt-0120",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/measurement.json",
    "measurementSha256": "966538406c342f37322913b2f9422b1c7d5f03b2d43168148f3531dc131492f3",
    "verdict": "killed",
    "reason": "The second attempt substitutes preview productsServices into the committed receipt. The existing receipt.after equality at apply.integration.test.ts:470 fails, proving the test detects receipt state that differs from the actual write; the historical timestamp attempt and RT-001 rejection remain unchanged.",
    "reviewedAt": "2026-09-16T04:21:49.715Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "76a1b5eb715b16a31bf8fab3b1fc2c90a555da3f57edce49281ac0b810a4fbd8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 43,
        "resultPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/baseline.json",
        "resultSha256": "fa1f6b4a15f43fa123731b42b95d105e62a41160dc03ae1b24a12224463af296",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/baseline.json.supervisor.json",
        "supervisorSha256": "37a198bc76b0b733ab46ee5676a64a314e4940b4b5bc3694a03da0aec5b8c562"
      },
      {
        "phase": "mutant",
        "launch": 44,
        "resultPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/mutant.json",
        "resultSha256": "a83b579b9ca40b9a23907b3e4472700c90073116cc60891c3b76ee5eec13c22a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/mutant.json.supervisor.json",
        "supervisorSha256": "23e17997f52f03f0205d78c8936e032df32c8020d912cd921dc28e6227431973"
      }
    ]
  },
  {
    "candidateId": "rt-0121",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/measurement.json",
    "measurementSha256": "9de49d77c62455288858ec92f3d1794649d728ac5e651bf9d72e26265419115d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed voice orchestration discards the successful recordVoiceApplied result after preserving all writes and returns a valid not_found. 0121's injected transaction still rolls back; its normal retry detects result corruption. No fixture Apply. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:522:26). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.508Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 176,
        "resultPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/baseline.json",
        "resultSha256": "2a17a9aff44deb5c948dfaba16cc96fd4be132eaa02987188264fe15b9e2e9e2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/baseline.json.supervisor.json",
        "supervisorSha256": "6cbe6a85110a5607e4d7b1c2bd22327fdc17dc6ebbdf53d97e6705014be1f525"
      },
      {
        "phase": "mutant",
        "launch": 177,
        "resultPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/mutant.json",
        "resultSha256": "12eff0c7ede755800f631fb136e200b57f06764f6859c571b4844018c7eb13df",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/mutant.json.supervisor.json",
        "supervisorSha256": "950c6aa624f259b72c5b258126e3ff51420f5fa74086b74f11eef824ac3cb5bd"
      }
    ]
  },
  {
    "candidateId": "rt-0123",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0123-oET87A/measurement.json",
    "measurementSha256": "7e6a8c233127e81d8fdf683dbb094fc935b963bdc615b994ff9a53d22a367aa6",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed voice orchestration discards the successful recordVoiceApplied result after preserving all writes and returns a valid not_found. 0121's injected transaction still rolls back; its normal retry detects result corruption. No fixture Apply. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:611:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.510Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 178,
        "resultPath": "/private/tmp/operator-continuation-rt-0123-oET87A/baseline.json",
        "resultSha256": "71a5186f19b598f2a1280b4895aa301f47fe18739b9655013c10af76efadd2fb",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0123-oET87A/baseline.json.supervisor.json",
        "supervisorSha256": "79e987e2f70d091c2113f79b2cce9948608b36368ae4f880000785340a49ef3f"
      },
      {
        "phase": "mutant",
        "launch": 179,
        "resultPath": "/private/tmp/operator-continuation-rt-0123-oET87A/mutant.json",
        "resultSha256": "949dbae83d1b65b56775ff075936ee265c16a37d27216772475e3d1c1d6c75da",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0123-oET87A/mutant.json.supervisor.json",
        "supervisorSha256": "c2627bc8441da21b95aeadd6b1e4c797519cde2e3802e39131735bbfdd0e38ba"
      }
    ]
  },
  {
    "candidateId": "rt-0124",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/measurement.json",
    "measurementSha256": "050e51e1bf011b5036818c7a0a8f612715021544e8bde7278315230a68d33329",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed voice receipt handoff drops Receipt only from returned success view after persisting original receipt. First Apply still returns applied and all setup assertions pass. Archived repeat takes unchanged settled branch and returns stored non-null receipt, exposing inconsistent initial versus repeat response. Observed: AssertionError: expected { version: 1, …(14) } to deeply equal null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.integration.test.ts:665:41). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.512Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "63252f92e86c472de6a9f3fa379b901248a9a5a850cc98c7f575db63f25bd8f5",
    "phases": [
      {
        "phase": "baseline",
        "launch": 180,
        "resultPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/baseline.json",
        "resultSha256": "35d1ab7574dd6cb59d2a2c1ca86699074144d4d8c34c4e09a880c7578ac2e93b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/baseline.json.supervisor.json",
        "supervisorSha256": "1de48d7ffc27d6451e31a3a1de57f74298fcd77ef4a13e992616a3b645f9b606"
      },
      {
        "phase": "mutant",
        "launch": 181,
        "resultPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/mutant.json",
        "resultSha256": "36d4d18f9615147908c32651ee195bd254ba8928b7b52bd9b17f0f13286ca472",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/mutant.json.supervisor.json",
        "supervisorSha256": "6e9b18b33fb2e5f8a835a20f235ccdfe9d11f807f9259db199158f60aa31c095"
      }
    ]
  },
  {
    "candidateId": "rt-0129",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/measurement.json",
    "measurementSha256": "83530d8d25e9d0c818fc499ea39118e204436c9864dcd172539da2b59e56d18f",
    "verdict": "killed",
    "reason": "Moving the voice write before freshness validation caused the existing writer-not-called assertion at apply.test.ts:346 to fail after the stale-result assertion passed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.341Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "phases": [
      {
        "phase": "baseline",
        "launch": 31,
        "resultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/baseline.json",
        "resultSha256": "eb8d015895fadfbbcf048227305b2b35587459ae35417d8ff76ee9c9c4609a97",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/baseline.json.supervisor.json",
        "supervisorSha256": "b4c8bcbd3c5e933f1c5b84c1718d692ab0f899c07bc274f2fe8a4cfcdba6cfb7"
      },
      {
        "phase": "mutant",
        "launch": 32,
        "resultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/mutant.json",
        "resultSha256": "cc906f6c5fdc0bf2fc5122cfa1764da52c8e4deff62764a8133a7b33921d1962",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/mutant.json.supervisor.json",
        "supervisorSha256": "538cc5299e3e56809d2ebd58da2993e1fa8c6ee474af38e5563101bbf73c77ac"
      }
    ]
  },
  {
    "candidateId": "rt-0130",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/measurement.json",
    "measurementSha256": "e4a9e048945ff043ab3fa32d4bce232edf6c987a0c4c42a3aab21686c736f263",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Move the real extracted voice-write phase before authorization and token validation. One statement-block ordering defect; writer called once. Preserve actor/token checks and terminal result. Observed: AssertionError: expected \"vi.fn()\" to not be called at all, but actually been called 1 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.test.ts:376:33). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.515Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "phases": [
      {
        "phase": "baseline",
        "launch": 182,
        "resultPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/baseline.json",
        "resultSha256": "fdbe0fb80d505766d762994c55bd7ecbcf3d1a3c7cf48ba3f69755c8830cb97f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/baseline.json.supervisor.json",
        "supervisorSha256": "853e27a3ecb5eb7d7c0844c3c6ef02386408bfd4c510d43dc7cda9a41a56a3b5"
      },
      {
        "phase": "mutant",
        "launch": 183,
        "resultPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/mutant.json",
        "resultSha256": "64216db4b3faf7f4cba343f46de5f83865f94b3303e8f832ac6f04f7222755f3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/mutant.json.supervisor.json",
        "supervisorSha256": "abe0c868b88f262461600747cef83570ebf7a7f7899dbbc6dfdbfc968a779922"
      }
    ]
  },
  {
    "candidateId": "rt-0134",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/measurement.json",
    "measurementSha256": "68329ffec0c4f9a71b2b8f6cee702e0ed6e5ebeed22bddec0ece9a84860c5d34",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Move the real extracted voice-write phase before authorization and token validation. One statement-block ordering defect; writer called once. Preserve actor/token checks and terminal result. Observed: AssertionError: expected \"vi.fn()\" to not be called at all, but actually been called 1 times (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/apply.test.ts:477:33). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:37:44.517Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "phases": [
      {
        "phase": "baseline",
        "launch": 184,
        "resultPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/baseline.json",
        "resultSha256": "997c44c00b298daee59a3b1c84618171f1d8c6ce9a580c49eeaf0d9c47fbf9f6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/baseline.json.supervisor.json",
        "supervisorSha256": "de2cfc20c03add03b14fc6d132c37de54615d027944ea0166162c8e23d631f66"
      },
      {
        "phase": "mutant",
        "launch": 185,
        "resultPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/mutant.json",
        "resultSha256": "be5bc9d5c4384768db22f71d0705e24685e746c6d2e66cdd0741438dc5fd9772",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/mutant.json.supervisor.json",
        "supervisorSha256": "36dfcf59bda5660d66dfde2cb6214d1e7ef0b9559ec1ea827821e577ea5c9433"
      }
    ]
  },
  {
    "candidateId": "rt-0137",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/measurement.json",
    "measurementSha256": "445275c449b2f139d80d907dbec82287935fc79ce6d7d2559df31f0d5c3489f7",
    "verdict": "killed",
    "reason": "Adding policy_suspended to remainingBlocked after the original write fails the existing empty-list receipt assertion at apply.test.ts:768.",
    "reviewedAt": "2026-09-16T04:21:49.716Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a677a16c19b28422df1217fe64cccc368d2f58ded289aee62225ba7845ec2e41",
    "phases": [
      {
        "phase": "baseline",
        "launch": 45,
        "resultPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/baseline.json",
        "resultSha256": "f85302d276886021149659f38f75075d04565642e4a24f46dcf9b3227965ce27",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/baseline.json.supervisor.json",
        "supervisorSha256": "fcb94099b1b327d689c7b0b775450f33b44fa4d5524c64e393bb690a5984d035"
      },
      {
        "phase": "mutant",
        "launch": 46,
        "resultPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/mutant.json",
        "resultSha256": "09deec240e5e6eafe0fcf5a790707158b3ef1dfd388c2ee97cad6577ae41e5f9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/mutant.json.supervisor.json",
        "supervisorSha256": "923416a1c19558d9e1cd9bc9a05e9b5a382b7ec35d682cc654f6ef068fb9e88f"
      }
    ]
  },
  {
    "candidateId": "rt-0138",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/measurement.json",
    "measurementSha256": "6e5a5e29623f1e92f11318a598d48a92c04e77bb970437592a747c0bfb7b5983",
    "verdict": "killed",
    "reason": "Replacing the returned typed-scope refusal with not_found fails the existing confirmation_mismatch assertion at apply.test.ts:796.",
    "reviewedAt": "2026-09-16T04:21:49.716Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "phases": [
      {
        "phase": "baseline",
        "launch": 47,
        "resultPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/baseline.json",
        "resultSha256": "8f049b6bc4ae08c0264368dd650a0de69962570a1eba178c24cde20e1e4a3fce",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/baseline.json.supervisor.json",
        "supervisorSha256": "f128ba1aec3c4b630e9305be55b4e024964a35d818bacfbd80f119cc5ac5f7b2"
      },
      {
        "phase": "mutant",
        "launch": 48,
        "resultPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/mutant.json",
        "resultSha256": "7d409ef16153d6334ef9086d7df613dde6c36ad6e3ccd68e690d9e88ad88a3ae",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/mutant.json.supervisor.json",
        "supervisorSha256": "50a0079051a5f31a9784e39a2fbea7c233ee1017b14dca36a18d0616a0fe06d0"
      }
    ]
  },
  {
    "candidateId": "rt-0139",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/measurement.json",
    "measurementSha256": "67b0819676a12a9b4964d254ea40315b48d7a1898b5b14a2a67435023f13f8f8",
    "verdict": "killed",
    "reason": "Replacing the readiness refusal with not_found fails the existing blocked-result assertion at apply.test.ts:817.",
    "reviewedAt": "2026-09-16T04:21:49.716Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "phases": [
      {
        "phase": "baseline",
        "launch": 49,
        "resultPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/baseline.json",
        "resultSha256": "a8c5fa117695a57162a70b33e6eadab7d4fbb77df6c2c8ecff336dbccf043f3b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/baseline.json.supervisor.json",
        "supervisorSha256": "984b38951166a8971e87a26e599059239fdccd243e81d52738946f0136661f21"
      },
      {
        "phase": "mutant",
        "launch": 50,
        "resultPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/mutant.json",
        "resultSha256": "2a49e0cfab09976e11658a147216c2edf96e5f2d3e673fc70f522e3c043b9eed",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/mutant.json.supervisor.json",
        "supervisorSha256": "54244613a44e756de0a0e24e22d25ec8f57b9e01a6d17ca1036d1ba4d5b6cabd"
      }
    ]
  },
  {
    "candidateId": "rt-0140",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/measurement.json",
    "measurementSha256": "3541ccc0f1eca3bcd07a6515f4c7d41f52168dd1f699e4008425385ae8be1600",
    "verdict": "killed",
    "reason": "Replacing the archived-location refusal with not_found fails the existing rejected/location-inactive assertion at apply.test.ts:857.",
    "reviewedAt": "2026-09-16T04:21:49.717Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "phases": [
      {
        "phase": "baseline",
        "launch": 51,
        "resultPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/baseline.json",
        "resultSha256": "bc55cf5e40ea222148ed3c045ce1b2477f4d3be9fa2fa2b2e5c04661e8749f2a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/baseline.json.supervisor.json",
        "supervisorSha256": "d8c20f5d5e4e298e8c2ecc071915a705b0b248c5dadd69af279162e593db4e02"
      },
      {
        "phase": "mutant",
        "launch": 52,
        "resultPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/mutant.json",
        "resultSha256": "502a6f736f7440c3dcb70d7ebb9a896642196c905e65c50ee13286aa7bfb29a1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/mutant.json.supervisor.json",
        "supervisorSha256": "4f876b89c15bddff2e15112bc63e5ecb4fb0a186bd5f2330debfe59daab92ed6"
      }
    ]
  },
  {
    "candidateId": "rt-0141",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/measurement.json",
    "measurementSha256": "dd1b9300298d4f985ac4fa3c1ab4f1a6b3572b835802d5eff968b572a1fecd5e",
    "verdict": "killed",
    "reason": "Moving the policy freshness check after execution caused readiness lookup before stale refusal; the existing settings-not-called assertion at apply.test.ts:898 failed after stale-result and snapshot-count assertions passed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.343Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "d7e4f938abbc3db80801ba41ec81675e8c21bfb9e2f939d351cc9782e720bc84",
    "phases": [
      {
        "phase": "baseline",
        "launch": 39,
        "resultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/baseline.json",
        "resultSha256": "9266e2be758e2257b8aee5497822f11107b50fc5d6e28b348a5089e3d3aad916",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/baseline.json.supervisor.json",
        "supervisorSha256": "728b6bf74e5a714889cd6f960fd7d36b650c43c0a6ca6019117f4b524b3bdd9b"
      },
      {
        "phase": "mutant",
        "launch": 40,
        "resultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/mutant.json",
        "resultSha256": "4280fa1bc45f8371e94c1f5f8aa0c1fcd1ee8c0b541f238f651eed63510fe56f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/mutant.json.supervisor.json",
        "supervisorSha256": "24aaf2a151a8cb0058cdde690ff268e368a137166f348462fcdb357af9c86023"
      }
    ]
  },
  {
    "candidateId": "rt-0144",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/measurement.json",
    "measurementSha256": "468489f392cedd75a85b6b13892b12eae10028389e6e56223aedc3fedd874f13",
    "verdict": "killed",
    "reason": "Root and independent reviewer inspected the existing completion-materialization.test.ts:57 resolves.toEqual assertion. Reversing the account ownership comparison rejects the valid request instead of resolving with fenced:true. The original exact baseline passed, and the pinned original mutant produced that promise assertion failure. The original inconclusive measurement remains unchanged; this is separate corrective adjudication under the reviewed classifier.",
    "reviewedAt": "2026-09-16T05:14:17.646Z",
    "correctiveReevaluation": {
      "controlHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
      "originalSuggestion": "inconclusive"
    },
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "3366bc3c3d8e20136cf859b54eb4bc93de31fd677eca04383d3de526d8f01962",
    "phases": [
      {
        "phase": "baseline",
        "launch": 186,
        "resultPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/baseline.json",
        "resultSha256": "2e64d4871d966dfaddb1ed10522606c153b7a0de01a76c7843148a5ac6b312b8",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/baseline.json.supervisor.json",
        "supervisorSha256": "b53958ee197f0883cbc58c63bec3ac3820fe1ed988247c832efb1cbbebe96b38"
      },
      {
        "phase": "mutant",
        "launch": 187,
        "resultPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/mutant.json",
        "resultSha256": "c84275a14ab16f30c45c95afe844fe6de50f01566a09e73eaec55c004e419ab3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/mutant.json.supervisor.json",
        "supervisorSha256": "6d76ded81e26054477d9e8795160cacd8282fd82c36a454f2fc7d4c38708925d"
      }
    ]
  },
  {
    "candidateId": "rt-0157",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/measurement.json",
    "measurementSha256": "d6255dc9dace3bc04e63213ab38cf5b9668b9ac7d7df2c8ead8eb7f83910765a",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'applied', proposal: { …(1) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:243:20). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.141Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 188,
        "resultPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/baseline.json",
        "resultSha256": "bbf04e4f9036f3cab20b3311251c95ce9b3c663121e53563e6ae364e68c34451",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/baseline.json.supervisor.json",
        "supervisorSha256": "68dba6ebff53ca3e586dcdc5ec2cb7537f66f2f7f92010e0731b3e592148dcad"
      },
      {
        "phase": "mutant",
        "launch": 189,
        "resultPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/mutant.json",
        "resultSha256": "58e520a669d40f13e90897745453986f7ffdeec2040f3ba02a80ec3aa8aaf128",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/mutant.json.supervisor.json",
        "supervisorSha256": "d9db799e8c9068013954794c895614f296a84ecfddc2f0fa15fd39124ad5513c"
      }
    ]
  },
  {
    "candidateId": "rt-0158",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0158-XT18am/measurement.json",
    "measurementSha256": "732b34e2808787415320af5098309fdc6ed1bfbb6e69b3783994692cc836d38f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed location snapshot omits parent token during prepare and Apply. Both phases agree on absent parent, so later actual parent form update no longer stales the location proposal. Prepare remains successful. Observed: AssertionError: expected { kind: 'applied', …(2) } to match object { kind: 'stale' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:262:46). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.145Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 190,
        "resultPath": "/private/tmp/operator-continuation-rt-0158-XT18am/baseline.json",
        "resultSha256": "a52edcf8aac46ff19271420348796ce4c14c79c2dee11cb6e1e604894cfb4582",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0158-XT18am/baseline.json.supervisor.json",
        "supervisorSha256": "b4e04ddb7ad3b1cef415a7ebc2f51afb1430ac78cfe35706baa0592981a13a92"
      },
      {
        "phase": "mutant",
        "launch": 191,
        "resultPath": "/private/tmp/operator-continuation-rt-0158-XT18am/mutant.json",
        "resultSha256": "3df520611e3e0418c8a210165a581d0a59e7280a54db221c5e1cc54f88fbdfc5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0158-XT18am/mutant.json.supervisor.json",
        "supervisorSha256": "32394b624bbe6f2b86fffd6314820e8ed344665748e1be2cbfcb614f160bde4f"
      }
    ]
  },
  {
    "candidateId": "rt-0159",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/measurement.json",
    "measurementSha256": "2e288361acf9e38481642933099a390970e3db4801934e955e1fee316ec14cd8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:272:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.148Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 192,
        "resultPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/baseline.json",
        "resultSha256": "d67350e2271995613585fe334458c3be8faae52936e58351eea752b26eeaac16",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/baseline.json.supervisor.json",
        "supervisorSha256": "70177c2a08a2f99afea1282707d8b690a84a3af5974e6d854ed26890a969b507"
      },
      {
        "phase": "mutant",
        "launch": 193,
        "resultPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/mutant.json",
        "resultSha256": "abf046eb7d8a3b702df1f9b5d5effdbee660915a558600b4181c11b2a82fe33c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/mutant.json.supervisor.json",
        "supervisorSha256": "2911ef18bbf94af47363fcdca01c5e04c835fa01db236dc46ea40d31542b9a67"
      }
    ]
  },
  {
    "candidateId": "rt-0160",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/measurement.json",
    "measurementSha256": "8511259f892d8e4ee0cb45f67ad3d2778bbfdbe8428743cb2370b74678c77146",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:297:41). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.150Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 194,
        "resultPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/baseline.json",
        "resultSha256": "22700092fa9f624cd7881ebb911207801dc9a6c0df9bb93812b22451d23e93ac",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/baseline.json.supervisor.json",
        "supervisorSha256": "8e16f618691e40834f8973783f57a29fb2dea852caa9f9481cb0cfd80460329c"
      },
      {
        "phase": "mutant",
        "launch": 195,
        "resultPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/mutant.json",
        "resultSha256": "43ab5f4d747d182ec3541a27abbbbe252af1eb3964a731cffb8a908de140b8db",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/mutant.json.supervisor.json",
        "supervisorSha256": "688591361b19918c1980902170ccfa939a6e3fc594b12c0f9252ec1b07e25039"
      }
    ]
  },
  {
    "candidateId": "rt-0161",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/measurement.json",
    "measurementSha256": "cc4bc766aa66b4e51817e8d36dedc1d46aa32d46941ad874e1cdc36af3f65af4",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:322:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.153Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 196,
        "resultPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/baseline.json",
        "resultSha256": "c9f3c0b6a8e5f03a32313a945fa2a9417c21ed2087192075ee85bacdecb4022d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/baseline.json.supervisor.json",
        "supervisorSha256": "d91089e93554d3fdd4935b677deba82408c1247914f2cfaa5b3a14f080872547"
      },
      {
        "phase": "mutant",
        "launch": 197,
        "resultPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/mutant.json",
        "resultSha256": "17c2ed31c86d5f0b3573463c89b5a68e45ca0f9bcb964f3709bf822b410e4dbf",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/mutant.json.supervisor.json",
        "supervisorSha256": "7ddbf6421b5cf46c357b7f58723de658e5efe0c58275267f2e0425aeeffc12a2"
      }
    ]
  },
  {
    "candidateId": "rt-0162",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/measurement.json",
    "measurementSha256": "9b662fcc10a841d53bfe0930476679e5f0fe8b1da2df4a5147729414f0c01cad",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed executePolicyPlan still completes original refusal SQL/validation, then returns another valid ApplyResult. No additional statement or fixture queue shift. For 0138/0139/0140 this is the single remaining attempt. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'blocked' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:352:53). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.156Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "phases": [
      {
        "phase": "baseline",
        "launch": 198,
        "resultPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/baseline.json",
        "resultSha256": "20fa2e887455331e04d0bd8b7361709b2a124c7bac223a21ae703deb3c66f50d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/baseline.json.supervisor.json",
        "supervisorSha256": "72a205c0e70d90cbc6ae4820c68ff2137613e03842d5241e4f34f105415f1e33"
      },
      {
        "phase": "mutant",
        "launch": 199,
        "resultPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/mutant.json",
        "resultSha256": "9f5caf8714d914b5731e4ea89d347f7c79fc3da6be1261502b4f672f16fa6921",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/mutant.json.supervisor.json",
        "supervisorSha256": "396c63df8d1c92f29c8503b75b0fc7efa57a536049b72e85a2d9df7c2d1cccf0"
      }
    ]
  },
  {
    "candidateId": "rt-0164",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/measurement.json",
    "measurementSha256": "23de9f809104e55bd305df70514b7ebef9c5de7fdb28ba9cf3938fd1e9116e0f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted location snapshot omits override stamp consistently at preparation and Apply. Same-location/first-override form write then fails to move visible token; raw values stay valid and real account locking/SQL ordering remains intact. Observed: AssertionError: expected 'confirmation_mismatch' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.158Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 200,
        "resultPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/baseline.json",
        "resultSha256": "d0587c83ccfe5d0dca9c9034263e22f5508ba85677ebbe7436c7bda7ce95d2f5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/baseline.json.supervisor.json",
        "supervisorSha256": "402c414e544767ea7bdaf9794896373a601f62b0bc3961566b286d82ce7de347"
      },
      {
        "phase": "mutant",
        "launch": 201,
        "resultPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/mutant.json",
        "resultSha256": "8b802548af37cd48be01a9361e3290d3331cca511a0dec9ff3034e0303127eeb",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/mutant.json.supervisor.json",
        "supervisorSha256": "a5e558b370f6b9e6a6b5025e60cd21f63d38391deb287043a9a93e03e82389f5"
      }
    ]
  },
  {
    "candidateId": "rt-0165",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/measurement.json",
    "measurementSha256": "dc91b5c61af98c401dfc5b44841c89be6e266352618c55a2a0409e87d6a370ad",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted location snapshot omits override stamp consistently at preparation and Apply. Same-location/first-override form write then fails to move visible token; raw values stay valid and real account locking/SQL ordering remains intact. Observed: AssertionError: expected 'confirmation_mismatch' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:39:13.160Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 202,
        "resultPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/baseline.json",
        "resultSha256": "be8ad88a8d4ddd9abd5ae6bf547cee051f231b0bf3d711932a8aaf8d5d942435",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/baseline.json.supervisor.json",
        "supervisorSha256": "271ce65bad1c1a581a659b15c17e92eb1789b0e239cc4f485791da382fa21b43"
      },
      {
        "phase": "mutant",
        "launch": 203,
        "resultPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/mutant.json",
        "resultSha256": "047262eed0f8706e7c76fbb4a884f90ba286535d3acd4fec6de69667df7edade",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/mutant.json.supervisor.json",
        "supervisorSha256": "167724a76d02b669f07a9aa4b0d667b65bcf91812fec0a4830d83a5fc7e518d7"
      }
    ]
  },
  {
    "candidateId": "rt-0166",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/measurement.json",
    "measurementSha256": "14922a04048c79c08343d4acab85b5d0863569bdb4b715be9fd4654b5a03d060",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed locationSnapshotFields removes parent token both during fixture prepare and real Apply; concurrent parent default-only form update then fails to invalidate expected token. Parent locks/blockedQuery still run unchanged. Observed: AssertionError: expected 'applied' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:386:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.420Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 204,
        "resultPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/baseline.json",
        "resultSha256": "2a61fe0567fd1cf0f3a9708fbf72dd3f8e7fb9dbe1bcc71e482de7c75e99549d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/baseline.json.supervisor.json",
        "supervisorSha256": "0a88c95a90e9221cc468a8702de341121fe40143458d2871c42c9f27cd9429ad"
      },
      {
        "phase": "mutant",
        "launch": 205,
        "resultPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/mutant.json",
        "resultSha256": "e6064ff78c79d0892487a76eb884beec602a0e6e31fa5b03af7a759c2d88a35c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/mutant.json.supervisor.json",
        "supervisorSha256": "7e8cd9552fea08e2122855673c9aea2cd3e007c30761ad992b6ba51ab37d2d6b"
      }
    ]
  },
  {
    "candidateId": "rt-0167",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/measurement.json",
    "measurementSha256": "324cd7df8ba3900827cc0274d1fa5bf6903855f3c683ba974d527793cc269704",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted policy orchestration discards successful receipt result and returns valid not_found after preserving writes. Pending fixtures use prepare(), not Apply. Existing result assertion fails without setup exception. Observed: AssertionError: expected [] to have a length of 1 but got +0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:395:67). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.426Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 206,
        "resultPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/baseline.json",
        "resultSha256": "cade80d1e7bf2a0e38ae9be0d2cb5685620d84d3db244bb7dfe10e573e0155d1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/baseline.json.supervisor.json",
        "supervisorSha256": "0b73bbb546c83957384c81a3bc0fa6b6f26217507463c50113d9fd855cacf948"
      },
      {
        "phase": "mutant",
        "launch": 207,
        "resultPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/mutant.json",
        "resultSha256": "6775fb01c9cec3b67ebe26f7f48f727c88c8d5078b44bde342ce2f2c8c27871e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/mutant.json.supervisor.json",
        "supervisorSha256": "0fa8ccb02293e17bb1418e5bc01fb47d4718dc9fa1f658a9b3dd69e6e48fff25"
      }
    ]
  },
  {
    "candidateId": "rt-0168",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/measurement.json",
    "measurementSha256": "782cab2155253e7414b9549795b1941e04d230a88d1aeb0f7261b7140e27d5d6",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed policy success handoff discards the valid result after preserving receipt writes and executor post-callback contention hook. Source fixture uses prepare() only. The form still blocks and then completes normally. Observed: AssertionError: expected 'not_found' to be 'applied' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:417:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.430Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 208,
        "resultPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/baseline.json",
        "resultSha256": "cb61166183db40be0972b8e2f4949964476fa28889268d7dfcb0ae00def6e352",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/baseline.json.supervisor.json",
        "supervisorSha256": "87af819c7abb0823ab11952ada83bf07e41be7a1766c7dca910db162588bf60b"
      },
      {
        "phase": "mutant",
        "launch": 209,
        "resultPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/mutant.json",
        "resultSha256": "5797be07933e8fab1ed4c30cbf340c3ee11a60e8704ec5f46f0911f83a20d6fa",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/mutant.json.supervisor.json",
        "supervisorSha256": "dde6d1b398792ad9fd591051e68a3d576c87b5014cc79e03f645eb2bc498cc91"
      }
    ]
  },
  {
    "candidateId": "rt-0169",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/measurement.json",
    "measurementSha256": "7ecfcccc526f556e259f8dd9b17816ba7442ebbd83b84cb4b7f93a6ddcbfa37d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed executePolicyPlan still completes original refusal SQL/validation, then returns another valid ApplyResult. No additional statement or fixture queue shift. For 0138/0139/0140 this is the single remaining attempt. Observed: AssertionError: expected { kind: 'not_found' } to match object { kind: 'rejected', …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:435:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.433Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "phases": [
      {
        "phase": "baseline",
        "launch": 210,
        "resultPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/baseline.json",
        "resultSha256": "0cb29be397005a4944eafa21bbee8c4d4b55eb75af4b22fa47da9e9331b6294a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/baseline.json.supervisor.json",
        "supervisorSha256": "32ea113ba19530024fc2cc85cb9bb9d7032af5c88717401d9218a0e3db1507c5"
      },
      {
        "phase": "mutant",
        "launch": 211,
        "resultPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/mutant.json",
        "resultSha256": "12aef70ae6ab60e939c0788c8179046300781da6b5a37c034817752adcc41a7e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/mutant.json.supervisor.json",
        "supervisorSha256": "0e72fa72bfd610d520faa541b4abdc6160718f1b4214db6fca9324884e334cab"
      }
    ]
  },
  {
    "candidateId": "rt-0170",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/measurement.json",
    "measurementSha256": "37ae650350530c108bb7847da1b356806b8fdb8ee6d0a6769a9591a6db87074c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed location snapshot omits parent token during prepare and Apply. Both phases agree on absent parent, so later actual parent form update no longer stales the location proposal. Prepare remains successful. Observed: AssertionError: expected 'applied' to be 'stale' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:445:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.436Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 212,
        "resultPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/baseline.json",
        "resultSha256": "92c9e2684d6217ae1caaecb6e6c8aec632896f4937b8b06ccc7c092a365558e7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/baseline.json.supervisor.json",
        "supervisorSha256": "26b8ca5ca8a291ab764b16b0ab0e84c0757e71ad5bf2aad6f3d191964ee34f71"
      },
      {
        "phase": "mutant",
        "launch": 213,
        "resultPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/mutant.json",
        "resultSha256": "075c7a596be217993ad57f07d536a5e28e9161080c254282bfc77bb9f3c093ef",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/mutant.json.supervisor.json",
        "supervisorSha256": "52f074f63d418451e4dd3f1cca8e1ef9eb15cfb45cba05fac50ae7df4f4f2159"
      }
    ]
  },
  {
    "candidateId": "rt-0173",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/measurement.json",
    "measurementSha256": "83ba85df670970fddc4c70a43a759db40b6a080f44bcfcd1d0380dd5ada8c7a2",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields loses parent row stamp but preserves valid VersionToken and SQL. Both tests directly assert stamped location snapshots. Observed: AssertionError: expected { locationRow: { …(2) }, …(1) } to deeply equal { locationRow: { …(2) }, …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-state.integration.test.ts:478:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:11.438Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 214,
        "resultPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/baseline.json",
        "resultSha256": "f36fbe3c65911526817407f64722b78815aa87f8fbbfae7f811c1c670c7f4360",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/baseline.json.supervisor.json",
        "supervisorSha256": "25b61f4aa84e5e967772ffc80c2d78c1c94c98388de946fa31c5de2c056fe9a2"
      },
      {
        "phase": "mutant",
        "launch": 215,
        "resultPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/mutant.json",
        "resultSha256": "eb144939d4ed5694121db0982a03da38fedf3009fdef1db68ffd50e083dd1316",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/mutant.json.supervisor.json",
        "supervisorSha256": "c2cb2de9918e0927a89676c4592050a61822f865cb55aab0f5b0e18ab0c4936a"
      }
    ]
  },
  {
    "candidateId": "rt-0174",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/measurement.json",
    "measurementSha256": "d16713d9888e6b64b75ab19f3a2184e75be18c60ef16eb0de3058b6c05573804",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields loses parent row stamp but preserves valid VersionToken and SQL. Both tests directly assert stamped location snapshots. Observed: AssertionError: expected { locationRow: { …(2) }, …(1) } to deeply equal { locationRow: { …(2) }, …(1) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/policy-state.integration.test.ts:531:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.617Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 216,
        "resultPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/baseline.json",
        "resultSha256": "bbbb8e2d934e834340a2b2cfcebc219fb33e801d4532802875c738e802529cf5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/baseline.json.supervisor.json",
        "supervisorSha256": "08ecf50a879d174a77f00584d0d182c16991c26e23f2af36f490967a400e4b18"
      },
      {
        "phase": "mutant",
        "launch": 217,
        "resultPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/mutant.json",
        "resultSha256": "430e926ee14a731f9ad1cd8c105140334d43173ed1021442592a638d0a8dec12",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/mutant.json.supervisor.json",
        "supervisorSha256": "ffdc3c909baae225823b3b879d2999ab94fede7ea259a70f52023cc2697cdbf0"
      }
    ]
  },
  {
    "candidateId": "rt-0191",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/measurement.json",
    "measurementSha256": "c1a87b862ffeb8fccbcf5bb2d76ed7037618018deaeedf6f167cc2dbb1b9bc2e",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed shared policyCardFacts suppresses expansion friction while preserving valid proposal mapping. 0191 directly reads policy card; 0264 source fixture Apply is a contraction and restored expansion remains prepared. Observed: AssertionError: expected { …(21) } to match object { requiresConfirmation: true, …(3) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/proposals.test.ts:460:21). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.621Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "phases": [
      {
        "phase": "baseline",
        "launch": 218,
        "resultPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/baseline.json",
        "resultSha256": "2ea218be2345e5908a324b2974e47d8d41fe5bbacfc7bf86c21ed85857f77ed6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/baseline.json.supervisor.json",
        "supervisorSha256": "4cebd3cc8b98540043ff289ccf3a475375214ffed6f10c80cc3fdd4596afd02b"
      },
      {
        "phase": "mutant",
        "launch": 219,
        "resultPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/mutant.json",
        "resultSha256": "f720f17a6daafec69bfde560dc35e1d45cd003f20ffdeb551b05205be5a1612e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/mutant.json.supervisor.json",
        "supervisorSha256": "f57f0786497a55dff74ac8879d8bcd125ea7db2f23ea679847f8248b2e518a60"
      }
    ]
  },
  {
    "candidateId": "rt-0198",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/measurement.json",
    "measurementSha256": "d88e9692adaaf131450d27250e171bb694e096b47a3db2b30b6c9af94f648a83",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: The new hydration reference record binds every reference list to the first turn instead of its originating turn. All rows and ids remain valid and no query order changes. Test has two populated turns plus a quiet turn: processing turn two's highlight reference appends it to turn one's existing cards. Observed: AssertionError: expected [ { …(3) }, { …(3) }, { …(3) } ] to deeply equal [ { …(3) }, { …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:519:10). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.624Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "7b7f8b0247cd38477777183a5e8683f137fc256aed33af1dabdefbb379fcbc2c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 220,
        "resultPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/baseline.json",
        "resultSha256": "c7f2df3cb4635e0288aa7069859abee2280c3a5ae45137ca8ff730a2a1ae892f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/baseline.json.supervisor.json",
        "supervisorSha256": "9f6066fd2a2993621fda02289d6a98a0bbb7593252ef8d764fa1e5c9ba398709"
      },
      {
        "phase": "mutant",
        "launch": 221,
        "resultPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/mutant.json",
        "resultSha256": "f21fc5803b4209f20aa0e33585209d78e3097a6bf0d1928215b5664f140e1a4a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/mutant.json.supervisor.json",
        "supervisorSha256": "c2f8610425ffd83f4d6176befe822d2b2314f1889a665c33e16ee4b120697e72"
      }
    ]
  },
  {
    "candidateId": "rt-0200",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/measurement.json",
    "measurementSha256": "4927ce2b453c47a973d02e2f08650507346e4b47077bf9ece3e2bd41a501466c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: New hydration enumeration erroneously reverses its caller-owned array in place. This is a single array-order semantic mutation at an added line; hydration must preserve transcript chronology even when reference lists are empty. Source fixtures call createTurn/direct SQL, never this hydrator. Observed: AssertionError: expected 55 to be 6 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:592:39). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.627Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "phases": [
      {
        "phase": "baseline",
        "launch": 222,
        "resultPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/baseline.json",
        "resultSha256": "fd37e06b7a2985b4cec8f6421b14ae4c81ccd5ae4af82c6a8c5e0532b6230488",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/baseline.json.supervisor.json",
        "supervisorSha256": "61dafeb8c321e21d1aed482b3a0cd800741aa73e94fb40500e5fe605e8235d41"
      },
      {
        "phase": "mutant",
        "launch": 223,
        "resultPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/mutant.json",
        "resultSha256": "e6260aa8e8f65d4fc53b9b3a16295b26df6eb18fe944b9bc597a7b7bd7cde6b3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/mutant.json.supervisor.json",
        "supervisorSha256": "ce934b7136698574e774bedc14206253e6aec9bcacf95cd69a18146a13770c59"
      }
    ]
  },
  {
    "candidateId": "rt-0203",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/measurement.json",
    "measurementSha256": "3da1faed064755f7f94d798214b8d450f55572f838e889a807281881516e1e0a",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:741:75). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.629Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 224,
        "resultPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/baseline.json",
        "resultSha256": "364e0657bd5570101ee10addcf3888bd8579df22424cf25f68f6caf94333785f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/baseline.json.supervisor.json",
        "supervisorSha256": "d5d5dd7bc550e00e99a47498194a2a5bb8e49d12ae6f8139e3f3aaca33f3fb55"
      },
      {
        "phase": "mutant",
        "launch": 225,
        "resultPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/mutant.json",
        "resultSha256": "0f7a084cb2048c7c6f19fae5fc2261ffdc36a86e0c62e9eb1586fce0b05789de",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/mutant.json.supervisor.json",
        "supervisorSha256": "01f06de0fa9695fc684130f9dd9e4c922580d2fe5588e4754a6050ce15dc085c"
      }
    ]
  },
  {
    "candidateId": "rt-0204",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/measurement.json",
    "measurementSha256": "17115ab653ee1099141cd9f03a1bb6b1cba5ff57a8538d9c5a726c4d7dfb1e67",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:741:75). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.632Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 226,
        "resultPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/baseline.json",
        "resultSha256": "cd2e84a77264ca273a2bdbf0bc71a11f53523d689e9e08f63a2db382f11f61ba",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/baseline.json.supervisor.json",
        "supervisorSha256": "5b6d4e9ce66a34a538f85acd682028c58934ec6fefc81840650d08b39a7c471a"
      },
      {
        "phase": "mutant",
        "launch": 227,
        "resultPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/mutant.json",
        "resultSha256": "cf6c21cedf7b4b3631d1077cf3e377c4ebc510254c5bfd9038afa012ae88b9fe",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/mutant.json.supervisor.json",
        "supervisorSha256": "930508421f143770a953bef1dae819f8bb6b67dfd02d1d679faa1a88139af9c9"
      }
    ]
  },
  {
    "candidateId": "rt-0205",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/measurement.json",
    "measurementSha256": "ebc10c8c46caf1a9c70224d6828643b94821f35d6ad505625e048037ec4a6b90",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Added hydrateProposalReferences enumeration mutates caller-owned transcript array through reverse() before mapping reference records. Hydration must retain chronological turn order even for turns without proposal references. Existing test asserts per-turn data in transcript order; setup uses createTurn/direct SQL and is unaffected. Observed: AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:802:85). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.635Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "phases": [
      {
        "phase": "baseline",
        "launch": 228,
        "resultPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/baseline.json",
        "resultSha256": "3478035a0ecf1fd9bcdc92e0ab426f1169f546e9bceabc758e0607d915e907b2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/baseline.json.supervisor.json",
        "supervisorSha256": "692aa99994256089561b4002126504936dd125db875a20cbbfb6c386ccb6cd2b"
      },
      {
        "phase": "mutant",
        "launch": 229,
        "resultPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/mutant.json",
        "resultSha256": "dea7c3e5c53148b82d995bf1fa834caacff18111932e469ce7f536a9444161dc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/mutant.json.supervisor.json",
        "supervisorSha256": "3822ea8b2b547057c77b92c19a4f0bbc5bf41477bc0427c7d130d0562f239c19"
      }
    ]
  },
  {
    "candidateId": "rt-0206",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/measurement.json",
    "measurementSha256": "093ebf2553aedf46c35b7f2426d152062de9edbd68127c53bb8e45f858b983a3",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Added hydrateProposalReferences enumeration mutates caller-owned transcript array through reverse() before mapping reference records. Hydration must retain chronological turn order even for turns without proposal references. Existing test asserts per-turn data in transcript order; setup uses createTurn/direct SQL and is unaffected. Observed: AssertionError: expected [] to deeply equal [ { …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/reads.integration.test.ts:854:36). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.638Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "phases": [
      {
        "phase": "baseline",
        "launch": 230,
        "resultPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/baseline.json",
        "resultSha256": "4078dfbf16f9eff50fb1e081ae31e98ac744cbb629c505f7611ad75a12044142",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/baseline.json.supervisor.json",
        "supervisorSha256": "7193edb381808de0ed2d0f64915ab732c6f6aa78afc7b7146c693164e9ef7e70"
      },
      {
        "phase": "mutant",
        "launch": 231,
        "resultPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/mutant.json",
        "resultSha256": "5c1341ae3142ae496f87435b9c55a1bacc05580009fe1dc2845ef477147b75ca",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/mutant.json.supervisor.json",
        "supervisorSha256": "6c1007de10dcfa37a85a7d6beb3a30bc3ff0ef414433b6a3a1964ca07a1ed0ee"
      }
    ]
  },
  {
    "candidateId": "rt-0247",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/measurement.json",
    "measurementSha256": "1603c3d21f47a5ce38b67b278db3bfa0fb62bca571b8d6c6c3c1f6535e216760",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:94:43). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.640Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 232,
        "resultPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/baseline.json",
        "resultSha256": "ab2936ef3c39d2c2f35fa9872575ca9f0ff2209d4514c3fd074203ddd0c75db3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/baseline.json.supervisor.json",
        "supervisorSha256": "2b88cf121d770ec64c862d5ed63bb8b75c1363eb9dcc08ba4135f8e885f04add"
      },
      {
        "phase": "mutant",
        "launch": 233,
        "resultPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/mutant.json",
        "resultSha256": "04fb49f43644d3fe5dd5873ec32c9c3595aec7b537ccd4d3f3f89338d8693050",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/mutant.json.supervisor.json",
        "supervisorSha256": "16c935f076fb75e3e809155cd7cd2154a9c9e98ccd0b82303196d3d62d97aae1"
      }
    ]
  },
  {
    "candidateId": "rt-0248",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/measurement.json",
    "measurementSha256": "2f30611e16d6391af016984930810426075a70de0f785576a00e6ea0ea269337",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.643Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 234,
        "resultPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/baseline.json",
        "resultSha256": "fa4808ce1ccb851aabcb62e46b55d05c1d776b9b80f99ef54ff60d724e887e0f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/baseline.json.supervisor.json",
        "supervisorSha256": "74ffd74b357c0630ed76c1988ba018e5666e3042202ed85929d882115f538191"
      },
      {
        "phase": "mutant",
        "launch": 235,
        "resultPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/mutant.json",
        "resultSha256": "afbf2879eb7549ae8d758e36822eac46f0797fae98633c047224c730e2898924",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/mutant.json.supervisor.json",
        "supervisorSha256": "f051d904efd17f4d4483e0c56ba94c9866fe73104d44c116d0802359076bb08a"
      }
    ]
  },
  {
    "candidateId": "rt-0249",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/measurement.json",
    "measurementSha256": "71deb7a74938fe59b45d5c9005bd45bc16e588771bc27786f1aa6a9a6174d0c1",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.644Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 236,
        "resultPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/baseline.json",
        "resultSha256": "2a1fb0da03ec65bbb085afccf59f9f96cce97a2348293a9e0a848a06cb6d683b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/baseline.json.supervisor.json",
        "supervisorSha256": "2658e7c02adc966c4826e855ea411db14b11658ae1417c52a583ddd62088da15"
      },
      {
        "phase": "mutant",
        "launch": 237,
        "resultPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/mutant.json",
        "resultSha256": "1d9a9349316656f84c137fd9369fbfbb9a7c284a5d6e3b9aa7a2ccaec308d939",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/mutant.json.supervisor.json",
        "supervisorSha256": "b80dad4345fc29c6187c3b040579f85cc8614fe414b9d80cd3ac4c93b1b88e72"
      }
    ]
  },
  {
    "candidateId": "rt-0250",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/measurement.json",
    "measurementSha256": "1518e9e1d24face1149f48023df2129ad36fcdb0ba7f097028072df4769fc55f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed extracted deriveReceiptRestore drops the operation-owned inverse writer fields while keeping a valid typed result; direct unit calls use no setup application. Observed: AssertionError: expected { domain: 'voice', …(2) } to deeply equal { domain: 'voice', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:104:20). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:45:35.646Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 238,
        "resultPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/baseline.json",
        "resultSha256": "7124e1b9edc22863a061cf77668940fa3c93d586c47db6f4af95e171c84d7fa8",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/baseline.json.supervisor.json",
        "supervisorSha256": "010f41a0af1dce3c0c1cf59f71df37a514f9b266061b486300004b3e1fe9c145"
      },
      {
        "phase": "mutant",
        "launch": 239,
        "resultPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/mutant.json",
        "resultSha256": "b0812aab8650202287fa25681fb229cd7724a5f1b755e359318dfe55b359cb42",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/mutant.json.supervisor.json",
        "supervisorSha256": "26b816256c8c9e0c99f0bdcc0015d1665bafafb0f9c1d642eab639922053ca55"
      }
    ]
  },
  {
    "candidateId": "rt-0251",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/measurement.json",
    "measurementSha256": "52b79075e5304d4bfcd68b63cbd1d229d41397aca82fdbccbe35fe4f573273bd",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed inverse derivation swaps before and after, producing the forward state rather than restoration; valid schema and typed patch. Observed: AssertionError: expected { domain: 'policy', patch: { …(3) } } to deeply equal { domain: 'policy', patch: { …(3) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:112:66). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:46:21.437Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "phases": [
      {
        "phase": "baseline",
        "launch": 240,
        "resultPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/baseline.json",
        "resultSha256": "beffbcac2a12f63d562f4dc5a116ee9919e6dff92fb7e5df68dbfb7f44ab4290",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/baseline.json.supervisor.json",
        "supervisorSha256": "71cec6f8904aaac498d9d8ad0877ad892bdabd03e5b2ca92d9bc6b84b50c9c63"
      },
      {
        "phase": "mutant",
        "launch": 241,
        "resultPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/mutant.json",
        "resultSha256": "47a9395acd803c7ac08548ed29b575a0ee5311e3c184ead9709cfff9a27d5b44",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/mutant.json.supervisor.json",
        "supervisorSha256": "a3005c376c50de0104ceab212aa65c93493de29bf6eb1e946535325a7b465f43"
      }
    ]
  },
  {
    "candidateId": "rt-0252",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/measurement.json",
    "measurementSha256": "069e37a9b66644e33e775c05573c8113bf995f3db22475cf41125a29dfc5a70c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed inverse derivation swaps before and after, producing the forward state rather than restoration; valid schema and typed patch. Observed: AssertionError: expected { domain: 'policy', patch: { …(2) } } to deeply equal { domain: 'policy', patch: { …(3) } } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:127:58). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:46:21.439Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "phases": [
      {
        "phase": "baseline",
        "launch": 242,
        "resultPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/baseline.json",
        "resultSha256": "f9fee2ba9e5ffb8a513f16db1b871680d9b29eaecf1aa389d719ccc89cdbb4a3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/baseline.json.supervisor.json",
        "supervisorSha256": "16cb580ca4e3a31a28f3f0eefeb52e528e30fccd09cf38926dfcddbdfd2f4715"
      },
      {
        "phase": "mutant",
        "launch": 243,
        "resultPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/mutant.json",
        "resultSha256": "1cb324f91a3a81b36458db8ec6cb52a80fbae989c87927187c14ec3c558cc180",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/mutant.json.supervisor.json",
        "supervisorSha256": "8ea3a811ea4574e6cb08a9107a165876d27f4be46f425b033866fbe86c79a90b"
      }
    ]
  },
  {
    "candidateId": "rt-0253",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/measurement.json",
    "measurementSha256": "398d41231d5ecfe60b2adf6b60465913ad86a06bf173dc65c185f29f11caf64c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted receipt provenance gate drops same-account requirement. First invalid candidate otherwise has valid applied source and valid voice receipt; it now returns a derived inverse. Observed: AssertionError: expected { domain: 'voice', …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:154:76). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:46:21.441Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "be55aad0aae70450c8177e445acb9ab5ac4cfe92d34409cc73923055911df402",
    "phases": [
      {
        "phase": "baseline",
        "launch": 244,
        "resultPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/baseline.json",
        "resultSha256": "0155e5dbee99d690d5358e9c57ad4c3782e6dfe7bbad0f52bbc21ee9a5e48403",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/baseline.json.supervisor.json",
        "supervisorSha256": "c754e8f382022461d3893c2d60821c3f5b69d9fd7add020a8786f366e62c38f2"
      },
      {
        "phase": "mutant",
        "launch": 245,
        "resultPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/mutant.json",
        "resultSha256": "74feffbf665941b17721776fe2f061dbd4f1a94e357083d2d3ee77a831563c82",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/mutant.json.supervisor.json",
        "supervisorSha256": "2fe6f000f26582b086f3bb1646c51517de4b7dcf49a003f1527fbcd63db9dce9"
      }
    ]
  },
  {
    "candidateId": "rt-0254",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/measurement.json",
    "measurementSha256": "716fded192873d6ca184a02997eea1561a6fe0d4d93d2f74199b50575c0be033",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed deriveRestoreInput handoff fabricates an empty valid inverse for malformed receipt instead of refusing; direct test body assertion sees returned object, not a parser exception. Observed: AssertionError: expected { domain: 'voice', input: {}, …(1) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-inputs.test.ts:159:60). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:46:49.760Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "ef03e7dc61ed92b2b3c8c28f6f28f05e0276ebd5a9fe56a5a5d541b246ef040d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 246,
        "resultPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/baseline.json",
        "resultSha256": "598833922d3b1d22ef353781d518dcdacbe6cfb2e52b9553f84244e24aa7fa88",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/baseline.json.supervisor.json",
        "supervisorSha256": "018638b75e91384f88bed039b881fd01597fe2e49f460c9795c932cb68e6886c"
      },
      {
        "phase": "mutant",
        "launch": 247,
        "resultPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/mutant.json",
        "resultSha256": "678af259bbcc6513091fb4c5d136a822da2d00017172850e7a6df24247cf535a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/mutant.json.supervisor.json",
        "supervisorSha256": "3a6ff5ea8d260d4a3ff70843b23b885956ac6b0172b1fb072f5279e68d5adea8"
      }
    ]
  },
  {
    "candidateId": "rt-0255",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/measurement.json",
    "measurementSha256": "9eea781cbdb428b9cae4221df6f0e2335dd46aaf3afe4f7455da81040bb0b4bd",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:215:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:47:30.726Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 248,
        "resultPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/baseline.json",
        "resultSha256": "7b2a3099140511153184a61968217a7ca7290b5f28ea082b47cc95d1f32906ca",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/baseline.json.supervisor.json",
        "supervisorSha256": "ac248e56348382b17bf5ddc6830ced66a317e73d53ba5cf1067169c2e2033c6a"
      },
      {
        "phase": "mutant",
        "launch": 249,
        "resultPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/mutant.json",
        "resultSha256": "2d3502b457abc3ce74d6aa0cd85643c2cb06d5e96cb4a6d9c7d0d4961a1cc480",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/mutant.json.supervisor.json",
        "supervisorSha256": "30ca335f2ac711851aba22b365527c00fb5bc6e76cf0feafad0894280856ae46"
      }
    ]
  },
  {
    "candidateId": "rt-0256",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/measurement.json",
    "measurementSha256": "17a3aae5729aec867146ffe63bded75927ce49fd26f3ba557f8c8246198a5b8c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:215:25). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:47:30.728Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 250,
        "resultPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/baseline.json",
        "resultSha256": "5457ce65345d271518f7995be2c5e0fd222c48aa3265398f9e8280b164c95c70",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/baseline.json.supervisor.json",
        "supervisorSha256": "30bde4a77a83ec3139d197f28f3f7f2cb5d54915dc4c9faa783ed8457330b491"
      },
      {
        "phase": "mutant",
        "launch": 251,
        "resultPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/mutant.json",
        "resultSha256": "a33fb7349d5f822d3f9f34cb02b6e0452150884b7317597f3deb2e84560be27a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/mutant.json.supervisor.json",
        "supervisorSha256": "d5b38a22f2c26b93b3087155478c6d693f8c9c146899d400ddacbe4fc27e11b0"
      }
    ]
  },
  {
    "candidateId": "rt-0258",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/measurement.json",
    "measurementSha256": "4cc4f38a9646576668ef6b2a83aa323ef60141a4c377c8885d7a969e02cae4dc",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:47:50.959Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 252,
        "resultPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/baseline.json",
        "resultSha256": "60eb0b09a46e49ed7ba6457a0195632f7d649ca67036eb5f88609d15f3603c66",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/baseline.json.supervisor.json",
        "supervisorSha256": "d43fa309a6086685ad8e2e32a70b341645c063b6bd68177a89a82e68fa5410a9"
      },
      {
        "phase": "mutant",
        "launch": 253,
        "resultPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/mutant.json",
        "resultSha256": "9998f8fd4d9ac99812b332fe695740a6c028d9617f0aa503639f40972fe5e04c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/mutant.json.supervisor.json",
        "supervisorSha256": "e4ffc02fe8285ff68efe45d9045dc6f3f16e45d6af8a50cab516d936ef67f8f2"
      }
    ]
  },
  {
    "candidateId": "rt-0259",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/measurement.json",
    "measurementSha256": "cfda0676c376296917a7957d46abef1e68c089c0b02947179a329b2aea8613b3",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:49:05.667Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 254,
        "resultPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/baseline.json",
        "resultSha256": "c5c2cd8fff23ddd473f4cf4b60f93816cb2b98e4df22e6cd70068c558f955715",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/baseline.json.supervisor.json",
        "supervisorSha256": "603cdc31b633484a23600182fdd44740d1d401b6942c4ddfbc5a0cf4b587e73e"
      },
      {
        "phase": "mutant",
        "launch": 255,
        "resultPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/mutant.json",
        "resultSha256": "8188964bb203edab91fbdbbbcb09695497a47bd363188bbd0b1986b2ee33c3fe",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/mutant.json.supervisor.json",
        "supervisorSha256": "857a87f97a597fb16c97c3f37dfaa9d4d4eead3c5bede97db38ea467118178c3"
      }
    ]
  },
  {
    "candidateId": "rt-0260",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/measurement.json",
    "measurementSha256": "283cdd2d560d76c770c446ccb8261caea6b5a2b1ab1f53b770dcc73f6840f181",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource refuses validated source after all scope/source locks. Source fixture Apply never calls this helper. Restore transaction still executes and holds parent locks so contention harness proceeds; no setup error or lock timeout is expected. Observed: AssertionError: expected 'invalid_source' to be 'prepared' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore-locking.integration.test.ts:242:23). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:49:05.670Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 256,
        "resultPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/baseline.json",
        "resultSha256": "3d3103bee44e4d6a1fb71b510cd370d8e1835344a3250f858ca485729fd11f1c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/baseline.json.supervisor.json",
        "supervisorSha256": "bc255f5a4decd6a325d3e2da1f18624eb621cfd96eb465b2c20d1459c4d9a1db"
      },
      {
        "phase": "mutant",
        "launch": 257,
        "resultPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/mutant.json",
        "resultSha256": "897d564b1f5e4a6d7838aa2a27d6cae1c1aa26b2c39dcbf053f1336da639ef3a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/mutant.json.supervisor.json",
        "supervisorSha256": "77f5563131d0c1a57d135d485d1ed49168ca7cece7c2df5358eb151e3e6475a1"
      }
    ]
  },
  {
    "candidateId": "rt-0263",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/measurement.json",
    "measurementSha256": "23264ae66db1c638fff05a4c88780e024b6ee76fa8d0585b56fc2e7ce48ac877",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted policy Restore preparation misreports restored row existence in preview. Source normal Apply and restored() kind check still succeed; proposal remains schema-valid. Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:269:37). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:49:05.672Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "821841f59cf4124ff31513c27fb473eb2e3676508df64bb11046d86cd2fd0fa3",
    "phases": [
      {
        "phase": "baseline",
        "launch": 258,
        "resultPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/baseline.json",
        "resultSha256": "bf111ed58d26fe6a251484b8ae45f8473ce3a494d2e389776ec2571bf54374c4",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/baseline.json.supervisor.json",
        "supervisorSha256": "74318e443b463f9cd7296324f15bde99b6b57cc97fa189ac6b034561c29c9fc9"
      },
      {
        "phase": "mutant",
        "launch": 259,
        "resultPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/mutant.json",
        "resultSha256": "f7e7e215ff7efe485021aecf0fe4af18e6f24f241bab6e8b9df337f301b60fa2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/mutant.json.supervisor.json",
        "supervisorSha256": "7f84fd80018adaf8edab9647a7783da2b472b939c7b49f3b7d2d7a551265a9d4"
      }
    ]
  },
  {
    "candidateId": "rt-0264",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/measurement.json",
    "measurementSha256": "0a9bc8d0ba1d01394f30d2574dcdd00e687f9a9423ee469bd1c48847551eae8c",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed shared policyCardFacts suppresses expansion friction while preserving valid proposal mapping. 0191 directly reads policy card; 0264 source fixture Apply is a contraction and restored expansion remains prepared. Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:279:42). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:49:37.439Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "phases": [
      {
        "phase": "baseline",
        "launch": 260,
        "resultPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/baseline.json",
        "resultSha256": "2a5518092179dc53943c50d82645260de6041ae737978191a54f406a69d3dd9a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/baseline.json.supervisor.json",
        "supervisorSha256": "9cc30f6d902a3ffb35f158fad4e6846003aeb496a15f5a576103ea9f5b4eb8d2"
      },
      {
        "phase": "mutant",
        "launch": 261,
        "resultPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/mutant.json",
        "resultSha256": "f396f2e148dd40c01ac48799013999a887e1867b9ad6781eb2ff2391628dc147",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/mutant.json.supervisor.json",
        "supervisorSha256": "d24072e0c4bc506d006dcb3783a0234ecf1763267f72d94cb5d2532cae9431b5"
      }
    ]
  },
  {
    "candidateId": "rt-0265",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/measurement.json",
    "measurementSha256": "fcab951d9bb7cebd60abe51eb4eb47bb463de3232ab4fec31231b2b2b5b0aa1a",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted locationSnapshotFields hides parent policy stamp consistently in ordinary source preparation, source Apply, Restore preparation and Restore Apply. All fixtures remain valid because their own expected/current tokens agree. After parent-only form change, Restore Apply wrongly misses stale gate and reaches expansion confirmation instead. Observed: AssertionError: expected { kind: 'confirmation_mismatch', …(1) } to match object { kind: 'stale' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:309:9). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:49:53.122Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "phases": [
      {
        "phase": "baseline",
        "launch": 262,
        "resultPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/baseline.json",
        "resultSha256": "ddd01442d96f917d91a0e9940ff8d1dd7fd7abde92f1d9509c51155fa7ba3668",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/baseline.json.supervisor.json",
        "supervisorSha256": "91f58f4868be94cfc1007404ca6bd163620835e847f10b4fa92be7934b90d3d9"
      },
      {
        "phase": "mutant",
        "launch": 263,
        "resultPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/mutant.json",
        "resultSha256": "1a2aaff2c6426c65e0862d421c568aba47c3325c8a9e643033bc45d0e42f941b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/mutant.json.supervisor.json",
        "supervisorSha256": "3301972da60cffb83e7175611c7444f4a20895538a423c36c544186fd49040d9"
      }
    ]
  },
  {
    "candidateId": "rt-0266",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/measurement.json",
    "measurementSha256": "1b1db2b021e0d19f11213a27e58d88a10248cb23063451dd35c31ae62ed0b87a",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed reusable Restore handoff flips repeated identity after real reuse; source fixture Apply and first Restore are unchanged. Observed: AssertionError: expected [ false, false ] to deeply equal [ false, true ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:325:91). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:50:50.128Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 264,
        "resultPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/baseline.json",
        "resultSha256": "cc8a187f173ecef54a3470e1a0002657954a44b632ef35626306e55ec4783741",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/baseline.json.supervisor.json",
        "supervisorSha256": "7c879206ac776004c7691847fc5c1ce50ba02c1f9ce58316d167e2a9b56871b1"
      },
      {
        "phase": "mutant",
        "launch": 265,
        "resultPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/mutant.json",
        "resultSha256": "cc7b94365e6ccb6bf3db3013b10e9f4be2fb3504103aefdf7f2674ef10c281e1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/mutant.json.supervisor.json",
        "supervisorSha256": "3e8d4e857513b300b5cfca66e82c62a278a959409871a96ad9d15f9fbdc6ef1a"
      }
    ]
  },
  {
    "candidateId": "rt-0267",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/measurement.json",
    "measurementSha256": "ad83905f5bbf3772ccea6f1da6abda61937c843c81e2dc3f41d5aa5a0400a5c3",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed selectRestoreSource chooses oldest applied receipt. Source fixture preparation/Apply never calls this helper, so first failure is tested selection, not setup. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { Object (kind, proposal) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:349:22). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:50:50.131Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "phases": [
      {
        "phase": "baseline",
        "launch": 266,
        "resultPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/baseline.json",
        "resultSha256": "5a32fb9874aca5836da928100600d5891a2ac10ff6bac12afbb7177b8e86a612",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/baseline.json.supervisor.json",
        "supervisorSha256": "b5362eb04063c696c92af204a2c6eaef412c203d6d2b977ffd5adbf468b0f4c3"
      },
      {
        "phase": "mutant",
        "launch": 267,
        "resultPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/mutant.json",
        "resultSha256": "8581042874cfbfa594b8731c63edc607ba564a655295ffa0f64b3ae9bb6666a6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/mutant.json.supervisor.json",
        "supervisorSha256": "c7b628fc4f0711119c2d6186a277d16916537fc69b37410865113aedfa01f9e4"
      }
    ]
  },
  {
    "candidateId": "rt-0268",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/measurement.json",
    "measurementSha256": "8a6317070ce456a8bd16bc28088aad6e573719754e93c5d3475eee50a6343781",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource changes valid domain refusal after source lock. Pending source fixture construction unchanged. Observed: AssertionError: expected { kind: 'invalid_source' } to deeply equal { kind: 'not_applied' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:364:91). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:51:20.011Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "1b9ea457ae1f322e681e9c8902c1d4f98492d612300bb6ecff9d13983a84a323",
    "phases": [
      {
        "phase": "baseline",
        "launch": 268,
        "resultPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/baseline.json",
        "resultSha256": "d34ec822b27df5e4e715b47d411fd92ce06317b8bd4dadd7d0af5b33651edd90",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/baseline.json.supervisor.json",
        "supervisorSha256": "3be887c6f7d59e047e92bd73e196ecc4834c7a1ad6d2b294a385e3bda1f473b6"
      },
      {
        "phase": "mutant",
        "launch": 269,
        "resultPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/mutant.json",
        "resultSha256": "714366325a5ec16e1be5408b6cc6c7f1001dec1f7c5afc4eccbc39a9c9062480",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/mutant.json.supervisor.json",
        "supervisorSha256": "85a6bf30b403e75a1333517524dd75319d26976adb1f67e97510b84ed4e0cd96"
      }
    ]
  },
  {
    "candidateId": "rt-0269",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/measurement.json",
    "measurementSha256": "d115c637ce8d7186f663aae3e88b4178ef44f4b6a0fece2a267a48a55140f9f9",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed restoreCardFacts fallback falsely labels missing/corrupt source. Valid initial restore fixture never takes fallback, so failure occurs on asserted tampered-source readback. Observed: AssertionError: expected 'Restore: The source receipt is availa…' to be 'Restore: The source receipt is no lon…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:385:30). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:52:10.009Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 270,
        "resultPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/baseline.json",
        "resultSha256": "5a480e3248c335acbb083d9ec8edbb14b5c2fcf46bdeb66972db98399c0360bb",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/baseline.json.supervisor.json",
        "supervisorSha256": "b257ca10158479a12ae3e00d8f357e819d8d1eca13837a763c6e0c75c1c21f5c"
      },
      {
        "phase": "mutant",
        "launch": 271,
        "resultPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/mutant.json",
        "resultSha256": "7f03e7abb621ba9819326803265c7e9978fd07992e383f337a7bd4a66d0d6a37",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/mutant.json.supervisor.json",
        "supervisorSha256": "c013060582c0249e9cac10b157e94d2437842dc2006109725fd845340e956315"
      }
    ]
  },
  {
    "candidateId": "rt-0270",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/measurement.json",
    "measurementSha256": "916349a9d8924981933447a0377eb4d1839ec3ba05d2f5bd5d6804a2d2cb47bb",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed restoreCardFacts fallback falsely labels missing/corrupt source. Valid initial restore fixture never takes fallback, so failure occurs on asserted tampered-source readback. Observed: AssertionError: expected 'Restore: The source receipt is availa…' to be 'Restore: The source receipt is no lon…' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:404:8). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:52:10.011Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 272,
        "resultPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/baseline.json",
        "resultSha256": "6445a22f649766f56ce79dbdbdd75949f680c67da44c00268b232f9c5e726ed7",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/baseline.json.supervisor.json",
        "supervisorSha256": "4857024d6255261e0493a590a2cc9da7bc004da10d612d07527d953751b514e1"
      },
      {
        "phase": "mutant",
        "launch": 273,
        "resultPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/mutant.json",
        "resultSha256": "4ccb344949f6b4cf7b0c51e107ec9d92955e9e36661e574bd3e128e2f8ac79a3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/mutant.json.supervisor.json",
        "supervisorSha256": "2a2f9f87ed9c83fe5a5dbf95606614ab7b6a776be6366ae546d0af978239fd15"
      }
    ]
  },
  {
    "candidateId": "rt-0271",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/measurement.json",
    "measurementSha256": "48b530a9ebf2c16187649313bd243aa0094b85d340448e59be25ed9dee64e3e5",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed hydration reference extraction drops reused proposals. Source fixture preparation bypasses hydration; owner GET test then lacks referenced card. Both inside/outside transcript rows still execute same account-scoped reads. Observed: AssertionError: expected [] to deeply equal [ Array(1) ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:459:62). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:52:29.794Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "phases": [
      {
        "phase": "baseline",
        "launch": 274,
        "resultPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/baseline.json",
        "resultSha256": "f998a244eab1f7ed841d38afa455993decf42722bd80d153333713ce6d8e521e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/baseline.json.supervisor.json",
        "supervisorSha256": "b2f72849eaa7fbf5e19750dd8e79bdbfa8fca6a79962bb1f0e87ba0b1ec524cf"
      },
      {
        "phase": "mutant",
        "launch": 275,
        "resultPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/mutant.json",
        "resultSha256": "adc00ee8207c4ee3f6ed94f40d9c66a94733b5701d0b7cd2c87d7c207b16c224",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/mutant.json.supervisor.json",
        "supervisorSha256": "de0a3b065a873f026f65776e85b3e32d2364ad723e0122d6022e466e01e58e78"
      }
    ]
  },
  {
    "candidateId": "rt-0273",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/measurement.json",
    "measurementSha256": "9b47c48032e02689ec031657f7017b4e7dd25eb3cbe69030c3d3d71dbeba7f86",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Dropping the Restore daily cap causes the successful Restore retry under test to return confirmation_mismatch instead of applied (restore.integration.test.ts:524, through the applied helper assertion at line79). Source fixture application completed normally. The failure occurs before the final persisted-cap assertion. Observed: AssertionError: expected 'confirmation_mismatch' to be 'applied' // Object.is equality (at applied (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:79:23)). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:54:15.346Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "013a4fafec8ba59d34d28535eb1fa89e084f9b5ef5363c8ed923c937959049be",
    "phases": [
      {
        "phase": "baseline",
        "launch": 276,
        "resultPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/baseline.json",
        "resultSha256": "435d69befb577d3b586b2d5e5e5970d01e7a0f8b0d13e2d7e20712a0d8057f28",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/baseline.json.supervisor.json",
        "supervisorSha256": "11470202564ef58bb25cade1208223fffbaca7bc9fd6596d95317aa5f7151426"
      },
      {
        "phase": "mutant",
        "launch": 277,
        "resultPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/mutant.json",
        "resultSha256": "23866cad9414a21ad62177de986cd28ef20c5d6776c0ba7982785bd8016cf415",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/mutant.json.supervisor.json",
        "supervisorSha256": "2286f160c0b0cdb182a8da87a90de3aea1530ebeae527b8e02604fbd2e1bd576"
      }
    ]
  },
  {
    "candidateId": "rt-0274",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/measurement.json",
    "measurementSha256": "b2471852087d8ccde7f65442211bbf475105853685cad0154de627b3c5707e86",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed reusable Restore handoff flips repeated identity after real reuse; source fixture Apply and first Restore are unchanged. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { kind: 'prepared', …(2) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:559:22). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:54:29.924Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "phases": [
      {
        "phase": "baseline",
        "launch": 278,
        "resultPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/baseline.json",
        "resultSha256": "bbe42881c1e0416f8bab930d4fbc5f03c6c74238e3ea38f94ed07eeb0fffbaa2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/baseline.json.supervisor.json",
        "supervisorSha256": "4e76c315b69d31f015d9d393bd5aaa1594f8859f4db83a4e97bc252fcda6d042"
      },
      {
        "phase": "mutant",
        "launch": 279,
        "resultPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/mutant.json",
        "resultSha256": "ae42f61b09eccf9559b2ab51f6bf6dc86073f15d64711b739cc831d7540f9dbd",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/mutant.json.supervisor.json",
        "supervisorSha256": "7dc90625f649d7fb80c6df062e9b8859425cc3899eb205549440392a6c0c01ba"
      }
    ]
  },
  {
    "candidateId": "rt-0275",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/measurement.json",
    "measurementSha256": "e1a1dbad20033fe7fe6e4df7f4242760e1b193a235bdc574f8cd8eef48b58590",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed selectRestoreSource chooses oldest applied receipt. Source fixture preparation/Apply never calls this helper, so first failure is tested selection, not setup. Observed: AssertionError: expected { kind: 'prepared', …(2) } to match object { Object (kind, proposal) } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/restore.integration.test.ts:599:23). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:54:29.926Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "phases": [
      {
        "phase": "baseline",
        "launch": 280,
        "resultPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/baseline.json",
        "resultSha256": "22964c94a2c09caa660c44a1997842b059ec8a7e365cdc7e5510a6cf18563907",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/baseline.json.supervisor.json",
        "supervisorSha256": "56e805cc24e657652faf236bd3963baf23b007b216d47c2f31735552f90a1fc1"
      },
      {
        "phase": "mutant",
        "launch": 281,
        "resultPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/mutant.json",
        "resultSha256": "7a8e4104bbc5a919b34fd305f44012dcc283dbddeb75b1c547faa0c54c68cbb1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/mutant.json.supervisor.json",
        "supervisorSha256": "6130e6c2858ab3f53dc4934cc0e5a04eb18b06cea90d3ee0223ad1ede5941943"
      }
    ]
  },
  {
    "candidateId": "rt-0280",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/measurement.json",
    "measurementSha256": "71dc61b45b6d22c7228bd418a4296442a036d7566e93ca7caf8286f886449a5d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Changed resolveRestoreSource returns invalid_source after validated lookup; seedAppliedTone performs ordinary Apply only and is unaffected. Worker then materializes Restore unavailable notice instead of requested Restore card and completes normally. Observed: AssertionError: expected undefined to be 'pending' // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:385:32). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:55:33.729Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "phases": [
      {
        "phase": "baseline",
        "launch": 282,
        "resultPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/baseline.json",
        "resultSha256": "c32b577467124a99e6923f376b74bb997e1f3cc86ae322a2ea1633e7c961a33b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/baseline.json.supervisor.json",
        "supervisorSha256": "0b1220f437412ec7fe4edc545567ae2831db3992291f773c744a58d84963be40"
      },
      {
        "phase": "mutant",
        "launch": 283,
        "resultPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/mutant.json",
        "resultSha256": "e1e1fb1866905c65811d39cacec17a96cb59c6c7e35009ae5f2c21df27b2c52e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/mutant.json.supervisor.json",
        "supervisorSha256": "6231e6f8756859112ec971d2c3ac8c461bf56fc5e81abad4998aa33b8005e9a2"
      }
    ]
  },
  {
    "candidateId": "rt-0281",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/measurement.json",
    "measurementSha256": "f7f2db7f69157eedb97f0c18f517eb542442646ecee452524197423f0bf1f581",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: changed proposal-reference extraction destructively consumes the original rendered segment array instead of reading it. A realistic collection-mutation regression: same typed references computed, no fabricated IDs or throws. getTurnForOwner builds independent refused array before hydration, so original segments becomes empty while refused remains populated. Only actual GET exercises mutation; worker setup has no owner GET. Observed: AssertionError: expected [] to deeply equal [ { type: 'refusal', …(3) } ] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:435:32). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:55:33.732Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "b211236749d20fe94cb5f2156dbb077841a9854d50aa0de281f66eca732173f3",
    "phases": [
      {
        "phase": "baseline",
        "launch": 284,
        "resultPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/baseline.json",
        "resultSha256": "309d13a010a8d1ae7ad87ae9eaecd8e32414ec3040d0816d8c6b674ed682587b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/baseline.json.supervisor.json",
        "supervisorSha256": "ad5f58225409702b07885572470e33400fa1c5538b1890166d4dcbc68e2d938f"
      },
      {
        "phase": "mutant",
        "launch": 285,
        "resultPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/mutant.json",
        "resultSha256": "7354997513a7c4ded73ef882e8c4c83d180979c824c460cdd91ab22338d086b1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/mutant.json.supervisor.json",
        "supervisorSha256": "1f5592279b63cc5602e51bcd1771d317976a5f6c166c51c0b5f38b9d21545896"
      }
    ]
  },
  {
    "candidateId": "rt-0283",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/measurement.json",
    "measurementSha256": "b8094077382a0930bfb4dc9a2d72e69371370ffd49817e760d1585d41d358fe3",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Dropping the worker owning turn inserts the prepared Restore under the historical turn. The existing in-transaction probe at turn-worker.integration.test.ts:480 sees zero proposals instead of one; its AssertionError then fails the expected SQL22012 rejection assertion at line488. This is the target completion behavior, after normal source setup. Observed: Error: expected AssertionError: expected [] to have a len… { …(3) } to match object { code: '22012' } (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:488:12). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:56:15.950Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "phases": [
      {
        "phase": "baseline",
        "launch": 286,
        "resultPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/baseline.json",
        "resultSha256": "fcff0da86c802b86d9c94360fc801562a6add5f9bd3d82cb4c10c09bbc063e1d",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/baseline.json.supervisor.json",
        "supervisorSha256": "63c5b1d2fd1d42c043dc893fdb6b0bde33ff066c88efa5bd17bf15d94a2252f7"
      },
      {
        "phase": "mutant",
        "launch": 287,
        "resultPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/mutant.json",
        "resultSha256": "18de5f74176e0a1939f3587ec06db8a0a33bf2a0dfcdc2b5c613482e1bcdd933",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/mutant.json.supervisor.json",
        "supervisorSha256": "af8c011f5b21f5be562a480df851acc1c008858ad38dd7af8280d5836e58707c"
      }
    ]
  },
  {
    "candidateId": "rt-0284",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/measurement.json",
    "measurementSha256": "0831d93f41814b736c5017e8ec6c2fd945eb38492b7fbd2fc2d15eb209ee37ba",
    "verdict": "killed",
    "reason": "Skipping Restore processing after successful request validation produced an empty reply instead of the restore-unavailable notice; the explicit reply equality at turn-worker.integration.test.ts:506 failed after the awaited worker call completed.",
    "baselineResultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/baseline.json",
    "mutantResultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/mutant.json",
    "reviewedAt": "2026-09-16T04:09:34.343Z",
    "correctiveAdjudication": {
      "controlHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
      "originalSuggestion": "inconclusive",
      "rule": "Count failed test files instead of nested describe suites; original result, receipt, measurement and launch records unchanged."
    },
    "sourceHead": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "b3751f4b6ebc7950c5ecd8112cb7e5ee64546b5c9762ebbedc6de4cbfc55f41a",
    "phases": [
      {
        "phase": "baseline",
        "launch": 41,
        "resultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/baseline.json",
        "resultSha256": "5a5f2fd067d67ce4f7df0bb6e5320b16e02e32f574c9d57d1b1cc0a56ae79cb5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/baseline.json.supervisor.json",
        "supervisorSha256": "881442293ca22b4b5742bdd5ec2a86f6d7ecd0edb81c077e0853fcc3c96e835c"
      },
      {
        "phase": "mutant",
        "launch": 42,
        "resultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/mutant.json",
        "resultSha256": "450d54a69faed9a3f250da190d1514708145124ebd4665b57d48fa1326cc7fe3",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/mutant.json.supervisor.json",
        "supervisorSha256": "6cff2045cd2ab334f208e31fff9a49a5869f211b46d9fa4ad7e7094f37faf27d"
      }
    ]
  },
  {
    "candidateId": "rt-0285",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/measurement.json",
    "measurementSha256": "11e4d878d3952c3795a5c9f77ae5e3b37afcf44447839ade0078f42c5c04214f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted resolveRestoreSource drops the worker's owning turn and returns the historical source's owner. seedAppliedTone uses ordinary Apply and is untouched. Restore still passes owningTurn validation, inserts a valid pending row, and holds the original scope/conversation locks; the row belongs to source turn rather than completed turn. Observed: AssertionError: expected [] to have a length of 1 but got +0 (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:568:103). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:56:49.416Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "phases": [
      {
        "phase": "baseline",
        "launch": 288,
        "resultPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/baseline.json",
        "resultSha256": "17d619058b0018fcb1fc92d0270c1832cf9b8d2736940fac7e58b6f320e40e05",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/baseline.json.supervisor.json",
        "supervisorSha256": "90ff47ab2dfbd5dc5ddb0be44466c7ac9d1e4a0d88ca623b0ae1bbf807d05863"
      },
      {
        "phase": "mutant",
        "launch": 289,
        "resultPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/mutant.json",
        "resultSha256": "7fba60443f10df78780696626190ebe85f62840783c03319e8ba04785d9cf854",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/mutant.json.supervisor.json",
        "supervisorSha256": "04c26cd5f6e77b3487533a72fe6e2104078ced768620be192e704fa42290b627"
      }
    ]
  },
  {
    "candidateId": "rt-0333",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/measurement.json",
    "measurementSha256": "ad08362ca9109375b6893c577c8b6771995eb86def3d0582cf3ea3b29c5efa1f",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 3 to be +0 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:121:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:56:49.419Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 290,
        "resultPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/baseline.json",
        "resultSha256": "3cfd0b9e485227c906d0701fc596c53c6d56949e83b2eddb587b789e154d0bc1",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/baseline.json.supervisor.json",
        "supervisorSha256": "c1f2b4c1efaeee897f58166999cbb86e8c1a48283a71e0e1289009613ec48673"
      },
      {
        "phase": "mutant",
        "launch": 291,
        "resultPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/mutant.json",
        "resultSha256": "6216e9781be9ba6c1fc3bcad2a0a8a944480d52dd8a92a064ecd33ed94e85fc2",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/mutant.json.supervisor.json",
        "supervisorSha256": "e14a72f25780a5ffa8aad39a585cbe075d20a8f56c6458631b79ef82e248ffb3"
      }
    ]
  },
  {
    "candidateId": "rt-0335",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/measurement.json",
    "measurementSha256": "db9165e66a8500bec47ac792478a54e63a9b30d85bdc8b3b662a370ba121f6d9",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 4 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:173:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:57:12.207Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 292,
        "resultPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/baseline.json",
        "resultSha256": "243aa92a85de843d105e70b3788741005f05f345f26d8271588191fd942b809b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/baseline.json.supervisor.json",
        "supervisorSha256": "67b0afc63f7bebd3a0876c96a359ea075c841e04aee019fcc238bd62c221c496"
      },
      {
        "phase": "mutant",
        "launch": 293,
        "resultPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/mutant.json",
        "resultSha256": "3884f5ab46351e721db8e05b91a97d76317141dcb3eb9ff555b05be2711ca258",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/mutant.json.supervisor.json",
        "supervisorSha256": "7eec7ca035697f707162ced262d9c053d8b04e3904614a8fe7421eab3fb085e9"
      }
    ]
  },
  {
    "candidateId": "rt-0336",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/measurement.json",
    "measurementSha256": "2bd5a46e26cab4074ced651055a23a1bbe25a555bef9e451b57b9db9dd4134cf",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:196:42). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:57:33.847Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 294,
        "resultPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/baseline.json",
        "resultSha256": "7cb4b3ef4fe33121d496c0dc3d6ddf70d3d87c4f5e665829786dec68add8af45",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/baseline.json.supervisor.json",
        "supervisorSha256": "90975b0183e5157771349e1f7cf1a4e9f628224b7c4c6f634843bf3c8a8a3d80"
      },
      {
        "phase": "mutant",
        "launch": 295,
        "resultPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/mutant.json",
        "resultSha256": "c66a66e8d1d4652606c99f1d1b7016bcff44fd81397ff7c53db16ae6f0897e24",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/mutant.json.supervisor.json",
        "supervisorSha256": "1c354d0bf22c124383410570245324a25c8efc2612e95207184b049a59255540"
      }
    ]
  },
  {
    "candidateId": "rt-0337",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/measurement.json",
    "measurementSha256": "1ce3dd57898d0566c30999be9b749c7f7dabc016a2d95fa5f7131bd019f3c8f8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted shared reference checker incorrectly resets accumulated semantic failures before checking presentation. Caller appends checkOperatorProposal failures immediately before this helper; dropping those is an extraction-boundary regression. Subsequent validator failures have different text. Observed: AssertionError: expected [ Array(1) ] to deeply equal ArrayContaining{…} (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:212:31). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:58:06.231Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "d8394df94511c09d3cb5de691f3a0c2afd1326ccfdeb7a3060078349867b6c53",
    "phases": [
      {
        "phase": "baseline",
        "launch": 296,
        "resultPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/baseline.json",
        "resultSha256": "86518112617e8fe0a26bcad3691063e671bf041b803e14b7a921db3fa8206527",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/baseline.json.supervisor.json",
        "supervisorSha256": "cb465ec900ad508620ec4be17661552d8e02b1ef068515a0863772aed723128a"
      },
      {
        "phase": "mutant",
        "launch": 297,
        "resultPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/mutant.json",
        "resultSha256": "8a789d40837cd39d5f346b66ea884633bd22935266208abf5770c7a8a6d3569a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/mutant.json.supervisor.json",
        "supervisorSha256": "0da996ac4b5fd7c1eb5a88ff0e248b4468dd3c3f4e527796352b15cf5829e206"
      }
    ]
  },
  {
    "candidateId": "rt-0341",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/measurement.json",
    "measurementSha256": "5a3b9dcebe57b377a3456a31080b538314cc4d7e325f2fbdf0afd37114506ec8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected 4 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:268:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:58:40.412Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 298,
        "resultPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/baseline.json",
        "resultSha256": "c9be2b8fe9155fa462c93f36f9cde5f0229c8720d015747e480f1ddcd8c3e078",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/baseline.json.supervisor.json",
        "supervisorSha256": "29ec648f6ec049eb7ce92e0bce13ef98ab77b8b9f55f1386bd49d6f5af5e853c"
      },
      {
        "phase": "mutant",
        "launch": 299,
        "resultPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/mutant.json",
        "resultSha256": "2279bf35d942b79ef0838ed9b4a2912b3855f593e4a12b1c566456900fe85c5e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/mutant.json.supervisor.json",
        "supervisorSha256": "f601b5d4e6932c5d088684f4d62a7a54a3ff3e0a29b8c89b01dfa4ec33a4aea5"
      }
    ]
  },
  {
    "candidateId": "rt-0344",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/measurement.json",
    "measurementSha256": "e045c2fd0167d2b7d9d53f096811b63a7bb468efa4bee647dbaf099f6ca959d5",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected [ Array(1) ] to deeply equal [] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:311:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:59:02.918Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 300,
        "resultPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/baseline.json",
        "resultSha256": "b5fc0c7906703a61b2fb028a277e459351e25bb5c64cc8527c00065d1d3b3a96",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/baseline.json.supervisor.json",
        "supervisorSha256": "0194c76c04a3e141ae5b59d7559a9827588ab18429da5172886603349f764930"
      },
      {
        "phase": "mutant",
        "launch": 301,
        "resultPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/mutant.json",
        "resultSha256": "eaa22e48c52981b18e0eff441b974f99bc08b79c7aaf71b7aa900c991a56f405",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/mutant.json.supervisor.json",
        "supervisorSha256": "7d99a956d727309e3d781c0fd045789c0272932d4d1c471971bebc02ea43ca73"
      }
    ]
  },
  {
    "candidateId": "rt-0345",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/measurement.json",
    "measurementSha256": "37f400f21c8508fe523cf6a139a14360b63aacecfc98721c3cb97fc81536f9b8",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Extracted checkProposalReference reverses valid-card reference predicate. Existing valid mocked provider outputs are evaluated normally and gain semantic failures; no provider/setup error introduced. Observed: AssertionError: expected [ Array(1) ] to deeply equal [] (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/tests/llm-eval/__tests__/structured-runner.test.ts:311:35). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T04:59:42.023Z",
    "sourceHead": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 302,
        "resultPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/baseline.json",
        "resultSha256": "3cbeb19ae52b696c34911dbbcc4a235e90b6e299c06a4ff454452e7b2f4230fc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/baseline.json.supervisor.json",
        "supervisorSha256": "b7e816b55e4b0ef2623d7147cf5064d4d17ca23af6911720a19578d94632968b"
      },
      {
        "phase": "mutant",
        "launch": 303,
        "resultPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/mutant.json",
        "resultSha256": "cab9fbb6b96455dfb20513d1eb67091beb3438bc8a071c71f4bba5644a6884fa",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/mutant.json.supervisor.json",
        "supervisorSha256": "af0959a6c210c41ab1b5687616d8b89f53b8caaf34189cf84bbf1667dbb9acda"
      }
    ]
  },
  {
    "candidateId": "rt-0502",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/measurement.json",
    "measurementSha256": "c4cf19122b9c4bc6e7e851622ad845cdac48620737222933612ba1da9d8cd7c6",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Off-by-one rejection of the last authorized launch Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2276:49). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:22:34.941Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "c7633515f52733fbd1b4026d65744b3f7b710d60cb99954c871d580125d5e6c7",
    "phases": [
      {
        "phase": "baseline",
        "launch": 325,
        "resultPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/baseline.json",
        "resultSha256": "32c9205c2b37521b7ac3e88b8cb0f59b972ab78b5708a7724fa7aacf32995a2f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/baseline.json.supervisor.json",
        "supervisorSha256": "5b5b4d16073f618a7c8e87e86069938448ac2b6260174eaef050b2d3ff9db9ac"
      },
      {
        "phase": "mutant",
        "launch": 326,
        "resultPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/mutant.json",
        "resultSha256": "4a418667aec7b44ccf22467150171827076ddcf2d724ff76cd2ad0f1ad841826",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/mutant.json.supervisor.json",
        "supervisorSha256": "bd8f236ebc1e3f8dcc68065229bbe68ccab039cc50fd283c7ca673b68f8369f7"
      }
    ]
  },
  {
    "candidateId": "rt-0503",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/measurement.json",
    "measurementSha256": "eb2a60c44ee6d2a26922ecdef3bbf6596a58f57fcac6772121ece890894c00e7",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Accept a zero-millisecond continuation timeout Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2314:50). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:22:34.945Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "80d3ccb3838405b083c2a620f9f45138c68cb17c0859c0c15c0c0d1a081ef5b8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 327,
        "resultPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/baseline.json",
        "resultSha256": "c2d5892031dfea4907d803db852662da82109cc184943422aae53788e7948bd8",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/baseline.json.supervisor.json",
        "supervisorSha256": "8653fb1be31eca0b606b5120db91ac15f97817c0787cce45b729943b6539113d"
      },
      {
        "phase": "mutant",
        "launch": 328,
        "resultPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/mutant.json",
        "resultSha256": "3479939a9994a7dcd18eed25e55cd8db78e1e71dcfd5b0f0fb0e62418ddfdd4e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/mutant.json.supervisor.json",
        "supervisorSha256": "af74f46c5fcf7c32323f9ce1e98879524b15497f07e8679ceee0eab20945eb86"
      }
    ]
  },
  {
    "candidateId": "rt-0504",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/measurement.json",
    "measurementSha256": "2d27bf10571d3be561cd3bd370ad4bcd2acd67d035eb46b4ef59684f052e13c1",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Forget the original mutation-journal prefix Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2324:95). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:23:06.061Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "4ad465f37870127d0a3be2a59caf132adbbf5aa4a3bbebfb6cc5a4a5f0c45133",
    "phases": [
      {
        "phase": "baseline",
        "launch": 329,
        "resultPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/baseline.json",
        "resultSha256": "96347a6f3788b000098d68b6005ca059a5a93bfc67516967f98c81eb159b5b2a",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/baseline.json.supervisor.json",
        "supervisorSha256": "ef2404c31a8890e7324139561bfff5773f51c99c2f49e26dc3619de6fedc227e"
      },
      {
        "phase": "mutant",
        "launch": 330,
        "resultPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/mutant.json",
        "resultSha256": "ea9e7403c5bbd280204b35fae322635d4422445151fa60a8bf296b5bdbfcd9d9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/mutant.json.supervisor.json",
        "supervisorSha256": "ae571fc9a64dd6396882e38f31dec8dcf4e173e88f464549245d7d7d77cb6968"
      }
    ]
  },
  {
    "candidateId": "rt-0505",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/measurement.json",
    "measurementSha256": "d759710362103b62657339418d579b9001cb928a3540147bf3ccdac49b400a4d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Ignore the legacy mapping semantic-attempt number Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2389:97). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:23:52.725Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "05ddec2a63728c62bd200a0d340c8bbbd0fec144bc3d35ef3404844b66375d42",
    "phases": [
      {
        "phase": "baseline",
        "launch": 331,
        "resultPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/baseline.json",
        "resultSha256": "7c602a5491ee67a9b8c9ab4a91811b08b6bacc15432394b10b963b5c7c9673bf",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/baseline.json.supervisor.json",
        "supervisorSha256": "0b889ab68d36402d39fdb4b896883373d4f2e56a072b21f080baca96e5328e00"
      },
      {
        "phase": "mutant",
        "launch": 332,
        "resultPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/mutant.json",
        "resultSha256": "26f959d093a8563d48218a891c526bf14ed89356bd8f279944e4550938a532d0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/mutant.json.supervisor.json",
        "supervisorSha256": "e8101cc5343ed6dc63e8c920dc8d572f3754ba340148d986be31394697945b45"
      }
    ]
  },
  {
    "candidateId": "rt-0506",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/measurement.json",
    "measurementSha256": "ff8aa5d209c6e3e1d6f23c10c94d4ee49a97b8bbad03c255281ac40678142282",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Allow an unapproved suffix test file Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2401:97). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:23:52.728Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "0ab30c5916c0f3ef668dfd39ae6ca1a13c770e94e8c321a158b7fe67ca6e89df",
    "phases": [
      {
        "phase": "baseline",
        "launch": 333,
        "resultPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/baseline.json",
        "resultSha256": "0a8a62902e10384fb75da702f1b26e19aa5504eaee9e99e80f28359a7a95add0",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/baseline.json.supervisor.json",
        "supervisorSha256": "bf4a6a75dbbbdea8c8c16b6010b3c44f5b4b66a23f70dd0bf26229b371faa834"
      },
      {
        "phase": "mutant",
        "launch": 334,
        "resultPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/mutant.json",
        "resultSha256": "2f057d3b12f8117735c54aac19db2fd8a24c1c19096ebce8e7604c29c806a01c",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/mutant.json.supervisor.json",
        "supervisorSha256": "fe490a3f6f4750a1f9fc72a41f1bc955fc4a607296afeb93f7d8601640de78a7"
      }
    ]
  },
  {
    "candidateId": "rt-0507",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/measurement.json",
    "measurementSha256": "1e00ce921ac6dcec41883f6b9e6486a34cdc693373faf56d837f5feffddcc5c2",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Permit a third semantic mutant for one canonical case Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2414:85). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:24:56.835Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "d706b99ca02ff4e555edb5ddca8f68e8cce4a2a6492b5183325bc641bcef98fe",
    "phases": [
      {
        "phase": "baseline",
        "launch": 335,
        "resultPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/baseline.json",
        "resultSha256": "f6d77d9d0e1414cc3b5542a5fe716a3cf737de212ab5f2eeab9f59f1413f4cb5",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/baseline.json.supervisor.json",
        "supervisorSha256": "ac238fe30f692deca30252a911687c786b69b76a52e8abb6ec5a194c83b906e3"
      },
      {
        "phase": "mutant",
        "launch": 336,
        "resultPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/mutant.json",
        "resultSha256": "0822166870aa59dbf1f586df97b365f91745d67e47e837c2eae67ac4847a4673",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/mutant.json.supervisor.json",
        "supervisorSha256": "f08c1696e9f99342b9740231ea4d2cd3c8d89163b0858a829d18580507e6a0c7"
      }
    ]
  },
  {
    "candidateId": "rt-0508",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/measurement.json",
    "measurementSha256": "ef42a030daff4cb98b7efa7e2c3468023a9abcd7f4a54fd08a8efbd9c1c766ff",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Treat round zero as the continuing first round Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2425:91). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:24:56.838Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "6941d20574814b32383627a4298f7e3b19ffe4d9178806a87c2af897bf7281c0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 337,
        "resultPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/baseline.json",
        "resultSha256": "2b8b35cca25e68aa2e9cd474458c67924049a13b74a4fa2e72334f977fd773ba",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/baseline.json.supervisor.json",
        "supervisorSha256": "2e01d2298c0c0be7833587d9a8d6597f881729f1cb87dca8423199374c73593b"
      },
      {
        "phase": "mutant",
        "launch": 338,
        "resultPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/mutant.json",
        "resultSha256": "39bc9f84631fb2c2d5a846daeb7991bfd13a2af9a851327d0e9f2aa69f1f43f9",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/mutant.json.supervisor.json",
        "supervisorSha256": "513ca01e723b366659d8ddab6a2bbbed26be8ee11b27c349a42e0ba35c9c4fd3"
      }
    ]
  },
  {
    "candidateId": "rt-0509",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/measurement.json",
    "measurementSha256": "8b535f8d85855c9a2996ad5825f435a512b3fac2567f89ae5dcda695e4dc5764",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Lose admission ancestry when the branch is renamed Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2435:39). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:25:50.072Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "b569b5597e132151d7bb4cc24ee5a5481a2ff3c5d9440cb94f3ec3a3f86ead75",
    "phases": [
      {
        "phase": "baseline",
        "launch": 339,
        "resultPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/baseline.json",
        "resultSha256": "820649c444ef1e97db684f9e8745a070f9639c974fcd66e3107d3389077d5adb",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/baseline.json.supervisor.json",
        "supervisorSha256": "2123fff537d367d251705de8961ddc522b2e36aac06717ee243349e16e7bd4d5"
      },
      {
        "phase": "mutant",
        "launch": 340,
        "resultPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/mutant.json",
        "resultSha256": "44a40c163d5aa337236269514c237d32bbea64621e28b1b4a960032c7fcd4388",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/mutant.json.supervisor.json",
        "supervisorSha256": "66ffea210fd732a05e4294b019ff239ce73bd364438151192916e4b98f271ef2"
      }
    ]
  },
  {
    "candidateId": "rt-0510",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/measurement.json",
    "measurementSha256": "409e5d21fa3ad325c090fd2446fb311cc8f64e6a54ed341e2fad994ad2361679",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Require a committed document before recognizing the exact protected branch Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2443:97). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:25:50.076Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "8114840b406991a0ba56b760a8a27ed61db3fecf59af6aa9c0931ee907b30f06",
    "phases": [
      {
        "phase": "baseline",
        "launch": 341,
        "resultPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/baseline.json",
        "resultSha256": "e0b1b395c1ff223e6423adc6dc499825c78579466f4d4c661287cc7c218d6075",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/baseline.json.supervisor.json",
        "supervisorSha256": "9fbd5e9d6fcd6875a0c60880b688b959a0ca21316f5f2ad575f5d55aaeacbf85"
      },
      {
        "phase": "mutant",
        "launch": 342,
        "resultPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/mutant.json",
        "resultSha256": "1749babd15684431509efea7e92430b98bc76336d6a36db228c53d7066c6070e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/mutant.json.supervisor.json",
        "supervisorSha256": "b4045c6a4eda70123a84b6f446515b1dd3fe8339867120b81d9029f8d8c95db6"
      }
    ]
  },
  {
    "candidateId": "rt-0511",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/measurement.json",
    "measurementSha256": "16a25c0c3a038dcf243c09d7e5bfcf70c9c84d651d8da1c14b27c37d41775544",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Trust retained artifact bytes without checking their digest Observed: AssertionError: expected { …(2) } to be null (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2453:95). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:26:36.024Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "3a95df35c9031e02bbb31195a0332f3ada468a06f3312d5470dec909ce9bd7b0",
    "phases": [
      {
        "phase": "baseline",
        "launch": 343,
        "resultPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/baseline.json",
        "resultSha256": "a2876225413564bde7eb32c3431dcf9c639740040d217c09c6a19c4850639116",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/baseline.json.supervisor.json",
        "supervisorSha256": "efd6078923467dbc25f90d9938ac8efa3c08f2490712a67b1b6e1318d7da30fc"
      },
      {
        "phase": "mutant",
        "launch": 344,
        "resultPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/mutant.json",
        "resultSha256": "73e17a5f6aacaa8a3992da81041a4fd094db3c1397ab83ca5d35bed58b8683dc",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/mutant.json.supervisor.json",
        "supervisorSha256": "641a90588287de5170f67b1d8142667a98c9f88ef8a0e5cae556d83396f7e479"
      }
    ]
  },
  {
    "candidateId": "rt-0512",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/measurement.json",
    "measurementSha256": "ee3129fa370ef87509d617a95201241d01776d4f475a9dc4291470df37ade193",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Require an assertion-failing baseline instead of a green baseline Observed: AssertionError: expected false to be true // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2073:86). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:27:37.822Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "153ae4f06e8ab03953c7708eb4604a78fbd886f6c88ee6962bc2f92c8c2ecc74",
    "phases": [
      {
        "phase": "baseline",
        "launch": 345,
        "resultPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/baseline.json",
        "resultSha256": "afd7cf9f9fc95cf350b22f674ded35ccf0327d2fdf5b08bd06dc24c4bd6d3100",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/baseline.json.supervisor.json",
        "supervisorSha256": "7b500a6f5793743e957b1a94d181cf893a8b8e81ce84749c51d07decf2bfc69a"
      },
      {
        "phase": "mutant",
        "launch": 346,
        "resultPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/mutant.json",
        "resultSha256": "6bc11ab877ac49830d2d239feea84098e941a1af3c7e76840663f402e760acae",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/mutant.json.supervisor.json",
        "supervisorSha256": "61441a4acc7a1e44005a8fdefcf5e4b33f2d106d072cffdadfbdf89e6338e2ad"
      }
    ]
  },
  {
    "candidateId": "rt-0513",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/measurement.json",
    "measurementSha256": "ae58e8f04381003c02c93081609e3b7107700a4274a26a75d232f6ab658cbb92",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Ignore the canonical selector when binding kill evidence Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2133:68). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:27:37.825Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "aaabc18b315dc8730ba32dd176d550a81ee751e3358601c4799cb26ac3a03a07",
    "phases": [
      {
        "phase": "baseline",
        "launch": 347,
        "resultPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/baseline.json",
        "resultSha256": "17863eb6448500d3886750fe641f039014b1586cbe98be5ddcf1a8085e2b253f",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/baseline.json.supervisor.json",
        "supervisorSha256": "6b5030fbe682e5ef26a1386568785995cf3f7d12dbe226cac09354977aa785cf"
      },
      {
        "phase": "mutant",
        "launch": 348,
        "resultPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/mutant.json",
        "resultSha256": "125de38c7ae3a0825c0ba42916e1d6e2bda3c8f89536bf3b56173335521b0f9b",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/mutant.json.supervisor.json",
        "supervisorSha256": "ce545e6e2e3289fbed2ec542f72ca658fb6d9c8e7c6918dab30b713c910deafd"
      }
    ]
  },
  {
    "candidateId": "rt-0514",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/measurement.json",
    "measurementSha256": "2ad741467670301fb82ba5df00af7212ac070167606f9431ecf682099b17803d",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Ignore supervisor exit status when validating an assertion result Observed: AssertionError: expected true to be false // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2164:64). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:28:12.327Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "79c5ce9c02cc984479af60c98503e9edb1838cca370435e137e7b6c04928578f",
    "phases": [
      {
        "phase": "baseline",
        "launch": 349,
        "resultPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/baseline.json",
        "resultSha256": "981aad055dd1b26254157f714ea1fdf449b9e01470b9689f03e02f4c8e542958",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/baseline.json.supervisor.json",
        "supervisorSha256": "b8604dc88ae5b18e24dd57e444fd4afd1d6ac0471dc0c884096a3402f5b0bb32"
      },
      {
        "phase": "mutant",
        "launch": 350,
        "resultPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/mutant.json",
        "resultSha256": "21f842ce2977a061fcd662d83386bafe3ab23d4f67fc61f4daa1467bf82f9794",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/mutant.json.supervisor.json",
        "supervisorSha256": "fd8a7e5fc09c03e8c786d3d58c323e1980cc5b97d79c2b2d5d2e9f48faa793d4"
      }
    ]
  },
  {
    "candidateId": "rt-0515",
    "attempt": 2,
    "measurementPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/measurement.json",
    "measurementSha256": "d4c2a00e78a7ad52ac1488594c31035a1a6a71fdcd8e7c47f378c17cac3f2181",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Base missing-report refusal on a mutable journal pin instead of durable lineage Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-status.test.ts:2217:27). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:28:12.331Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/feature/scripts/red-team-status.mjs",
    "originalOid": "24b04b599910e3b50780af0d0229298bb982c092",
    "mutantSha256": "528dac3ee6cd8cc015f6b352343d31d8ff39409a6982d9392cf460766d5602b8",
    "phases": [
      {
        "phase": "baseline",
        "launch": 351,
        "resultPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/baseline.json",
        "resultSha256": "da5cdfd7f23f53491bda735d0ce4184728274bda7bfb991669940adda5eeade6",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/baseline.json.supervisor.json",
        "supervisorSha256": "a312b119d73eaa52b9dd426051c920d58ce8437f74f5d56492564c39635c3054"
      },
      {
        "phase": "mutant",
        "launch": 352,
        "resultPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/mutant.json",
        "resultSha256": "b495220374e0dcbb09620b4092535179fe16606334a63b86222bf73af544f10e",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/mutant.json.supervisor.json",
        "supervisorSha256": "430a9f42ee6e403b77711472b9a6b814250f245891814b1c7137ed610b49a413"
      }
    ]
  },
  {
    "candidateId": "rt-0516",
    "attempt": 1,
    "measurementPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/measurement.json",
    "measurementSha256": "860cc091826239887652048dda77b7da92d5b6945aa28ef7914531db8b49d2ab",
    "verdict": "killed",
    "reason": "Root reviewed the actual failure against this semantic mutation: Allow the mutation file to differ from the baseline-bound target Observed: AssertionError: expected +0 to be 1 // Object.is equality (at /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-operator-fallow-refactor/scripts/ci/__tests__/red-team-mutation-runner.test.ts:2605:130). The exact baseline passed and the mutant failed the existing behavioral assertion.",
    "reviewedAt": "2026-09-16T05:29:47.987Z",
    "sourceHead": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "7636fed1bb11fcd408456a7c1316dca69850e8f7ad8a90cf910792cf6e8c79ec",
    "phases": [
      {
        "phase": "baseline",
        "launch": 353,
        "resultPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/baseline.json",
        "resultSha256": "26d441e980613b145cca2272027463a5b968be972664aa8032fd6bebf79a5ebd",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/baseline.json.supervisor.json",
        "supervisorSha256": "f46d9775e592ae9206d65a3024ca3bcdbba3e0845bc911f02ac63ba466d25a70"
      },
      {
        "phase": "mutant",
        "launch": 354,
        "resultPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/mutant.json",
        "resultSha256": "d6c496053dcdb4af3c072a37f5b199ed04eaba3f973522d55a5185002c19b5ee",
        "supervisorPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/mutant.json.supervisor.json",
        "supervisorSha256": "6c9ab16e99372acf99cfe72055f9d27a29e0485926fb54343d6429f28eb69b92"
      }
    ]
  }
]
```

### Full retained launch bindings

```json
[
  {
    "id": "rt-0126",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 1,
    "resultPath": "/private/tmp/operator-redteam/case-0-baseline.json",
    "resultSha256": "6a8dea5be7f8d9080ceb0179b330cc1a30ae6e7c43e26d5efd3e10307c3bf52e",
    "logPath": "/private/tmp/operator-redteam/case-0-baseline.log",
    "logSha256": "cbc73b98b170e96146936c4af604e89fe33c327cfe2ab973002e54c1b5761431",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0126",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 2,
    "resultPath": "/private/tmp/operator-redteam/case-0-mutant.json",
    "resultSha256": "6822cc7f7890df980a1f45b9202870ed52594df62328e6e980e3eb5101d17377",
    "logPath": "/private/tmp/operator-redteam/case-0-mutant.log",
    "logSha256": "f7addfd250a39c652da13aa9f6b95db055259c696145afdc2ee9fa2a92003625",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0127",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 3,
    "resultPath": "/private/tmp/operator-redteam/case-1-baseline.json",
    "resultSha256": "06bafac740f631f6ddad596b6f42b34c156ba954cbf93ddef983476e6ae4cda0",
    "logPath": "/private/tmp/operator-redteam/case-1-baseline.log",
    "logSha256": "04b0aaa05aee2cab0c1641b8cc5e1410e4f7a1a9c85869aba458c2b8ba9ecf86",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0127",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 4,
    "resultPath": "/private/tmp/operator-redteam/case-1-mutant.json",
    "resultSha256": "89a684f93f656aac021193ab95ffda7af0caae8feff2b17d0714200a5d9d57f6",
    "logPath": "/private/tmp/operator-redteam/case-1-mutant.log",
    "logSha256": "d30ab322b386d8217741eb88a15e3651fcc69096455bed9b0bc4d40b4c55de86",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0137",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 5,
    "resultPath": "/private/tmp/operator-redteam/case-2-baseline.json",
    "resultSha256": "ce617f650eb8458a9c2fdf983750f56396d23729131a9405b7d92430d75e353f",
    "logPath": "/private/tmp/operator-redteam/case-2-baseline.log",
    "logSha256": "13809309fbc060a1ef30bc6757137b1f81431825ac9b175aeb4e5332bd7c6db4",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0137",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 6,
    "resultPath": "/private/tmp/operator-redteam/case-2-mutant.json",
    "resultSha256": "5f8ea5c2f2a702d4c588e43478b425d7e83cef8a83ab0beea8154bdd11c2e5d3",
    "logPath": "/private/tmp/operator-redteam/case-2-mutant.log",
    "logSha256": "65024da455997dc4720d2c668dc91f35679074596e04ddd6139ed7b80e2a6073",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0138",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 7,
    "resultPath": "/private/tmp/operator-redteam/case-3-baseline.json",
    "resultSha256": "3011c28d735b5e94acc3e10980e42a62723dab7396020399141004ccee8bb43b",
    "logPath": "/private/tmp/operator-redteam/case-3-baseline.log",
    "logSha256": "981d8ef6a965c9d1949715d525a413b558dde2f3e54dfed1b87a3ccdfb2cb391",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0138",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 8,
    "resultPath": "/private/tmp/operator-redteam/case-3-mutant.json",
    "resultSha256": "c343156503b2a31554929dffe24ec0cd6449e6fd7f9e28790510cca5a242f40b",
    "logPath": "/private/tmp/operator-redteam/case-3-mutant.log",
    "logSha256": "23b3c375f7450a09548f3717506286d8edd298ccfd444a3f2e708eac1471f55b",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0139",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 9,
    "resultPath": "/private/tmp/operator-redteam/case-4-baseline.json",
    "resultSha256": "deb41b05e720397e143c8fee267da616ce3f5dfa57cc917a1777eeca3ddc2141",
    "logPath": "/private/tmp/operator-redteam/case-4-baseline.log",
    "logSha256": "2ea3f56d107542922452c6dfa1e70c0b4452ca0af044f13bc9121778962b9d79",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0139",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 10,
    "resultPath": "/private/tmp/operator-redteam/case-4-mutant.json",
    "resultSha256": "ebc07bca02e41b1ee0f735a95fed2bb669452e64eea75ced68371b5c57fd2631",
    "logPath": "/private/tmp/operator-redteam/case-4-mutant.log",
    "logSha256": "69a1c606516ee91028fbfc6994bb7789d3bba33b4dc96cb7ed1a7d82f8e5b53a",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0140",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 11,
    "resultPath": "/private/tmp/operator-redteam/case-5-baseline.json",
    "resultSha256": "7f9f7a5625b714233e15bb0546b1276b3a0194d3411443777033fdfe060ffac3",
    "logPath": "/private/tmp/operator-redteam/case-5-baseline.log",
    "logSha256": "16072b6c572d2c435c7083977fd918caa1a496c1e8fdfc24c0bd8c9f2362cbad",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0140",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 12,
    "resultPath": "/private/tmp/operator-redteam/case-5-mutant.json",
    "resultSha256": "a4ab8c14ff748e95f0e16cbd4ad9b8d37f735eb3501cc59a08cb6d644ea1c5ce",
    "logPath": "/private/tmp/operator-redteam/case-5-mutant.log",
    "logSha256": "88384dad4f3901f9cdde08dc1e15c39dc04610f9b7d89046355860d91dd43f43",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0142",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 13,
    "resultPath": "/private/tmp/operator-redteam/case-6-baseline.json",
    "resultSha256": "c7893a1f84eb17eb3d488329ae695ea89550eed629f732dc8953e14d3ff18825",
    "logPath": "/private/tmp/operator-redteam/case-6-baseline.log",
    "logSha256": "21a464da05ba47c189c34f78b281f36577bbedea537e53e345e370b6014cfd43",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0142",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 14,
    "resultPath": "/private/tmp/operator-redteam/case-6-mutant.json",
    "resultSha256": "5e810090a9822ccca1da2d8cc503757dfb6ae9a7011d2f25a591abdc627f9539",
    "logPath": "/private/tmp/operator-redteam/case-6-mutant.log",
    "logSha256": "36a230a0a4df7d38e5deb8e95900e3adf264940314f154f069066550c04dc0c3",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0117",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 15,
    "resultPath": "/private/tmp/operator-redteam/case-7-baseline.json",
    "resultSha256": "93354c5bb6a5a49fccd695e80ab401aabd8c429cf655898249400060a37a95f6",
    "logPath": "/private/tmp/operator-redteam/case-7-baseline.log",
    "logSha256": "852b2726739919d5949c23965950dfd83f6632f3a5fa870b8167fb361a9fdda3",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0117",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 16,
    "resultPath": "/private/tmp/operator-redteam/case-7-mutant.json",
    "resultSha256": "ff974a16a7ed5902b3ea1c4a2eec105b2f716fe94c7b14bc0a1769dfe3488527",
    "logPath": "/private/tmp/operator-redteam/case-7-mutant.log",
    "logSha256": "4fa3365739fb08bb0247bdcd16fee87671ff6bac1b7d06d11602cf169e76cbe5",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0118",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 17,
    "resultPath": "/private/tmp/operator-redteam/case-8-baseline.json",
    "resultSha256": "b500a6061f67855e4ffa1adfd9b325cce210b32c6956a50f6797950d5db4fce6",
    "logPath": "/private/tmp/operator-redteam/case-8-baseline.log",
    "logSha256": "7a569aa60206bc2186e9396d3aa24269a8c879d92a863ac4121bfd6526745220",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0118",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 18,
    "resultPath": "/private/tmp/operator-redteam/case-8-mutant.json",
    "resultSha256": "8cb55af5729ae4d752b0e7da806c861be00770f71814eb9abb0f073f72b34bef",
    "logPath": "/private/tmp/operator-redteam/case-8-mutant.log",
    "logSha256": "9186ee82d7e627edcad73713edff7717296a0f070396524272e8a2af06bdf816",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0120",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 19,
    "resultPath": "/private/tmp/operator-redteam/case-9-baseline.json",
    "resultSha256": "7dec33381ee144882b5ffe889d84c3708b73e59908274c71dae3b38de07a8bff",
    "logPath": "/private/tmp/operator-redteam/case-9-baseline.log",
    "logSha256": "ba5a05279a092483aa0e4c363e7f24928f818b62a08c815bebc88b7c82c2d1fd",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0120",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 20,
    "resultPath": "/private/tmp/operator-redteam/case-9-mutant.json",
    "resultSha256": "fbe97d1421ac25f93f25a2194a738f571d3e5bb5fca2d7b69d082bf27d47a0f4",
    "logPath": "/private/tmp/operator-redteam/case-9-mutant.log",
    "logSha256": "59d71be071c01279ece4278063dac76c5874912d60c88056c6ffb8051731ff29",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0122",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 21,
    "resultPath": "/private/tmp/operator-redteam/case-10-baseline.json",
    "resultSha256": "6b226f2066d9e8b1fb9442a39a9a2a8e6ffb545708b9c7f4d0a76bb2e53baaa7",
    "logPath": "/private/tmp/operator-redteam/case-10-baseline.log",
    "logSha256": "e8ea6a980c5aad0a0969cc9a6cb5e91a0062c52f0c974c777b3f66478cca2fdc",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0122",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 22,
    "resultPath": "/private/tmp/operator-redteam/case-10-mutant.json",
    "resultSha256": "8479dcd8f28e39aa908ef15e5708bd030e35afd2e026412a9fcacefa7e6ef00b",
    "logPath": "/private/tmp/operator-redteam/case-10-mutant.log",
    "logSha256": "0bc2bc7c6a37e4bf242079f2dea07c516488991e8483937c14581ff3c4389e1a",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0155",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 23,
    "resultPath": "/private/tmp/operator-redteam/case-11-baseline.json",
    "resultSha256": "8756fd180a033c034832f6d17a187cf9caf9308730ab77d3b44c7bf79047cfc7",
    "logPath": "/private/tmp/operator-redteam/case-11-baseline.log",
    "logSha256": "ec14d519cf97c1b237bd684ef8aeec6b3bb9b48db818102b214ac235913da454",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0155",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 24,
    "resultPath": "/private/tmp/operator-redteam/case-11-mutant.json",
    "resultSha256": "c1ed2d99a88d612a2f9da26362e8842dd9febace7ccc8acc59e33d24c9072f67",
    "logPath": "/private/tmp/operator-redteam/case-11-mutant.log",
    "logSha256": "8ae32c84e54c28069e8d283b8e0dfaadd43641d75d27f941d977762cda0235b2",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0156",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 25,
    "resultPath": "/private/tmp/operator-redteam/case-12-baseline.json",
    "resultSha256": "a2b83a97e2189cbd5537d882858933a0ee6dd345eec2c8b7df67f0df64d32e3a",
    "logPath": "/private/tmp/operator-redteam/case-12-baseline.log",
    "logSha256": "d399d7e6536b49c4d13a664ef1be178197db72c40004a0c24fede2fde1527b9b",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0156",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 26,
    "resultPath": "/private/tmp/operator-redteam/case-12-mutant.json",
    "resultSha256": "c4c95c15232e09ca0b8deae5a8e72786a952ce084d5c93b8f193e8e5f2f16e80",
    "logPath": "/private/tmp/operator-redteam/case-12-mutant.log",
    "logSha256": "cc99fc7130c0c3c7c3932ffdba392d67a54986d8f2c86927bc19c3cacd0ee8c7",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0261",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 27,
    "resultPath": "/private/tmp/operator-redteam/case-13-baseline.json",
    "resultSha256": "c341f158ce179ea7888ed9e2a7d003e590684636a3b9718e9a073985f13d42c5",
    "logPath": "/private/tmp/operator-redteam/case-13-baseline.log",
    "logSha256": "2a7b8cbd596012e5410a4afba2e1945b7ae5046bf90b39c1d2e020bbe9aa31e5",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0261",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 28,
    "resultPath": "/private/tmp/operator-redteam/case-13-mutant.json",
    "resultSha256": "7aaaef86febe9711f17293f16a272a6139db8721c4fca4e4601acc1d9b7f15a0",
    "logPath": "/private/tmp/operator-redteam/case-13-mutant.log",
    "logSha256": "a6a3748a5409186f332f693ba5e2f064b013fa56e63d95311549c05bfe15ec06",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0262",
    "attempt": 1,
    "phase": "baseline",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 29,
    "resultPath": "/private/tmp/operator-redteam/case-14-baseline.json",
    "resultSha256": "63a743fa2eb2278a7a78eee4394e6fbfc012e61023de6aec36cbafbec6e6b630",
    "logPath": "/private/tmp/operator-redteam/case-14-baseline.log",
    "logSha256": "d49c75d22f645598d92ca2590ab200c994021f5b0252766b830e6112789d077c",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0262",
    "attempt": 1,
    "phase": "mutant",
    "control": "2ac6ff871b4496f996c37aaaaade9bdc7eee9a62",
    "target": "src/lib/agents/operator/apply.ts",
    "launch": 30,
    "resultPath": "/private/tmp/operator-redteam/case-14-mutant.json",
    "resultSha256": "940883e24482fdced1e14cece2dfb943625aeb144fdfcc6573fc0b64b112ae71",
    "logPath": "/private/tmp/operator-redteam/case-14-mutant.log",
    "logSha256": "72e159100f70eccc8314978494b10d6cb2f1fe1e8978b5c2f2f2756b2880f3b2",
    "legacy": true,
    "rootSelection": "historical record unchanged"
  },
  {
    "id": "rt-0129",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal marks the proposal stale without mutation when the current token differs from the prepared token",
    "selectorCorrection": null,
    "launch": 31,
    "resultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/baseline.json",
    "resultSha256": "eb8d015895fadfbbcf048227305b2b35587459ae35417d8ff76ee9c9c4609a97",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/baseline.json.supervisor.json",
    "supervisorSha256": "b4c8bcbd3c5e933f1c5b84c1718d692ab0f899c07bc274f2fe8a4cfcdba6cfb7",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0129",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal marks the proposal stale without mutation when the current token differs from the prepared token",
    "selectorCorrection": null,
    "launch": 32,
    "resultPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/mutant.json",
    "resultSha256": "cc906f6c5fdc0bf2fc5122cfa1764da52c8e4deff62764a8133a7b33921d1962",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0129-QG07rl/mutant.json.supervisor.json",
    "supervisorSha256": "538cc5299e3e56809d2ebd58da2993e1fa8c6ee474af38e5563101bbf73c77ac",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0010",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2a0dcbeb98b119d2632512e865dbe1b042c0fb828163d7f1fe257d5d330d2852",
    "selector": "OperatorClient operator screen disables the composer under All locations and enables it once a location is chosen",
    "selectorCorrection": null,
    "launch": 33,
    "resultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/baseline.json",
    "resultSha256": "bf65939deb3b1edc8827af398c430205c54559b8a2bafbcfba4c7172f2de1cd4",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/baseline.json.supervisor.json",
    "supervisorSha256": "7b198e181dcf16615d281addeedbe183dd56240ebf05982f9c169a33bd0389be",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0010",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2a0dcbeb98b119d2632512e865dbe1b042c0fb828163d7f1fe257d5d330d2852",
    "selector": "OperatorClient operator screen disables the composer under All locations and enables it once a location is chosen",
    "selectorCorrection": null,
    "launch": 34,
    "resultPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/mutant.json",
    "resultSha256": "7a02132b6055cf32360e0eb073aad4399d20a849471323abb46f90ed0c84f6cf",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0010-pnT3SO/mutant.json.supervisor.json",
    "supervisorSha256": "49dc15544e9bcb97516ddf1bbfb335047bba05dfa41a472d6e6c043414af2f42",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0011",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient retry after a lost POST response resumes the original turn",
    "selectorCorrection": null,
    "launch": 35,
    "resultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/baseline.json",
    "resultSha256": "090b2a2bf2961dd4ceae530db188ffe42c1ab032bc03c41cdef544a1ef250004",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/baseline.json.supervisor.json",
    "supervisorSha256": "160bca276a28a5f03efa5a895f8ec180d41fb37b7be3abbc4e857acd3dfef6cf",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0011",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient retry after a lost POST response resumes the original turn",
    "selectorCorrection": null,
    "launch": 36,
    "resultPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/mutant.json",
    "resultSha256": "5f0fa9b1b25bf9f566f6a4dce251cafe25a078dba407303059c3015cbf4eb37c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0011-IDXiyJ/mutant.json.supervisor.json",
    "supervisorSha256": "26ac3c0f44aa19cced086e0c98677cadf08cc6f86ed55bacf97c7ce2e592e92c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0041",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "36986d07441fcc05bcf0eb0a6cf2e39044d82a3599ef389f923157e427f0425c",
    "selector": "Operator Restore workflow shows preparation progress and a retryable error without creating an Apply button",
    "selectorCorrection": null,
    "launch": 37,
    "resultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/baseline.json",
    "resultSha256": "16568726640ea4a9d146b7535be3a43d3f8bb4bc7ab670da03c2fbe4e5374d50",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/baseline.json.supervisor.json",
    "supervisorSha256": "de717aaa395343afc0e9111099ab4f5697b2241ff1a1d8d73d3e305c367017b1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0041",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "36986d07441fcc05bcf0eb0a6cf2e39044d82a3599ef389f923157e427f0425c",
    "selector": "Operator Restore workflow shows preparation progress and a retryable error without creating an Apply button",
    "selectorCorrection": null,
    "launch": 38,
    "resultPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/mutant.json",
    "resultSha256": "a1640a9e104ca51275308f4f86c1072477ad3e26d65188f1ca7a7bf12e64dbe6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0041-hatLb1/mutant.json.supervisor.json",
    "supervisorSha256": "d82f1bcdc2b68b0c1ee55411c4d317ef84683c5b6521fc37629e41c4978a3395",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0141",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "d7e4f938abbc3db80801ba41ec81675e8c21bfb9e2f939d351cc9782e720bc84",
    "selector": "applyProposal policy scope policy Apply marks the proposal stale without a write when the current policy token moved",
    "selectorCorrection": null,
    "launch": 39,
    "resultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/baseline.json",
    "resultSha256": "9266e2be758e2257b8aee5497822f11107b50fc5d6e28b348a5089e3d3aad916",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/baseline.json.supervisor.json",
    "supervisorSha256": "728b6bf74e5a714889cd6f960fd7d36b650c43c0a6ca6019117f4b524b3bdd9b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0141",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "d7e4f938abbc3db80801ba41ec81675e8c21bfb9e2f939d351cc9782e720bc84",
    "selector": "applyProposal policy scope policy Apply marks the proposal stale without a write when the current policy token moved",
    "selectorCorrection": null,
    "launch": 40,
    "resultPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/mutant.json",
    "resultSha256": "4280fa1bc45f8371e94c1f5f8aa0c1fcd1ee8c0b541f238f651eed63510fe56f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0141-gYLmhT/mutant.json.supervisor.json",
    "supervisorSha256": "24aaf2a151a8cb0058cdde690ff268e368a137166f348462fcdb357af9c86023",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0284",
    "attempt": 1,
    "phase": "baseline",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "b3751f4b6ebc7950c5ecd8112cb7e5ee64546b5c9762ebbedc6de4cbfc55f41a",
    "selector": "AgentTurnWorker \\(live DB\\) missing restore history produces a fixed server explanation and no proposal",
    "selectorCorrection": null,
    "launch": 41,
    "resultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/baseline.json",
    "resultSha256": "5a5f2fd067d67ce4f7df0bb6e5320b16e02e32f574c9d57d1b1cc0a56ae79cb5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/baseline.json.supervisor.json",
    "supervisorSha256": "881442293ca22b4b5742bdd5ec2a86f6d7ecd0edb81c077e0853fcc3c96e835c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0284",
    "attempt": 1,
    "phase": "mutant",
    "control": "03502fdcee60e61b891636a625c95c6a9dadec9b",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "b3751f4b6ebc7950c5ecd8112cb7e5ee64546b5c9762ebbedc6de4cbfc55f41a",
    "selector": "AgentTurnWorker \\(live DB\\) missing restore history produces a fixed server explanation and no proposal",
    "selectorCorrection": null,
    "launch": 42,
    "resultPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/mutant.json",
    "resultSha256": "450d54a69faed9a3f250da190d1514708145124ebd4665b57d48fa1326cc7fe3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0284-ThcX0e/mutant.json.supervisor.json",
    "supervisorSha256": "6cff2045cd2ab334f208e31fff9a49a5869f211b46d9fa4ad7e7094f37faf27d",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0120",
    "attempt": 2,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "76a1b5eb715b16a31bf8fab3b1fc2c90a555da3f57edce49281ac0b810a4fbd8",
    "selector": "applyProposal \\(live DB\\) applyProposal receipt after equals the committed voice state and flags a difference from the stored after",
    "selectorCorrection": null,
    "launch": 43,
    "resultPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/baseline.json",
    "resultSha256": "fa1f6b4a15f43fa123731b42b95d105e62a41160dc03ae1b24a12224463af296",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/baseline.json.supervisor.json",
    "supervisorSha256": "37a198bc76b0b733ab46ee5676a64a314e4940b4b5bc3694a03da0aec5b8c562",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0120",
    "attempt": 2,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "76a1b5eb715b16a31bf8fab3b1fc2c90a555da3f57edce49281ac0b810a4fbd8",
    "selector": "applyProposal \\(live DB\\) applyProposal receipt after equals the committed voice state and flags a difference from the stored after",
    "selectorCorrection": null,
    "launch": 44,
    "resultPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/mutant.json",
    "resultSha256": "a83b579b9ca40b9a23907b3e4472700c90073116cc60891c3b76ee5eec13c22a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0120-U7ld8A/mutant.json.supervisor.json",
    "supervisorSha256": "23e17997f52f03f0205d78c8936e032df32c8020d912cd921dc28e6227431973",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0137",
    "attempt": 2,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a677a16c19b28422df1217fe64cccc368d2f58ded289aee62225ba7845ec2e41",
    "selector": "applyProposal policy scope policy Apply locks the account row before the proposal row, reads policy state only after both, and writes one standard-confirmed dial",
    "selectorCorrection": null,
    "launch": 45,
    "resultPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/baseline.json",
    "resultSha256": "f85302d276886021149659f38f75075d04565642e4a24f46dcf9b3227965ce27",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/baseline.json.supervisor.json",
    "supervisorSha256": "fcb94099b1b327d689c7b0b775450f33b44fa4d5524c64e393bb690a5984d035",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0137",
    "attempt": 2,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a677a16c19b28422df1217fe64cccc368d2f58ded289aee62225ba7845ec2e41",
    "selector": "applyProposal policy scope policy Apply locks the account row before the proposal row, reads policy state only after both, and writes one standard-confirmed dial",
    "selectorCorrection": null,
    "launch": 46,
    "resultPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/mutant.json",
    "resultSha256": "09deec240e5e6eafe0fcf5a790707158b3ef1dfd388c2ee97cad6577ae41e5f9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0137-PVA5JD/mutant.json.supervisor.json",
    "supervisorSha256": "923416a1c19558d9e1cd9bc9a05e9b5a382b7ec35d682cc654f6ef068fb9e88f",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0138",
    "attempt": 2,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope policy Apply leaves an expansion pending and writes nothing unless the typed scope matches byte for byte",
    "selectorCorrection": null,
    "launch": 47,
    "resultPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/baseline.json",
    "resultSha256": "8f049b6bc4ae08c0264368dd650a0de69962570a1eba178c24cde20e1e4a3fce",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/baseline.json.supervisor.json",
    "supervisorSha256": "f128ba1aec3c4b630e9305be55b4e024964a35d818bacfbd80f119cc5ac5f7b2",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0138",
    "attempt": 2,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope policy Apply leaves an expansion pending and writes nothing unless the typed scope matches byte for byte",
    "selectorCorrection": null,
    "launch": 48,
    "resultPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/mutant.json",
    "resultSha256": "7d409ef16153d6334ef9086d7df613dde6c36ad6e3ccd68e690d9e88ad88a3ae",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0138-SxKpCr/mutant.json.supervisor.json",
    "supervisorSha256": "50a0079051a5f31a9784e39a2fbea7c233ee1017b14dca36a18d0616a0fe06d0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0139",
    "attempt": 2,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope readiness blocks only the expansion; a contraction applies without reading readiness or a phrase",
    "selectorCorrection": null,
    "launch": 49,
    "resultPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/baseline.json",
    "resultSha256": "a8c5fa117695a57162a70b33e6eadab7d4fbb77df6c2c8ecff336dbccf043f3b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/baseline.json.supervisor.json",
    "supervisorSha256": "984b38951166a8971e87a26e599059239fdccd243e81d52738946f0136661f21",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0139",
    "attempt": 2,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope readiness blocks only the expansion; a contraction applies without reading readiness or a phrase",
    "selectorCorrection": null,
    "launch": 50,
    "resultPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/mutant.json",
    "resultSha256": "2a49e0cfab09976e11658a147216c2edf96e5f2d3e673fc70f522e3c043b9eed",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0139-b2uMqA/mutant.json.supervisor.json",
    "supervisorSha256": "54244613a44e756de0a0e24e22d25ec8f57b9e01a6d17ca1036d1ba4d5b6cabd",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0140",
    "attempt": 2,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope an archived location refuses a new override but applies a manual contraction",
    "selectorCorrection": null,
    "launch": 51,
    "resultPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/baseline.json",
    "resultSha256": "bc55cf5e40ea222148ed3c045ce1b2477f4d3be9fa2fa2b2e5c04661e8749f2a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/baseline.json.supervisor.json",
    "supervisorSha256": "d8c20f5d5e4e298e8c2ecc071915a705b0b248c5dadd69af279162e593db4e02",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0140",
    "attempt": 2,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "applyProposal policy scope an archived location refuses a new override but applies a manual contraction",
    "selectorCorrection": null,
    "launch": 52,
    "resultPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/mutant.json",
    "resultSha256": "502a6f736f7440c3dcb70d7ebb9a896642196c905e65c50ee13286aa7bfb29a1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0140-j4nqaP/mutant.json.supervisor.json",
    "supervisorSha256": "4f876b89c15bddff2e15112bc63e5ecb4fb0a186bd5f2330debfe59daab92ed6",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0502",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "79901bf6f6bbe66fb466586b90e3d705c4d36c8521870ee424a0cca9409f4f64",
    "selector": "Operator same-round continuation safeguards continues at launch 31 and shares the finite ceiling through launch 1500",
    "selectorCorrection": null,
    "launch": 53,
    "resultPath": "/private/tmp/operator-continuation-rt-0502-SOINfO/baseline.json",
    "resultSha256": "a2cd7fff6c5e4f6ccdca764e090740bc2563f9e870981680afde1bef2e55b259",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0502-SOINfO/baseline.json.supervisor.json",
    "supervisorSha256": "2c47034bf16ca87ea8f639b8f1c68fa3bb8cf512b9046c88da4d9b613022af8f",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0502",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "79901bf6f6bbe66fb466586b90e3d705c4d36c8521870ee424a0cca9409f4f64",
    "selector": "Operator same-round continuation safeguards continues at launch 31 and shares the finite ceiling through launch 1500",
    "selectorCorrection": null,
    "launch": 54,
    "resultPath": "/private/tmp/operator-continuation-rt-0502-SOINfO/mutant.json",
    "resultSha256": "1c4ce0d8ea002166831eb89b4aa0913a746712b5cf154a508884a4dc47bd54d9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0502-SOINfO/mutant.json.supervisor.json",
    "supervisorSha256": "7ae897ef649bfe8104e8925706d614d5540c87eb91fef11a060955f6b1c2b9d4",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0503",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "8b976183c28a9c3b5ba5a7d87397851a7ea18b8c5f3c624189f9cadf8e7d90c7",
    "selector": "Operator same-round continuation safeguards rejects invalid and over-ceiling continuation timeouts",
    "selectorCorrection": null,
    "launch": 55,
    "resultPath": "/private/tmp/operator-continuation-rt-0503-AWb88B/baseline.json",
    "resultSha256": "455c0eebc706d4b874bd9b35c4a9381e184f1239919a1597ac5dc2ecbb64bee2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0503-AWb88B/baseline.json.supervisor.json",
    "supervisorSha256": "868a331665e2aab7a3d25ea62e2a290cc2ed8b32eca2be1cd7d0fe6317ad1400",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0503",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "8b976183c28a9c3b5ba5a7d87397851a7ea18b8c5f3c624189f9cadf8e7d90c7",
    "selector": "Operator same-round continuation safeguards rejects invalid and over-ceiling continuation timeouts",
    "selectorCorrection": null,
    "launch": 56,
    "resultPath": "/private/tmp/operator-continuation-rt-0503-AWb88B/mutant.json",
    "resultSha256": "e75b3a6d9c8404c497a66abf96aac36b07e217644e6541e854a5d7cb55358528",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0503-AWb88B/mutant.json.supervisor.json",
    "supervisorSha256": "f71ca866a581ceca6c8d03ccca1c76882a2e236e5f02449e4ec8c2a4d9f749d1",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0504",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "d35aad6e234c2cf4282207f93a2f38cf032872c94e93cae3ac17f7ca8d8ed03d",
    "selector": "Operator same-round continuation safeguards preserves every original mutation and supervisor in the checkpoint prefix",
    "selectorCorrection": null,
    "launch": 57,
    "resultPath": "/private/tmp/operator-continuation-rt-0504-xCM8f6/baseline.json",
    "resultSha256": "6d2553dfde1b89ae56b9185e5e817d44f0b5c0c51eaa05c29b776efe72a11404",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0504-xCM8f6/baseline.json.supervisor.json",
    "supervisorSha256": "048c5f6c2ea3764a3001999222a492272430cd7168457baf1dfbe8d24f13c76c",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0504",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "d35aad6e234c2cf4282207f93a2f38cf032872c94e93cae3ac17f7ca8d8ed03d",
    "selector": "Operator same-round continuation safeguards preserves every original mutation and supervisor in the checkpoint prefix",
    "selectorCorrection": null,
    "launch": 58,
    "resultPath": "/private/tmp/operator-continuation-rt-0504-xCM8f6/mutant.json",
    "resultSha256": "312e9444f9e415c5c99f4a8677cd4acdfaf155dd6f4708a767a11e28636d9b1d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0504-xCM8f6/mutant.json.supervisor.json",
    "supervisorSha256": "27101943e844db229addee71a7ee39e837993dfe16e4171146d93bbeb2ef518d",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0505",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "e06657c417c0f7a0c49513676565a48d27e6df2a16cb4ea5f7c26b747805ead2",
    "selector": "Operator same-round continuation safeguards rejects missing swapped or reset legacy candidate launch mappings",
    "selectorCorrection": null,
    "launch": 59,
    "resultPath": "/private/tmp/operator-continuation-rt-0505-tvxvNw/baseline.json",
    "resultSha256": "4e1ff4ce3477a05dc45d32c8f9b17f2bb337877562939ebe6f725d391a5ab599",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0505-tvxvNw/baseline.json.supervisor.json",
    "supervisorSha256": "438113105cc20a7baff4371d185a4ab3010388555104d98977c2f8b09b5a88b1",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0505",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "e06657c417c0f7a0c49513676565a48d27e6df2a16cb4ea5f7c26b747805ead2",
    "selector": "Operator same-round continuation safeguards rejects missing swapped or reset legacy candidate launch mappings",
    "selectorCorrection": null,
    "launch": 60,
    "resultPath": "/private/tmp/operator-continuation-rt-0505-tvxvNw/mutant.json",
    "resultSha256": "930c952a5c21c3db6c828e89174499a12dee87f523fdb4b4b40b8bd2e1e4b318",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0505-tvxvNw/mutant.json.supervisor.json",
    "supervisorSha256": "fa4be83e7b2e94ea8d5299711b88080f790cbc7ade23eaada87c590bd0ef7c7a",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0506",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "b0e9d3b06ce61a5146600077d9bf97b981a5795d071c54f81a90746e1a2dca11",
    "selector": "Operator same-round continuation safeguards rejects changed inventory identities duplicate selectors and unapproved suffix files",
    "selectorCorrection": null,
    "launch": 61,
    "resultPath": "/private/tmp/operator-continuation-rt-0506-kOBTWD/baseline.json",
    "resultSha256": "6138ecdcb8d16ad3a34f0bea0624a69c267842d3174f0cdce251d0676afb0eed",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0506-kOBTWD/baseline.json.supervisor.json",
    "supervisorSha256": "f5cff617ceeccd425d1e0394e461deb8b837c5ebdadb80404ceecb1f29763ba1",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0506",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "b0e9d3b06ce61a5146600077d9bf97b981a5795d071c54f81a90746e1a2dca11",
    "selector": "Operator same-round continuation safeguards rejects changed inventory identities duplicate selectors and unapproved suffix files",
    "selectorCorrection": null,
    "launch": 62,
    "resultPath": "/private/tmp/operator-continuation-rt-0506-kOBTWD/mutant.json",
    "resultSha256": "29eb92bbfcef8a118995a4dc399577865f4793038fc4ebc8db94aae7be3aa1d1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0506-kOBTWD/mutant.json.supervisor.json",
    "supervisorSha256": "d071acfed80b88cb868694a2797756e9ace903d3a01779c9fc928f15c08c16fa",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0005",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "88eba3f0e76581bfdf86754cef9d27c62d4794fc1af679fd45c949cfb0cc90f2",
    "selector": "OperatorClient operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload",
    "selectorCorrection": null,
    "launch": 63,
    "resultPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/baseline.json",
    "resultSha256": "70911a87a97836ffb5e9a3ebe63138f6f2fe467bca4fbf7883e85aac3eac54ce",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/baseline.json.supervisor.json",
    "supervisorSha256": "96b6818e28cc7af4a1cd68d818f3523733fb51a8679a7c9a0b08b127ab7c9708",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0005",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "88eba3f0e76581bfdf86754cef9d27c62d4794fc1af679fd45c949cfb0cc90f2",
    "selector": "OperatorClient operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload",
    "selectorCorrection": null,
    "launch": 64,
    "resultPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/mutant.json",
    "resultSha256": "2cddc184cf1c7b548fb4680bde994e1b5586db0cd59ea8793a1e569de58583ce",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0005-sj5iW9/mutant.json.supervisor.json",
    "supervisorSha256": "af1b66bbb44b0ca51822114202190905b2d87d4ca621ba988e056e4edf29693f",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0006",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "selector": "OperatorClient operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes",
    "selectorCorrection": null,
    "launch": 65,
    "resultPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/baseline.json",
    "resultSha256": "f7159ea43924cc4ae5eddce3facb6e44043e25cfaacfd6c41d212f16c5ef4a96",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/baseline.json.supervisor.json",
    "supervisorSha256": "bdc8ad0e9e1ff1a69f911623491317ed5bab202fbf4afe541f914fee3951df48",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0006",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "selector": "OperatorClient operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes",
    "selectorCorrection": null,
    "launch": 66,
    "resultPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/mutant.json",
    "resultSha256": "74fba04ed57734920831a64e5108970be4c3c00c0536fef5872a83228b02a368",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0006-Uzs9kA/mutant.json.supervisor.json",
    "supervisorSha256": "e37cdde428d85c1b827dacde7f154b97987d1eeb22f765cea2fef81f3bf2dfba",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0007",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "selector": "OperatorClient operator times out while a poll request remains unresolved",
    "selectorCorrection": null,
    "launch": 67,
    "resultPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/baseline.json",
    "resultSha256": "710f6115b9743f1be5b290d22d27ddcd75302c244a1f005cf9d5fa2118923c64",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/baseline.json.supervisor.json",
    "supervisorSha256": "9e02fc060801c071f46badbfbd34cab3bd86191b221ae76f09c57bb89575db63",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0007",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7bdba6afe1967f269f53d88ce9c46f2f15c8270055f7cc6eecef160bfcd74348",
    "selector": "OperatorClient operator times out while a poll request remains unresolved",
    "selectorCorrection": null,
    "launch": 68,
    "resultPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/mutant.json",
    "resultSha256": "84d1097e41dd19372ead98663bcda3340ce579945dc2d0cbe7e0978b28c302ef",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0007-D5OEwg/mutant.json.supervisor.json",
    "supervisorSha256": "cb09c13be56a0e04cafd02d046e87870a5e4fc42d2b882a2504ed773d6bb486a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0009",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "fc44b7818ebc025c4cfe7ea594830cbf90491683880d06322b1b2765b212077a",
    "selector": "OperatorClient operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled",
    "selectorCorrection": null,
    "launch": 69,
    "resultPath": "/private/tmp/operator-continuation-rt-0009-45207U/baseline.json",
    "resultSha256": "3ebcdbf16e2c57d041594ba27e2f099570d4c4de0705646c3dc6c909ac853119",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0009-45207U/baseline.json.supervisor.json",
    "supervisorSha256": "fbf082e3b093f396fd695d94cf44d8390b36e976ea8208c1d9b1648141bf2f9c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0009",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "fc44b7818ebc025c4cfe7ea594830cbf90491683880d06322b1b2765b212077a",
    "selector": "OperatorClient operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled",
    "selectorCorrection": null,
    "launch": 70,
    "resultPath": "/private/tmp/operator-continuation-rt-0009-45207U/mutant.json",
    "resultSha256": "8b0e89d5d38bfc902875c6663fa189206b28f713a833a44dc195cf06dc0f9eb9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0009-45207U/mutant.json.supervisor.json",
    "supervisorSha256": "5d6d2f8101dea92d0189c0e95e8d65b4a2ed38594c31bad79a62368f87841c0c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0012",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient a POST that never settles releases the composer and offers the same retry",
    "selectorCorrection": null,
    "launch": 71,
    "resultPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/baseline.json",
    "resultSha256": "a4f902a3c152ab2ca71ae714baca014ebe724f1241ca518a3157b276c03d5c84",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/baseline.json.supervisor.json",
    "supervisorSha256": "0d8829f409e41a6ce0efed849cc74f2e254eaf3788a2aec05ff588be0948103c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0012",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient a POST that never settles releases the composer and offers the same retry",
    "selectorCorrection": null,
    "launch": 72,
    "resultPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/mutant.json",
    "resultSha256": "4502b5df59a00a6bb61a247704d0469c49b21e2a78c0cb5c7caef434433440dd",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0012-waB5AL/mutant.json.supervisor.json",
    "supervisorSha256": "17dd74c69971114e9f31dd082049970a853be31d9df172963aa09869c741f513",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0013",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient a refusal the server answered offers no retry and an unusable location says so",
    "selectorCorrection": null,
    "launch": 73,
    "resultPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/baseline.json",
    "resultSha256": "2db26f85ff49f163b6064bb4f71b5be2901756e16085f37f65e1afeabb3b1b5c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/baseline.json.supervisor.json",
    "supervisorSha256": "c5953b73d3d04b6bdace57ec697ab4971b59c3518969d3e5b9968e258257f6f6",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0013",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b",
    "selector": "OperatorClient a refusal the server answered offers no retry and an unusable location says so",
    "selectorCorrection": null,
    "launch": 74,
    "resultPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/mutant.json",
    "resultSha256": "7d87feb7b5a0c7324bcb2ac4743bac2758ad07ffa5eca15cd89c94d37b85b47a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0013-1UGM8x/mutant.json.supervisor.json",
    "supervisorSha256": "fcc892a8078fb9be22898a83e89a137da4938fcfd2b80eac653f4d4d75eb920e",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0014",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "1a25a5f250b2c224be8c18a4172fce0ad3c9195d914a10e71dd74d4bab260dae",
    "selector": "OperatorClient operator renders every stored segment kind in order",
    "selectorCorrection": null,
    "launch": 75,
    "resultPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/baseline.json",
    "resultSha256": "cfe45d79e68239957d11a336e60167578383d75c01c386f321b8d83190717846",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/baseline.json.supervisor.json",
    "supervisorSha256": "a777209ce6cae35974474fb7e112708be82aecb7b8c158d73805952ca4226138",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0014",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "1a25a5f250b2c224be8c18a4172fce0ad3c9195d914a10e71dd74d4bab260dae",
    "selector": "OperatorClient operator renders every stored segment kind in order",
    "selectorCorrection": null,
    "launch": 76,
    "resultPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/mutant.json",
    "resultSha256": "f328c8d621477bbb70feb393d5a3a73296779e2c827178fcd27b1e9e8b657113",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0014-KRNUTC/mutant.json.supervisor.json",
    "supervisorSha256": "e0cb1a4d8b543e91717e695a88f7aac0c93ad2de77cae53a4d8446876de93c03",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0015",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "OperatorClient a refused Apply repaints the card from the row the server returned",
    "selectorCorrection": null,
    "launch": 77,
    "resultPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/baseline.json",
    "resultSha256": "a9e07fbe193c5e3683cd2a47e001106d1451cf41d1a46b7b77fc625c0e2061cf",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/baseline.json.supervisor.json",
    "supervisorSha256": "0885b45291cf366d78e23d4c34b8c4418d6b9296940a075fe16e11d2331f1586",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0015",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "OperatorClient a refused Apply repaints the card from the row the server returned",
    "selectorCorrection": null,
    "launch": 78,
    "resultPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/mutant.json",
    "resultSha256": "54f5f08cc065fbac2341a9ed70af638160460633d636623f9c7b4a5e6b6e1ed9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0015-Ygd6dn/mutant.json.supervisor.json",
    "supervisorSha256": "50f75b3f466e26767b35f7202e98fa3c027a54563637137dbe06b79486553ceb",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0016",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "9670b21a4e5ee3d5e8f296675fe2ef7efcdb21ec19e99342316416f67e75e996",
    "selector": "OperatorClient terminal failures and requested capabilities survive reload and subsequent turns",
    "selectorCorrection": null,
    "launch": 79,
    "resultPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/baseline.json",
    "resultSha256": "2baaf72556f2d18a928a8d85129712e449f57cf61507d7a79f7c57220cc59257",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/baseline.json.supervisor.json",
    "supervisorSha256": "fd3ed84ba769867d048823713f3d10d4b14239843d11669291ba5ca2209f478f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0016",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "9670b21a4e5ee3d5e8f296675fe2ef7efcdb21ec19e99342316416f67e75e996",
    "selector": "OperatorClient terminal failures and requested capabilities survive reload and subsequent turns",
    "selectorCorrection": null,
    "launch": 80,
    "resultPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/mutant.json",
    "resultSha256": "35372b5cb8a59073385ffdf9090211576b21185eba84610b91eceb0dca419970",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0016-FH1d55/mutant.json.supervisor.json",
    "supervisorSha256": "18aa6e77657e89e2be465a5f4269f0e262ee87a6221438536750a76b08673c33",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0017",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "selector": "OperatorClient loaded conversations retain identity and starting over stays empty",
    "selectorCorrection": null,
    "launch": 81,
    "resultPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/baseline.json",
    "resultSha256": "28c98a4a811dd34160aba8b6ce29969a8a319a01a67b4925573ee92600e8d771",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/baseline.json.supervisor.json",
    "supervisorSha256": "b1e5f5bea6f67736daccd7e23421e725a40f99bb0d11469a7f494898e174b929",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0017",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "selector": "OperatorClient loaded conversations retain identity and starting over stays empty",
    "selectorCorrection": null,
    "launch": 82,
    "resultPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/mutant.json",
    "resultSha256": "35cc0617e10bdd3f6f9423f41cf5fd09220b7d263dcacc70b315f9d7d797d59a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0017-XNW1Fg/mutant.json.supervisor.json",
    "supervisorSha256": "d844f7bfe7b889d8f80a97c2a37717452b20b9ec37c5780c7258f0f0a968da15",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0020",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "selector": "OperatorClient a conversation read that answers after the turn finished resumes the turn it says is still running",
    "selectorCorrection": null,
    "launch": 83,
    "resultPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/baseline.json",
    "resultSha256": "3dc8aaeaf03a9a1e3dfca963c4da74fbb87866f3b8158f913ce77113414387e1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/baseline.json.supervisor.json",
    "supervisorSha256": "7e2a33b55853b79736e38336df5db851e300e4b8d5f4cefa228772805543cc47",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0020",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba",
    "selector": "OperatorClient a conversation read that answers after the turn finished resumes the turn it says is still running",
    "selectorCorrection": null,
    "launch": 84,
    "resultPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/mutant.json",
    "resultSha256": "0d566421c1c8d12721aa8865b8b9ac37607610abae362fe2e8321d22407fdd0e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0020-P3wSI5/mutant.json.supervisor.json",
    "supervisorSha256": "0998d9840fd22badb10e81e1e46231eb75b8d64f06ab042af140be7cd2681063",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0022",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "0d0c893cd91ab3e1fff5bc8d7552b44033dce3deb074f10dbe3ccb20a89e178c",
    "selector": "OperatorClient Refresh plan preserves the original instruction and location after scope changes",
    "selectorCorrection": null,
    "launch": 85,
    "resultPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/baseline.json",
    "resultSha256": "8d264ef1907debfbfc66740048e1fbeeb45b2fc2dfc7c95ec1445de26a6d04d7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/baseline.json.supervisor.json",
    "supervisorSha256": "b233694ff7bd69df98e98932f482836fa1a2803d22fe57467799b3db534b0762",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0022",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "0d0c893cd91ab3e1fff5bc8d7552b44033dce3deb074f10dbe3ccb20a89e178c",
    "selector": "OperatorClient Refresh plan preserves the original instruction and location after scope changes",
    "selectorCorrection": null,
    "launch": 86,
    "resultPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/mutant.json",
    "resultSha256": "8bcdd409bff5abff2907f13fd4265d56dbe61f91dd46b8cb1f7c0bd174130cac",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0022-wV0voP/mutant.json.supervisor.json",
    "supervisorSha256": "2521f61cbaa151a50fa6b4fd13c9dd63babab7d593c9853c6bf14e471ca66b75",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0030",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "c74b40d44fca72f45c279021f00e4b2564049c9d66fdfea2ea497f95b9f9007a",
    "selector": "autonomy cards renders expansions once, after ordinary cards, text and unsupported requests",
    "selectorCorrection": null,
    "launch": 87,
    "resultPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/baseline.json",
    "resultSha256": "88dd7d0a3de70546587b12402b40502cbfbed4c7a536284cabec569d6c05d842",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/baseline.json.supervisor.json",
    "supervisorSha256": "7430e98fd2099bd5902121f1274343577bce33d58c83c39ac80a0d6191966190",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0030",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/TurnBody.tsx",
    "originalOid": "f10e2e88e3cbc0fc878428d3bd97382b871f0641",
    "mutantSha256": "c74b40d44fca72f45c279021f00e4b2564049c9d66fdfea2ea497f95b9f9007a",
    "selector": "autonomy cards renders expansions once, after ordinary cards, text and unsupported requests",
    "selectorCorrection": null,
    "launch": 88,
    "resultPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/mutant.json",
    "resultSha256": "68e1fd174a6d70db8f328600934d1e7d9f396fd2fe1e450be641072fde2d6213",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0030-y9r8h0/mutant.json.supervisor.json",
    "supervisorSha256": "055886b0d627097e5dfa9301373845b08dd7684e131fa731d20e92ca8539ca87",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0035",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2ba3dcac4aab92e8fb59893a5f7d2bd82fe3d9e7465a01636a11f4043990a60c",
    "selector": "Operator Restore workflow refused cards and the operating rules timeline survive reload",
    "selectorCorrection": null,
    "launch": 89,
    "resultPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/baseline.json",
    "resultSha256": "df75a5c7b691f9a3806ed9a11207bb66608c225944d10f4b6e92420a2e98cbe9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/baseline.json.supervisor.json",
    "supervisorSha256": "ad7c41470d9709a3f9057e0d9e0b140e7961ee96a164a18f07bcc853a38da049",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0035",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "2ba3dcac4aab92e8fb59893a5f7d2bd82fe3d9e7465a01636a11f4043990a60c",
    "selector": "Operator Restore workflow refused cards and the operating rules timeline survive reload",
    "selectorCorrection": null,
    "launch": 90,
    "resultPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/mutant.json",
    "resultSha256": "d59bc8cf69043da146fdfbaa3d33af18df5bdae8bdbdf1807ebde33960b811e1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0035-oxUEQw/mutant.json.supervisor.json",
    "supervisorSha256": "14be4150f4b012907dd61463e736648f6457a38fcc22fe8dcea3079a89f4958d",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0036",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "selector": "Operator Restore workflow prepares a pending card from a receipt, reloads it, and only then sends the ordinary Apply request",
    "selectorCorrection": null,
    "launch": 91,
    "resultPath": "/private/tmp/operator-continuation-rt-0036-dYi301/baseline.json",
    "resultSha256": "2cc9ee15e934cfaf6cbb78c2dfac5123dcd3351f86fdfa552cbab4cd5032ffe7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0036-dYi301/baseline.json.supervisor.json",
    "supervisorSha256": "4845a6ae9da030b9b92edba9db2ce1f65a27edd8a0f0d33791039e1daf9db9b4",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0036",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "selector": "Operator Restore workflow prepares a pending card from a receipt, reloads it, and only then sends the ordinary Apply request",
    "selectorCorrection": null,
    "launch": 92,
    "resultPath": "/private/tmp/operator-continuation-rt-0036-dYi301/mutant.json",
    "resultSha256": "f68354970c646c71a4f5729d994183914e800505ae525a83bb3616e4396970c7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0036-dYi301/mutant.json.supervisor.json",
    "supervisorSha256": "20c6e05bc794822e2473b2a8172dc9b1165b764235bd941304b0f71f57b5149d",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0037",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "Operator Restore workflow adopts a rejected timeline Apply and refreshes its Restore source: prepared here",
    "selectorCorrection": null,
    "launch": 93,
    "resultPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/baseline.json",
    "resultSha256": "fb356baf62b8e5cc07e9a800f4100cb798232096b0c949890f780cacb0dbb45c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/baseline.json.supervisor.json",
    "supervisorSha256": "13fbdefbf9cc7acba653c1d39dcfdf3fa36c1237b137a1a88a9f0fea6e67fa08",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0037",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "Operator Restore workflow adopts a rejected timeline Apply and refreshes its Restore source: prepared here",
    "selectorCorrection": null,
    "launch": 94,
    "resultPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/mutant.json",
    "resultSha256": "a2d57e759699c16cbfbce287c032640774e6a8e72fbc41cce58d5725c97b4ccc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0037-IkLwtB/mutant.json.supervisor.json",
    "supervisorSha256": "9a67bd40cc0bb526b0c43072f3e1ea5ab1428508302f5b9218e2933381d4a0a8",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0038",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "Operator Restore workflow adopts a rejected timeline Apply and refreshes its Restore source: loaded after refresh",
    "selectorCorrection": null,
    "launch": 95,
    "resultPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/baseline.json",
    "resultSha256": "60976e4b3dd91357aba38fe388649d67ae83898c52c75162efc282a93deb98e1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/baseline.json.supervisor.json",
    "supervisorSha256": "6fbc3ff8c3c90c9bdbb088deb53724e5548529ca5fe7a1b3e121b2b135aa0ad4",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0038",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "Operator Restore workflow adopts a rejected timeline Apply and refreshes its Restore source: loaded after refresh",
    "selectorCorrection": null,
    "launch": 96,
    "resultPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/mutant.json",
    "resultSha256": "b6ab03aceb6e8b4adc0aa0f2c0388aef3c455ae8b8cfb35ebef8d57a67db59bc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0038-FsLQtO/mutant.json.supervisor.json",
    "supervisorSha256": "52b6a683583ba1c63d5a825efe7fbe6563e21dc2c9039e54fc2d5c8de9bace4a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0039",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "bac4f0615c272ef3ad934026fc372aedf08d1283b502b87acbe22e5aaaa74905",
    "selector": "Operator Restore workflow keeps an out-of-window prepared restore actionable immediately and after loading persisted timeline history",
    "selectorCorrection": null,
    "launch": 97,
    "resultPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/baseline.json",
    "resultSha256": "0264911aefe0e748b9abccc54d6a46a09c4f80bb98e8a0f2576f4fd5f95a9109",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/baseline.json.supervisor.json",
    "supervisorSha256": "270c286281926bfa7d40f425ba113b02b532b44dd3caf85f6b29fe68602ca5f0",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0039",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx",
    "originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e",
    "mutantSha256": "bac4f0615c272ef3ad934026fc372aedf08d1283b502b87acbe22e5aaaa74905",
    "selector": "Operator Restore workflow keeps an out-of-window prepared restore actionable immediately and after loading persisted timeline history",
    "selectorCorrection": null,
    "launch": 98,
    "resultPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/mutant.json",
    "resultSha256": "9418e187ab2b375cf95ebe82924276f203f9f0fd6b0db0844fb1eca921068210",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0039-YBoBDj/mutant.json.supervisor.json",
    "supervisorSha256": "9a33851444829d5bff255bb65eef6a4092eb73fb2eed38fbbc670c2baa8d6a23",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0040",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7abd2dcfa98e6985dcf68efde0763762013efe3e6c0abbded4fe88c0666f8c6e",
    "selector": "Operator Restore workflow pages independently of the transcript and sends the exact timestamp and current scope",
    "selectorCorrection": null,
    "launch": 99,
    "resultPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/baseline.json",
    "resultSha256": "6a8a851413eb6cdb05a9d7a47305cd6c64a78e4ac0b50be22e60a63ab593c6d6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/baseline.json.supervisor.json",
    "supervisorSha256": "14dacbbbd262cb5a7d5f189a7e2f80e2b20bb7a6252f7c27b146feac6f9864c0",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0040",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "7abd2dcfa98e6985dcf68efde0763762013efe3e6c0abbded4fe88c0666f8c6e",
    "selector": "Operator Restore workflow pages independently of the transcript and sends the exact timestamp and current scope",
    "selectorCorrection": null,
    "launch": 100,
    "resultPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/mutant.json",
    "resultSha256": "0c5300eb102c2cd1deaa71b4f4318d25d4c707bc8b308086e7d7cfd597675399",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0040-9PgQiA/mutant.json.supervisor.json",
    "supervisorSha256": "8fa91668ab0ad255a31f802a51ecff2ce892cc188ac97d30ee2c46b79b034429",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0044",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "31f157b11041735feeec5165a4f2ebf75c8fa7130478655f5f0ca3b74179db89",
    "selector": "Operator Restore workflow discards a slow previous-scope timeline page after the owner changes location",
    "selectorCorrection": null,
    "launch": 101,
    "resultPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/baseline.json",
    "resultSha256": "3734e47433de6ea444ac4df590dac10778e74f503e0f8bd4df19a12e7d39e3f9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/baseline.json.supervisor.json",
    "supervisorSha256": "cce2a01eb8e9892a5265fd7f0889dadc00c5557afab95c346de8c0f6ed7c8ce4",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0044",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "31f157b11041735feeec5165a4f2ebf75c8fa7130478655f5f0ca3b74179db89",
    "selector": "Operator Restore workflow discards a slow previous-scope timeline page after the owner changes location",
    "selectorCorrection": null,
    "launch": 102,
    "resultPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/mutant.json",
    "resultSha256": "6f96e5cdcf041da4917fe97b0926afa8ff929d2b8830d384299dcd8b7bf9cc14",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0044-DTXfa5/mutant.json.supervisor.json",
    "supervisorSha256": "a635f6b0752c8e1b3ce558f49cce3eae3420d7070a6ac7abc48a209f2dde04c0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0045",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "c5c4045ef07a3bb912bb4f993618893bc80722527ab467bb5d1c70322fa99b34",
    "selector": "Operator Restore workflow retries a failed timeline read without treating it as empty history",
    "selectorCorrection": null,
    "launch": 103,
    "resultPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/baseline.json",
    "resultSha256": "19d4724616d31fdc1f98b945b05d221195fa5337423287bf39d8500e94b866f0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/baseline.json.supervisor.json",
    "supervisorSha256": "2db7624b42a4b945f0be53a5ab877283d70a161481a7d009fd23d292993e4df9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0045",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts",
    "originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df",
    "mutantSha256": "c5c4045ef07a3bb912bb4f993618893bc80722527ab467bb5d1c70322fa99b34",
    "selector": "Operator Restore workflow retries a failed timeline read without treating it as empty history",
    "selectorCorrection": null,
    "launch": 104,
    "resultPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/mutant.json",
    "resultSha256": "b98b52126ca43eee255f1cc7008eb7cd32509a675510b251f961a8650410ada2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0045-Fa1zOh/mutant.json.supervisor.json",
    "supervisorSha256": "f23fce71c30632607208820ef203799c349f512678cfdd0d089d412be6eadcd5",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0056",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "a534f2cabff2cb66a4129bc380526d614564e66f01535e49e01c5de44a2b0c03",
    "selector": "useProposalWrites sends the typed phrase unchanged and explains a mismatch without losing the pending proposal",
    "selectorCorrection": null,
    "launch": 105,
    "resultPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/baseline.json",
    "resultSha256": "c2a22a44e33fb2505e093a3b4adf3e024ed329ebd14786be28a0c41dca0c8d40",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/baseline.json.supervisor.json",
    "supervisorSha256": "7abe198d8f32e50931d77d1d1f5bcee1826693512e58d39bf8b2f80d63b51bfd",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0056",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "a534f2cabff2cb66a4129bc380526d614564e66f01535e49e01c5de44a2b0c03",
    "selector": "useProposalWrites sends the typed phrase unchanged and explains a mismatch without losing the pending proposal",
    "selectorCorrection": null,
    "launch": 106,
    "resultPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/mutant.json",
    "resultSha256": "47ca20f6e8a3308a83c24edb7087940913f6e1b1d39dd24b102be71515a2c298",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0056-Y03XfK/mutant.json.supervisor.json",
    "supervisorSha256": "4174b0bda01df943a92e73a4c27f4be2fa4db593eb8a1931a100974db93d0047",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0057",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "selector": "useProposalWrites Apply posts the prepared version token and repaints the card from the returned row",
    "selectorCorrection": null,
    "launch": 107,
    "resultPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/baseline.json",
    "resultSha256": "20f29244e082b6381b9a7ba44c31cb1005444f4788730ae63da6392c54bc71f0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/baseline.json.supervisor.json",
    "supervisorSha256": "9c812f9e186ae6704177653a3a37843201c1003dce08c520174bc9d1a07c7857",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0057",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f823e55829ceed1985bbcceed00286a64b7f35750bfbdad3211a552b2e782d9c",
    "selector": "useProposalWrites Apply posts the prepared version token and repaints the card from the returned row",
    "selectorCorrection": null,
    "launch": 108,
    "resultPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/mutant.json",
    "resultSha256": "c958c1a2251fb5aa1cfa8670508a1e333ca2aab56f7130255296940cf629d9fc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0057-ancIrl/mutant.json.supervisor.json",
    "supervisorSha256": "c2214751120ebc79cc1a2ea5c305b0d5d19f3d5ec8677fe22b467b864c5d7fe4",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0058",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "c4343bdd40b42972e8816c631504a332db4e95aa5cb8e394c47b47525f5b36b4",
    "selector": "useProposalWrites Not now posts no body and still refetches the transcript",
    "selectorCorrection": null,
    "launch": 109,
    "resultPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/baseline.json",
    "resultSha256": "35970c2caf6821c5ad062bb466d61e86abed5458eac30fe023ebafaceeddad38",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/baseline.json.supervisor.json",
    "supervisorSha256": "888f24165b8fb858d163405844a31b029796d5b28336a77a7609880a50f37905",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0058",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "c4343bdd40b42972e8816c631504a332db4e95aa5cb8e394c47b47525f5b36b4",
    "selector": "useProposalWrites Not now posts no body and still refetches the transcript",
    "selectorCorrection": null,
    "launch": 110,
    "resultPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/mutant.json",
    "resultSha256": "b208b0f60bb49060cc1a266c238967be45a77dfe2814065f4c5f983961feb4ec",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0058-FfoGSC/mutant.json.supervisor.json",
    "supervisorSha256": "147ed582389aea3756a935fc68a04ce6dc00c39f142efcd05e4ee46f1121974b",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0059",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "useProposalWrites a 409 repaints the card from the stored row AND names the refusal",
    "selectorCorrection": null,
    "launch": 111,
    "resultPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/baseline.json",
    "resultSha256": "da1c24cd47dedfc94ea5f86315d9971c975d01c0527e804e984e88a09265033e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/baseline.json.supervisor.json",
    "supervisorSha256": "3a9133993b5928696bab5684e627bbb51a06ad4403f3a2d07e98736dcd1e4d6f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0059",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "4a5aa8c6eadfb05fba7f0801c7dd860cb00275b1f08af8c415e7a2d162b838d0",
    "selector": "useProposalWrites a 409 repaints the card from the stored row AND names the refusal",
    "selectorCorrection": null,
    "launch": 112,
    "resultPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/mutant.json",
    "resultSha256": "ebd4edb723acb3b4808e65890be726b913b14ba76a40bd2db65c43b2ca51e9a7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0059-Onzhuu/mutant.json.supervisor.json",
    "supervisorSha256": "28ea56b9695d2109d4e9790d93f01ce80488723b325dad4539a5ce6e178f67c7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0060",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f302727add526b9da23c7ef5b40b375a09173bc2531e7cd3c95d06113810d0f8",
    "selector": "useProposalWrites a write that never reaches the server says so on the card",
    "selectorCorrection": null,
    "launch": 113,
    "resultPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/baseline.json",
    "resultSha256": "78fed9a9959925066bd95b6af11c3af259343be02d4e8231e2d8c58f9c002de1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/baseline.json.supervisor.json",
    "supervisorSha256": "4f4083def32d7a650dd5bffbc3214709bdf5e0281ee1fefc9f4e34ad9c97665b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0060",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "f302727add526b9da23c7ef5b40b375a09173bc2531e7cd3c95d06113810d0f8",
    "selector": "useProposalWrites a write that never reaches the server says so on the card",
    "selectorCorrection": null,
    "launch": 114,
    "resultPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/mutant.json",
    "resultSha256": "7b33861e3022e11d4091efafdd3f5d88bdcfcac89422168b7fa55f3a0e7579b2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0060-GKkrvf/mutant.json.supervisor.json",
    "supervisorSha256": "31ce9fc6c840b9217f7f023f3fb99d3a2cd73406c28a158c2eedbb7d2b225be8",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0061",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "131b86df43c7e8ae2557755f45981e85bc9205cf53f5ee520dd021acf726ad38",
    "selector": "useProposalWrites a 404 operator_disabled ends the session rather than marking the card",
    "selectorCorrection": null,
    "launch": 115,
    "resultPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/baseline.json",
    "resultSha256": "b23e4c1fccc1fe2b50caff33930124f07450aab0c86c990e70cdbc34b67f8286",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/baseline.json.supervisor.json",
    "supervisorSha256": "4162f5f9998572ccbd531217956cb2213d89bf311d6a8144bf969bfd42e1c67e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0061",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "131b86df43c7e8ae2557755f45981e85bc9205cf53f5ee520dd021acf726ad38",
    "selector": "useProposalWrites a 404 operator_disabled ends the session rather than marking the card",
    "selectorCorrection": null,
    "launch": 116,
    "resultPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/mutant.json",
    "resultSha256": "b2a30444643f2cf1e3ddc5fb733e6f686c99abd768c13fd0e0982c4b6f2fb26e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0061-XP9l2p/mutant.json.supervisor.json",
    "supervisorSha256": "3a48f19969169e0604234e35201defd8774b8f52f3aeaf9da589afb62e47bdac",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0062",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "9bc3bf4f04dc42e0c72bd29584412a2750814e4eea0926d3c7735eacf677b886",
    "selector": "useProposalWrites one write at a time: a second Apply while the first is in flight is ignored",
    "selectorCorrection": null,
    "launch": 117,
    "resultPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/baseline.json",
    "resultSha256": "6f607909a136a140d1ac0362003981bd0ec631486d5f9ce625a6ebc967920f41",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/baseline.json.supervisor.json",
    "supervisorSha256": "d913837542e08869e6f063de024a7a324a13c71fa616bda8b91316434e4bf2ac",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0062",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/(authenticated)/dashboard/operator/useProposalWrites.ts",
    "originalOid": "4a736a6f6d52ee5f7a0dc2a7035f7000a0335d79",
    "mutantSha256": "9bc3bf4f04dc42e0c72bd29584412a2750814e4eea0926d3c7735eacf677b886",
    "selector": "useProposalWrites one write at a time: a second Apply while the first is in flight is ignored",
    "selectorCorrection": null,
    "launch": 118,
    "resultPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/mutant.json",
    "resultSha256": "83d23b4909b8072ea1ef71c2038d84eb447ba830cf129b9c570dc172053398e2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0062-P8rt1P/mutant.json.supervisor.json",
    "supervisorSha256": "20a9b45d745ab073c7502cf46ff9a1f30577fe2cc35d21b020869a4e32fecd87",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0066",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "3c7cfa5f0cc9b9adb27785e4c032113922fe3fdc1f963218a37d26e892b3f6d4",
    "selector": "POST /api/operator/proposals/\\[id\\]/apply POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409",
    "selectorCorrection": null,
    "launch": 119,
    "resultPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/baseline.json",
    "resultSha256": "9ae48d49dd50ed3f1a76dfacebccdc145596dd83d90dc520bea8278080f0cabc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/baseline.json.supervisor.json",
    "supervisorSha256": "0d5bf7a3a1681e65aff48c2e9236f35e66494f82067e9d1e29933645a5542ce5",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0066",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "3c7cfa5f0cc9b9adb27785e4c032113922fe3fdc1f963218a37d26e892b3f6d4",
    "selector": "POST /api/operator/proposals/\\[id\\]/apply POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409",
    "selectorCorrection": null,
    "launch": 120,
    "resultPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/mutant.json",
    "resultSha256": "30523dff2871d4bae6aa4fff696da3cb49749fd79b5544834e5deeaabdff943d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0066-vQdpL0/mutant.json.supervisor.json",
    "supervisorSha256": "fd729c668fe92a8c65730cafa2129f45baaf77940b11a280b0929e6503e570e1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0067",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "692d6de1676071497eef06fcbda889d5e52de4f79b3182bcd83b0f56e0943eab",
    "selector": "POST /api/operator/proposals/\\[id\\]/apply POST apply passes a policy token and the typed scope through verbatim and maps confirmation_mismatch to 400 and expansion_blocked to 409",
    "selectorCorrection": null,
    "launch": 121,
    "resultPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/baseline.json",
    "resultSha256": "29e242a1edbd6a0e72193f61252f5150ab591896d283b11a102ec92118da70ee",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/baseline.json.supervisor.json",
    "supervisorSha256": "54888be39356f4ed0df4c150ef913e3ea3a7b1c62e3babbd0dfd18f17051aab0",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0067",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/apply/route.ts",
    "originalOid": "9eca8144b8025e900bb14a13ff756e11c5438c65",
    "mutantSha256": "692d6de1676071497eef06fcbda889d5e52de4f79b3182bcd83b0f56e0943eab",
    "selector": "POST /api/operator/proposals/\\[id\\]/apply POST apply passes a policy token and the typed scope through verbatim and maps confirmation_mismatch to 400 and expansion_blocked to 409",
    "selectorCorrection": null,
    "launch": 122,
    "resultPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/mutant.json",
    "resultSha256": "c29bde4b0a8eac3f2f13e78b50edee490c3966b956eddac61cbee46f919cefc6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0067-QCNwrX/mutant.json.supervisor.json",
    "supervisorSha256": "90457f3df7a80f621ca004833f454553d42fc808929aac62973938397cc4bd5e",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0068",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation preserves each stored turn refusal list in a resumed conversation GET",
    "selectorCorrection": null,
    "launch": 123,
    "resultPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/baseline.json",
    "resultSha256": "8a8fc122058ca83678dcd3464722783a335997fbd069aa99f7550a6a31881214",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/baseline.json.supervisor.json",
    "supervisorSha256": "b0ad99e3b79689ff6c7254f44670eb9900319de37c695e2ce755578a3e66f9e7",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0068",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation preserves each stored turn refusal list in a resumed conversation GET",
    "selectorCorrection": null,
    "launch": 124,
    "resultPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/mutant.json",
    "resultSha256": "90cd25d28f567d795c80475299d0fc82a329a5c0889eaadca3b735989c3bb42f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0068-dXEsCV/mutant.json.supervisor.json",
    "supervisorSha256": "e6d00db78095b5a3cbfa7caa554507d49258a78d5a61298b4fba5905c4868199",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0069",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation GET conversation returns the actor's most recent conversation and the summary reads with timestamps",
    "selectorCorrection": null,
    "launch": 125,
    "resultPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/baseline.json",
    "resultSha256": "5ff41b39c1d8b301f5a27d982fd37690b8dc13c3f96993966dd6c7a36e0f0204",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/baseline.json.supervisor.json",
    "supervisorSha256": "3c618eb30d6eff1eaf934df3e4213a67c49a8e64aa088d335dc44be7c2df522f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0069",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation GET conversation returns the actor's most recent conversation and the summary reads with timestamps",
    "selectorCorrection": null,
    "launch": 126,
    "resultPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/mutant.json",
    "resultSha256": "39ef170c37f1790ff493cc7f81f9bebd967f2dca430ed7976f7196c9ff6b3d79",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0069-KeIdxi/mutant.json.supervisor.json",
    "supervisorSha256": "1be93df860661e1d04a187f5b8158166881b4d2affd80994f30cfb048e1954f1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0070",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation scopes the summary to \\?locationId= when the conversation has no turns",
    "selectorCorrection": null,
    "launch": 127,
    "resultPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/baseline.json",
    "resultSha256": "06f5e5ab12b5d679e3742af1b2d59ffd961dd5cebdbce9659aac37191d26cbb7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/baseline.json.supervisor.json",
    "supervisorSha256": "ca93c3e36456fee8b9bbab78de0aed72abc9003e8e655ec851fd012d12ef721b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0070",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation scopes the summary to \\?locationId= when the conversation has no turns",
    "selectorCorrection": null,
    "launch": 128,
    "resultPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/mutant.json",
    "resultSha256": "6d4d53ed824f4415e0e367305a1316917f8908c851ba2b5169c4441e8348d147",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0070-1ZWa8X/mutant.json.supervisor.json",
    "supervisorSha256": "1df33aa02e811906fd50f54e466fc578003a27c4e95f2ef3a7fe7b13972405b0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0071",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation answers 404 location_not_found for an unusable location, with or without a conversation",
    "selectorCorrection": null,
    "launch": 129,
    "resultPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/baseline.json",
    "resultSha256": "c8a3d03c956294812397991fdbe51eb4e6014984fd4d3bb35465c68f7b94bc22",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/baseline.json.supervisor.json",
    "supervisorSha256": "21092dff97ca3fb72b5f68330fc9e9b878b129240b6f78228db6d1d26404e18e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0071",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation answers 404 location_not_found for an unusable location, with or without a conversation",
    "selectorCorrection": null,
    "launch": 130,
    "resultPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/mutant.json",
    "resultSha256": "10a8ee62dc4c0566df66551f6495192f5be96e92d5fcbd0a255ce5b4138dde6b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0071-0CN0hq/mutant.json.supervisor.json",
    "supervisorSha256": "6b662be2cbe9ef54472f6780b9f284f4cbda181e27ccb98142d84ff2ddd93b1a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0072",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation omits the summary for an account that may not read dashboard data",
    "selectorCorrection": null,
    "launch": 131,
    "resultPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/baseline.json",
    "resultSha256": "33815121291e3ab8fa489519b22d444fd13f714777f926d4a303221e7a2eb81a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/baseline.json.supervisor.json",
    "supervisorSha256": "6d527182d1207b1cc33d7b21ccd7777f8677d0a47fdd393a14ac4fe5b67a4542",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0072",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET /api/operator/conversation — location scoping GET conversation omits the summary for an account that may not read dashboard data",
    "selectorCorrection": null,
    "launch": 132,
    "resultPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/mutant.json",
    "resultSha256": "3a4cf73c6fdebb0b76b237061534b617076a0adba396b47b32827ec818756ce2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0072-S3AWlR/mutant.json.supervisor.json",
    "supervisorSha256": "eb5fae7ca0e2caa1b9c59a9004bfbbf0691440cd160f8897adcde70deb65b647",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0080",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "selector": "POST proposal Restore preparation prepares a pending card from the authenticated actor and source ID without applying anything",
    "selectorCorrection": null,
    "launch": 133,
    "resultPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/baseline.json",
    "resultSha256": "0e9c0ab368bf977d26b4051fa2afdc5a5ac02a017763e12d0498681d141e616e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/baseline.json.supervisor.json",
    "supervisorSha256": "833fbecdcb0da4aa0546141b17b823275d18c92f1cfd942932e73d951f84da86",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0080",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "selector": "POST proposal Restore preparation prepares a pending card from the authenticated actor and source ID without applying anything",
    "selectorCorrection": null,
    "launch": 134,
    "resultPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/mutant.json",
    "resultSha256": "9826336aa09a7f4bf7ce3942489addf5814879e1ffc9db1b1ad59d7e779c3f30",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0080-SUIsvk/mutant.json.supervisor.json",
    "supervisorSha256": "190b39f849f5baa275bf78a7fd368c77fbbf192989ad89b153fbf4d2bb3b106c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0088",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "bf21fb043cbc0fb27e9867a45a7377a7c8149bb8add330ac67bcf1b49241b192",
    "selector": "POST proposal Restore preparation maps not_found to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 135,
    "resultPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/baseline.json",
    "resultSha256": "22a1dfe7ebeed67c99bee762637e6d12669566234ce38478347341ba68b28781",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/baseline.json.supervisor.json",
    "supervisorSha256": "faee57a6be279cb0695ec733dafe098ca96b1c8a4e756d812495e5cf16be357f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0088",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "bf21fb043cbc0fb27e9867a45a7377a7c8149bb8add330ac67bcf1b49241b192",
    "selector": "POST proposal Restore preparation maps not_found to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 136,
    "resultPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/mutant.json",
    "resultSha256": "1da0f8b5217421ec5ee7dc55e7b75f69b8a379ce9c03dcccaa175741c8f8210a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0088-eIvL7V/mutant.json.supervisor.json",
    "supervisorSha256": "452bffd90275e4b5eab6f35c20ae14f519c21f1801161278f9a00e1a6f5020c1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0089",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "038c113fd0aafbd051be59871f184f307e43e75fafb106f2b6b5fa08ce6329a7",
    "selector": "POST proposal Restore preparation maps not_applied to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 137,
    "resultPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/baseline.json",
    "resultSha256": "20af589315a4c6095e6e4b684738f6217845c66bd8400a3d8d5680a2f348da3f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/baseline.json.supervisor.json",
    "supervisorSha256": "a97cc481c944e63d5838d4de4ee46ee77052d18c01221b911dcb8ed3afc8c512",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0089",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "038c113fd0aafbd051be59871f184f307e43e75fafb106f2b6b5fa08ce6329a7",
    "selector": "POST proposal Restore preparation maps not_applied to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 138,
    "resultPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/mutant.json",
    "resultSha256": "0be4860612e70136cda768d2da822e590c897e4b88bf865f88534e4d4d543d17",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0089-7SFq8L/mutant.json.supervisor.json",
    "supervisorSha256": "e3cf6301f0037ea8a2cfcabdccca987f8a587d1a24136f5656d789dbd0821a8b",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0090",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "36e20709e98692586b6560df0ff1c961afbdea52582a25758ad4a5904e30df12",
    "selector": "POST proposal Restore preparation maps invalid_source to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 139,
    "resultPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/baseline.json",
    "resultSha256": "6dc7e4a72209fcb930e7c63a256bd0a20f5d4675469532e57eabd6994fecadc3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/baseline.json.supervisor.json",
    "supervisorSha256": "950a556d49b66fd26d43a78e1ebe66f44c285810d3888b2d31bd9b2350a34717",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0090",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "36e20709e98692586b6560df0ff1c961afbdea52582a25758ad4a5904e30df12",
    "selector": "POST proposal Restore preparation maps invalid_source to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 140,
    "resultPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/mutant.json",
    "resultSha256": "1754ac411acfc265b040ba0a94c53cbb1f48fbf78bfb369db424b9ab79949be6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0090-tZR3Dn/mutant.json.supervisor.json",
    "supervisorSha256": "f754da4b84362dac6a0c131d7d9a6cd506c63f9d7fc79a3367fd297abe57e3d6",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0091",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "514604a7388c46d2ce2b5e670a51abb41995c0631cf3b87e05bbc54c98624389",
    "selector": "POST proposal Restore preparation maps unauthorized to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 141,
    "resultPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/baseline.json",
    "resultSha256": "0451a834f28d67f07696f78fb5517f62f2c1e70e3f688e94e9310a71ca117717",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/baseline.json.supervisor.json",
    "supervisorSha256": "c544990aee409ced239d9fb081eff6ff60516d5f08c88527c59df18def9255c3",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0091",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "514604a7388c46d2ce2b5e670a51abb41995c0631cf3b87e05bbc54c98624389",
    "selector": "POST proposal Restore preparation maps unauthorized to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 142,
    "resultPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/mutant.json",
    "resultSha256": "9fc561ea8f0e1ac497ae56a31339db51b1d11f27f00733ee88ddf17204027af0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0091-oCdxot/mutant.json.supervisor.json",
    "supervisorSha256": "c9780aa908feb62829224c5ac7f7e2405ee8f67c8a0201213d0b819cbe4ea111",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0092",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "f5b645527b042b05f84ba6b311b8f25082ec3b59f8e10639c391f51f5492ab38",
    "selector": "POST proposal Restore preparation maps location_not_found to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 143,
    "resultPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/baseline.json",
    "resultSha256": "ce19bb45b64def4d030295c91d77f54ebbde60a727788230c5abb12ba17a69ee",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/baseline.json.supervisor.json",
    "supervisorSha256": "4c619265b66249e1f7f1e18b8a352bf40c0f939159f9bdd92042178b064806f8",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0092",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "f5b645527b042b05f84ba6b311b8f25082ec3b59f8e10639c391f51f5492ab38",
    "selector": "POST proposal Restore preparation maps location_not_found to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 144,
    "resultPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/mutant.json",
    "resultSha256": "1d3593fa0175f6185090fa1a484ce2f447ce7d4cf0c402de824dd9725cb68309",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0092-7aNLH3/mutant.json.supervisor.json",
    "supervisorSha256": "6c710115929a8b73e72faeac119d14206f0754f80a59fcc47b85ade0cb7d43f8",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0093",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "c5710880bc312d1514fdca00a24a3099fd5383eef94817cf54daeff4055b7e6c",
    "selector": "POST proposal Restore preparation maps no_history to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 145,
    "resultPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/baseline.json",
    "resultSha256": "ea47aa62105f512d7071665b5904498f06b8ce5cf4e0ab30d1ac7f21e8e4e983",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/baseline.json.supervisor.json",
    "supervisorSha256": "c799e0588d4c48ec6909a6971d5833216d1e7508158b090ff0af2512090c2c03",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0093",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "c5710880bc312d1514fdca00a24a3099fd5383eef94817cf54daeff4055b7e6c",
    "selector": "POST proposal Restore preparation maps no_history to an owner-readable failure",
    "selectorCorrection": null,
    "launch": 146,
    "resultPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/mutant.json",
    "resultSha256": "076bb5990b8c959200383dba09e59a6f04d84539c0360a175a33c73d2d063469",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0093-9ykvQi/mutant.json.supervisor.json",
    "supervisorSha256": "1a4681d6d3cf1e38c3b749f942d17c4bc96a7b860b4daac5b63e9bc0c246fbdd",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0094",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "selector": "POST proposal Restore preparation returns retry-safe preparation identity and a sanitized unexpected failure",
    "selectorCorrection": null,
    "launch": 147,
    "resultPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/baseline.json",
    "resultSha256": "f0261be342dfa5b10845d6990a0e42ff7d38ffea4d045317d33096a4cfde4b17",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/baseline.json.supervisor.json",
    "supervisorSha256": "861c00f1c21a73e3bbb4daf5423a8da1aa002032e6767ff12cdea12637392216",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0094",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/proposals/[id]/restore/route.ts",
    "originalOid": "b23d9a83c5ce92cf91aa21dc85b91329988a228e",
    "mutantSha256": "fa0cb0b6e9a3257cad890def5d046a831636ea0ecb231e6932b6c074ebf9a5b3",
    "selector": "POST proposal Restore preparation returns retry-safe preparation identity and a sanitized unexpected failure",
    "selectorCorrection": null,
    "launch": 148,
    "resultPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/mutant.json",
    "resultSha256": "9884ece5afcf1fdb51c36ede516ac1024fb3fe92d2bec8f7c077567c3e910466",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0094-YBTXx3/mutant.json.supervisor.json",
    "supervisorSha256": "9268fc44aff5454323e0dd78770619b1b59228e615bd0a5ae497202bba9dbcaf",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0095",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline scopes every read to the authenticated account and preserves pending restores and raw cursor precision",
    "selectorCorrection": null,
    "launch": 149,
    "resultPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/baseline.json",
    "resultSha256": "71966ddcb9de66bac26bec840b89ac562fd9c66430d8d2acb6e0856bd7d3f8d5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/baseline.json.supervisor.json",
    "supervisorSha256": "30fae850a11597694dae09df688025f16ca5fcf98210c20d390e85bba88da13b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0095",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline scopes every read to the authenticated account and preserves pending restores and raw cursor precision",
    "selectorCorrection": null,
    "launch": 150,
    "resultPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/mutant.json",
    "resultSha256": "a8bfd6df670484c658519ba08c433a9e6b32d316e16ed94f7ca252db13ba8e3e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0095-zyeUXD/mutant.json.supervisor.json",
    "supervisorSha256": "587e93bd08953f7b17228f291a6fe5247b25f1b9e27b41f7cd3b0b5884b2eed2",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0096",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline allows the account-wide history read without a writable subscription or Origin",
    "selectorCorrection": null,
    "launch": 151,
    "resultPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/baseline.json",
    "resultSha256": "63cae7a0dba2474a79ba27e269f54c3e829fbaa0aa8eef42e3b94c5a2ef6c83f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/baseline.json.supervisor.json",
    "supervisorSha256": "1b3d9ed94844ac2c85a19e407306117336baef061d3e75377339710b499bdb62",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0096",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline allows the account-wide history read without a writable subscription or Origin",
    "selectorCorrection": null,
    "launch": 152,
    "resultPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/mutant.json",
    "resultSha256": "e00ebc5d7801f15b8f91160166f2f594f2b2cb02a60e34ae01a4487f749695d5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0096-yPx4tU/mutant.json.supervisor.json",
    "supervisorSha256": "b0621255219badc9473d3b4748229a8234d5f5dc95e921576f6cb49c92db96c7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0097",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "6991fef051c29d38f32f5b9413fedcc99f61986859386761e5169f9182ca3544",
    "selector": "GET Rules timeline rejects disabled and unauthenticated reads before the domain query",
    "selectorCorrection": null,
    "launch": 153,
    "resultPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/baseline.json",
    "resultSha256": "65884851c8280aabe7932c8299bdd045ababca5e7e9b723117dad8d777b94d9d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/baseline.json.supervisor.json",
    "supervisorSha256": "d46cea95b02afe0f689f81170338d3a628596b5048a183f7f734427377d574c4",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0097",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "6991fef051c29d38f32f5b9413fedcc99f61986859386761e5169f9182ca3544",
    "selector": "GET Rules timeline rejects disabled and unauthenticated reads before the domain query",
    "selectorCorrection": null,
    "launch": 154,
    "resultPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/mutant.json",
    "resultSha256": "0cadf97137313dfd84fecbee8b9a4d81c7dc39dbc60039adcb6ad08edcef14fd",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0097-AjOISk/mutant.json.supervisor.json",
    "supervisorSha256": "38d8773d7afd7f16ae2bf2823d6bf7ab3fc0e1c6b76aa718856f13deac7c70b7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0098",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?locationId=bad",
    "selectorCorrection": null,
    "launch": 155,
    "resultPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/baseline.json",
    "resultSha256": "7d75d8f122a10c744e93c737325498f730afe13d8e1a39b608b9aae8eb088ddf",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/baseline.json.supervisor.json",
    "supervisorSha256": "303abfb56789db2f09f38bbee80af4834130a6199bf061af6b039bf66a0be72e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0098",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?locationId=bad",
    "selectorCorrection": null,
    "launch": 156,
    "resultPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/mutant.json",
    "resultSha256": "6f89e168c5799d566a7f692e91cf355dbac5fab93f5dc138aaf114d2c3976ea3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0098-GWbwLE/mutant.json.supervisor.json",
    "supervisorSha256": "c89a5043669feaca0a5d324ef710870e61db3b96daf8deea58a6dacd5f0df0b3",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0099",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=0",
    "selectorCorrection": null,
    "launch": 157,
    "resultPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/baseline.json",
    "resultSha256": "accfad9e928c6093b23fdab3773369c7586805891b39051e2e44529b406502df",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/baseline.json.supervisor.json",
    "supervisorSha256": "b3d4b241ab530e1df288a7dc7e694f8863278ea1d97c22ab3c98539ca40fade9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0099",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=0",
    "selectorCorrection": null,
    "launch": 158,
    "resultPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/mutant.json",
    "resultSha256": "ca6dc85b4025f277c614609de294895aaad752f6361ff926e20bff6b88fbb96c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0099-zc9tp7/mutant.json.supervisor.json",
    "supervisorSha256": "db2832daadc9fd0a63ee318e03a9e66f597b252e5a1271531c01c758d0c486e1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0100",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=51",
    "selectorCorrection": null,
    "launch": 159,
    "resultPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/baseline.json",
    "resultSha256": "c465c9b08d076cbcb82fa580ed13886f701807966764acb74e3355f1c2a1ecad",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/baseline.json.supervisor.json",
    "supervisorSha256": "1a712a468936fa586072e4cff263c04d36fe8217c49adeebb86e3c0485a0c3d1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0100",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=51",
    "selectorCorrection": null,
    "launch": 160,
    "resultPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/mutant.json",
    "resultSha256": "0d357e37d6f7b9aa6b03ca44fbb4ffea0b639c6fc31be118944a1a9a77ed4136",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0100-WmjEly/mutant.json.supervisor.json",
    "supervisorSha256": "7c3f5cac53aa76a75db28686223bc9e88369ba88d330a93c6d3ed06a79915ed7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0101",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=1\\.5",
    "selectorCorrection": null,
    "launch": 161,
    "resultPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/baseline.json",
    "resultSha256": "65e8d70eeef01fca625b64a4c9f438264239cf50b1fcd17ae33bc44ffc231020",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/baseline.json.supervisor.json",
    "supervisorSha256": "6f5fc53d410e3fcebddbd42f7d6ec5738027638931b16bd01bedd772beeee247",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0101",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=1\\.5",
    "selectorCorrection": null,
    "launch": 162,
    "resultPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/mutant.json",
    "resultSha256": "ac218650b7c074bf5d71e3e5fe2c1bffc1477b85ad2d150ced9091eb34f9cd85",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0101-mxtFNH/mutant.json.supervisor.json",
    "supervisorSha256": "75982a6be81ed09e1e282a6ec42d3e6e648678919e13fab7eb59a6c9cce9349f",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0102",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=bad",
    "selectorCorrection": null,
    "launch": 163,
    "resultPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/baseline.json",
    "resultSha256": "4e6e1f1c74879c818e404b980935f819e8b9de49c5fd75764c8606f5de765d5e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/baseline.json.supervisor.json",
    "supervisorSha256": "b61c0ebae4d45339ec4a59d360ca3f753a3dca1967a3a908efeb30d4ad41d15e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0102",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=bad",
    "selectorCorrection": null,
    "launch": 164,
    "resultPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/mutant.json",
    "resultSha256": "4817f6bcde5842bd235b67fd76b7fe98a4c7290a2e1430c156b9dd15c4a8dac2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0102-GOmW7G/mutant.json.supervisor.json",
    "supervisorSha256": "fa0b581d13ff1795ac4806b96ac3ed1af6f5366813d93e702b8055307af5884a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0103",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=00000000-0000-4000-8000-000000000003",
    "selectorCorrection": null,
    "launch": 165,
    "resultPath": "/private/tmp/operator-continuation-rt-0103-Vwagrm/baseline.json",
    "resultSha256": "8491ee4b5ed68d07d145c8863f4b86eb9ff7bcee6d478e5035d641b17da797e3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0103-Vwagrm/baseline.json.supervisor.json",
    "supervisorSha256": "4cb69332d36ce7334c872715a904641c76e9c13a7d6637e97dc4917248032697",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0104",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorAppliedAt=2026-09-14%2020%3A00%3A00\\.123456%2B00",
    "selectorCorrection": null,
    "launch": 166,
    "resultPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/baseline.json",
    "resultSha256": "94ffe92a3100c27a4f7bde3f67541ee411a4d65e560a63c52430e9bf1452c460",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/baseline.json.supervisor.json",
    "supervisorSha256": "bb155a5dab54d19675f0e1810981a8a268865f4aa8c4951368580044a2e64c16",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0104",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorAppliedAt=2026-09-14%2020%3A00%3A00\\.123456%2B00",
    "selectorCorrection": null,
    "launch": 167,
    "resultPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/mutant.json",
    "resultSha256": "7a546ecb554b24a4604f3fc5b0875d6eedbbba6f91524cf4bc6ba4ee63dcf2ca",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0104-lmmAN3/mutant.json.supervisor.json",
    "supervisorSha256": "ebf0c601a8fc8dcdf8948a8b686f0cb1adcf696420e664a6a3251e3dc9d4c1e6",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0105",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=00000000-0000-4000-8000-000000000003&cursorAppliedAt=not-a-date",
    "selectorCorrection": null,
    "launch": 168,
    "resultPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/baseline.json",
    "resultSha256": "07211da5e3ce4f780dcb654686547bcf82974a2bdceccd6ceece501e37808807",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/baseline.json.supervisor.json",
    "supervisorSha256": "9b71fcc42b67924437fe71a85decc102f4ce27a18760df4d1cb65c3ded5ef995",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0105",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=00000000-0000-4000-8000-000000000003&cursorAppliedAt=not-a-date",
    "selectorCorrection": null,
    "launch": 169,
    "resultPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/mutant.json",
    "resultSha256": "8fc39faa0bae8af96d7da5f8df3d50161d9099b8bbadae723e08e53c4c0e0106",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0105-r7KEeW/mutant.json.supervisor.json",
    "supervisorSha256": "ca06d2947d3fa96dad4031ccaf2312dd2a1eba0a8e42e949b04bca90d229215e",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0106",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?accountId=foreign",
    "selectorCorrection": null,
    "launch": 170,
    "resultPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/baseline.json",
    "resultSha256": "7626df8a3e4fba42866ffc382198c9c1d6268edebde0b7957322769b3bad2811",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/baseline.json.supervisor.json",
    "supervisorSha256": "5f125c54db71b101c111a6f3054788e9ba942952e39bc36107858cf690f5bbc1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0106",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?accountId=foreign",
    "selectorCorrection": null,
    "launch": 171,
    "resultPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/mutant.json",
    "resultSha256": "a59e86b77e939b3d770095770f6e45329d64e70943d2d331648e2c18c3ad91f5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0106-v0t6Nf/mutant.json.supervisor.json",
    "supervisorSha256": "18e2f9aff6de20cc89f6628727fd1d54429cad1da687f18939008b96449754b6",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0107",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=1&limit=2",
    "selectorCorrection": null,
    "launch": 172,
    "resultPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/baseline.json",
    "resultSha256": "4c973435f59773ad13ca1192a500e93e1f45437ee9903b85d187054ac1ad80ea",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/baseline.json.supervisor.json",
    "supervisorSha256": "d449e7f941928127e6590eba9ba5ab59c79387703ebfdcfca6df05a1cdf1654e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0107",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?limit=1&limit=2",
    "selectorCorrection": null,
    "launch": 173,
    "resultPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/mutant.json",
    "resultSha256": "aa3befc03290d4163c292e0cf1fc601a37b1eab638c6e15568c8fa140eee2eb0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0107-TEE0yP/mutant.json.supervisor.json",
    "supervisorSha256": "7982632bac04f534ba4cfaa5fa3ea246c91ac35ee90d026f6eb3b2d15ea48241",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0108",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline sanitizes an unexpected read failure",
    "selectorCorrection": null,
    "launch": 174,
    "resultPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/baseline.json",
    "resultSha256": "e125ffb6b4a11a5fedd1593807d78c5cbbdf36451e354ee13fd25f433ab56cbd",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/baseline.json.supervisor.json",
    "supervisorSha256": "ea649ee704de63ac87deae3a1813fd7ff62c1bac81d602082378600b0d552ec9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0108",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "GET Rules timeline sanitizes an unexpected read failure",
    "selectorCorrection": null,
    "launch": 175,
    "resultPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/mutant.json",
    "resultSha256": "536b70c18db8c12108a5d72c8b4c15d19eb93aff65b2ec128800bcd0bb64ea52",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0108-JuynjC/mutant.json.supervisor.json",
    "supervisorSha256": "688c497b63796b0854fd603ed4a65675f6d190d4cb215ebbb7a8753b86b97946",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0121",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "selector": "applyProposal \\(live DB\\) applyProposal rolls back the receipt when the voice write throws",
    "selectorCorrection": null,
    "launch": 176,
    "resultPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/baseline.json",
    "resultSha256": "2a17a9aff44deb5c948dfaba16cc96fd4be132eaa02987188264fe15b9e2e9e2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/baseline.json.supervisor.json",
    "supervisorSha256": "6cbe6a85110a5607e4d7b1c2bd22327fdc17dc6ebbdf53d97e6705014be1f525",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0121",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "selector": "applyProposal \\(live DB\\) applyProposal rolls back the receipt when the voice write throws",
    "selectorCorrection": null,
    "launch": 177,
    "resultPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/mutant.json",
    "resultSha256": "12eff0c7ede755800f631fb136e200b57f06764f6859c571b4844018c7eb13df",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0121-m5KH6p/mutant.json.supervisor.json",
    "supervisorSha256": "950c6aa624f259b72c5b258126e3ff51420f5fa74086b74f11eef824ac3cb5bd",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0123",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "selector": "applyProposal \\(live DB\\) worker-produced proposals render and apply successfully",
    "selectorCorrection": null,
    "launch": 178,
    "resultPath": "/private/tmp/operator-continuation-rt-0123-oET87A/baseline.json",
    "resultSha256": "71a5186f19b598f2a1280b4895aa301f47fe18739b9655013c10af76efadd2fb",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0123-oET87A/baseline.json.supervisor.json",
    "supervisorSha256": "79e987e2f70d091c2113f79b2cce9948608b36368ae4f880000785340a49ef3f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0123",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "ce29b90b8ba989c585a64f95cbf99581cdfa72b4b9dc16199a7c6304b2976cd8",
    "selector": "applyProposal \\(live DB\\) worker-produced proposals render and apply successfully",
    "selectorCorrection": null,
    "launch": 179,
    "resultPath": "/private/tmp/operator-continuation-rt-0123-oET87A/mutant.json",
    "resultSha256": "949dbae83d1b65b56775ff075936ee265c16a37d27216772475e3d1c1d6c75da",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0123-oET87A/mutant.json.supervisor.json",
    "supervisorSha256": "c2627bc8441da21b95aeadd6b1e4c797519cde2e3802e39131735bbfdd0e38ba",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0124",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "63252f92e86c472de6a9f3fa379b901248a9a5a850cc98c7f575db63f25bd8f5",
    "selector": "applyProposal \\(live DB\\) repeat Apply after location archival returns the original receipt without writes",
    "selectorCorrection": null,
    "launch": 180,
    "resultPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/baseline.json",
    "resultSha256": "35d1ab7574dd6cb59d2a2c1ca86699074144d4d8c34c4e09a880c7578ac2e93b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/baseline.json.supervisor.json",
    "supervisorSha256": "1de48d7ffc27d6451e31a3a1de57f74298fcd77ef4a13e992616a3b645f9b606",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0124",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "63252f92e86c472de6a9f3fa379b901248a9a5a850cc98c7f575db63f25bd8f5",
    "selector": "applyProposal \\(live DB\\) repeat Apply after location archival returns the original receipt without writes",
    "selectorCorrection": null,
    "launch": 181,
    "resultPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/mutant.json",
    "resultSha256": "36d4d18f9615147908c32651ee195bd254ba8928b7b52bd9b17f0f13286ca472",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0124-4owlK3/mutant.json.supervisor.json",
    "supervisorSha256": "6e9b18b33fb2e5f8a835a20f235ccdfe9d11f807f9259db199158f60aa31c095",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0130",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token",
    "selectorCorrection": null,
    "launch": 182,
    "resultPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/baseline.json",
    "resultSha256": "fdbe0fb80d505766d762994c55bd7ecbcf3d1a3c7cf48ba3f69755c8830cb97f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/baseline.json.supervisor.json",
    "supervisorSha256": "853e27a3ecb5eb7d7c0844c3c6ef02386408bfd4c510d43dc7cda9a41a56a3b5",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0130",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token",
    "selectorCorrection": null,
    "launch": 183,
    "resultPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/mutant.json",
    "resultSha256": "64216db4b3faf7f4cba343f46de5f83865f94b3303e8f832ac6f04f7222755f3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0130-9G2haa/mutant.json.supervisor.json",
    "supervisorSha256": "abe0c868b88f262461600747cef83570ebf7a7f7899dbbc6dfdbfc968a779922",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0134",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner",
    "selectorCorrection": null,
    "launch": 184,
    "resultPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/baseline.json",
    "resultSha256": "997c44c00b298daee59a3b1c84618171f1d8c6ce9a580c49eeaf0d9c47fbf9f6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/baseline.json.supervisor.json",
    "supervisorSha256": "de2cfc20c03add03b14fc6d132c37de54615d027944ea0166162c8e23d631f66",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0134",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "acc68e560cd191d97692145e7f2a85c02d0e73dbc2b96370a699ba1d74030802",
    "selector": "applyProposal applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner",
    "selectorCorrection": null,
    "launch": 185,
    "resultPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/mutant.json",
    "resultSha256": "be5bc9d5c4384768db22f71d0705e24685e746c6d2e66cdd0741438dc5fd9772",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0134-CeVhlU/mutant.json.supervisor.json",
    "supervisorSha256": "36dfcf59bda5660d66dfde2cb6214d1e7ef0b9559ec1ea827821e577ea5c9433",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0144",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "3366bc3c3d8e20136cf859b54eb4bc93de31fd677eca04383d3de526d8f01962",
    "selector": "fenced reply materialization boundaries locks location requests before account requests while preserving model order and stored ownership",
    "selectorCorrection": null,
    "launch": 186,
    "resultPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/baseline.json",
    "resultSha256": "2e64d4871d966dfaddb1ed10522606c153b7a0de01a76c7843148a5ac6b312b8",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/baseline.json.supervisor.json",
    "supervisorSha256": "b53958ee197f0883cbc58c63bec3ac3820fe1ed988247c832efb1cbbebe96b38",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0144",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/turns.ts",
    "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c",
    "mutantSha256": "3366bc3c3d8e20136cf859b54eb4bc93de31fd677eca04383d3de526d8f01962",
    "selector": "fenced reply materialization boundaries locks location requests before account requests while preserving model order and stored ownership",
    "selectorCorrection": null,
    "launch": 187,
    "resultPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/mutant.json",
    "resultSha256": "c84275a14ab16f30c45c95afe844fe6de50f01566a09e73eaec55c004e419ab3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0144-Pisxai/mutant.json.supervisor.json",
    "supervisorSha256": "6d76ded81e26054477d9e8795160cacd8282fd82c36a454f2fc7d4c38708925d",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0157",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) clear override retains a suspended row and its exact dials while switching to manual",
    "selectorCorrection": null,
    "launch": 188,
    "resultPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/baseline.json",
    "resultSha256": "bbf04e4f9036f3cab20b3311251c95ce9b3c663121e53563e6ae364e68c34451",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/baseline.json.supervisor.json",
    "supervisorSha256": "68dba6ebff53ca3e586dcdc5ec2cb7537f66f2f7f92010e0731b3e592148dcad",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0157",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) clear override retains a suspended row and its exact dials while switching to manual",
    "selectorCorrection": null,
    "launch": 189,
    "resultPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/mutant.json",
    "resultSha256": "58e520a669d40f13e90897745453986f7ffdeec2040f3ba02a80ec3aa8aaf128",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0157-lxnXYV/mutant.json.supervisor.json",
    "supervisorSha256": "d9db799e8c9068013954794c895614f296a84ecfddc2f0fa15fd39124ad5513c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0158",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) clear override rejects a changed parent policy before deleting anything",
    "selectorCorrection": null,
    "launch": 190,
    "resultPath": "/private/tmp/operator-continuation-rt-0158-XT18am/baseline.json",
    "resultSha256": "a52edcf8aac46ff19271420348796ce4c14c79c2dee11cb6e1e604894cfb4582",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0158-XT18am/baseline.json.supervisor.json",
    "supervisorSha256": "b4e04ddb7ad3b1cef415a7ebc2f51afb1430ac78cfe35706baa0592981a13a92",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0158",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) clear override rejects a changed parent policy before deleting anything",
    "selectorCorrection": null,
    "launch": 191,
    "resultPath": "/private/tmp/operator-continuation-rt-0158-XT18am/mutant.json",
    "resultSha256": "3df520611e3e0418c8a210165a581d0a59e7280a54db221c5e1cc54f88fbdfc5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0158-XT18am/mutant.json.supervisor.json",
    "supervisorSha256": "32394b624bbe6f2b86fffd6314820e8ed344665748e1be2cbfcb614f160bde4f",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0159",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) first dial-only override is manual, inherits the other dial, and preserves voice and other-location proposals",
    "selectorCorrection": null,
    "launch": 192,
    "resultPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/baseline.json",
    "resultSha256": "d67350e2271995613585fe334458c3be8faae52936e58351eea752b26eeaac16",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/baseline.json.supervisor.json",
    "supervisorSha256": "70177c2a08a2f99afea1282707d8b690a84a3af5974e6d854ed26890a969b507",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0159",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) first dial-only override is manual, inherits the other dial, and preserves voice and other-location proposals",
    "selectorCorrection": null,
    "launch": 193,
    "resultPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/mutant.json",
    "resultSha256": "abf046eb7d8a3b702df1f9b5d5effdbee660915a558600b4181c11b2a82fe33c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0159-DqzeOi/mutant.json.supervisor.json",
    "supervisorSha256": "2911ef18bbf94af47363fcdca01c5e04c835fa01db236dc46ea40d31542b9a67",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0160",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) an account-default Apply stales inheriting and overridden location proposals across conversations while voice stays pending",
    "selectorCorrection": null,
    "launch": 194,
    "resultPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/baseline.json",
    "resultSha256": "22700092fa9f624cd7881ebb911207801dc9a6c0df9bb93812b22451d23e93ac",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/baseline.json.supervisor.json",
    "supervisorSha256": "8e16f618691e40834f8973783f57a29fb2dea852caa9f9481cb0cfd80460329c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0160",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) an account-default Apply stales inheriting and overridden location proposals across conversations while voice stays pending",
    "selectorCorrection": null,
    "launch": 195,
    "resultPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/mutant.json",
    "resultSha256": "43ab5f4d747d182ec3541a27abbbbe252af1eb3964a731cffb8a908de140b8db",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0160-zxY3wn/mutant.json.supervisor.json",
    "supervisorSha256": "688591361b19918c1980902170ccfa939a6e3fc594b12c0f9252ec1b07e25039",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0161",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) a zero-included-review Apply receipt persists imported and unknown exclusions with the recomputed reporting window",
    "selectorCorrection": null,
    "launch": 196,
    "resultPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/baseline.json",
    "resultSha256": "c9f3c0b6a8e5f03a32313a945fa2a9417c21ed2087192075ee85bacdecb4022d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/baseline.json.supervisor.json",
    "supervisorSha256": "d91089e93554d3fdd4935b677deba82408c1247914f2cfaa5b3a14f080872547",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0161",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) a zero-included-review Apply receipt persists imported and unknown exclusions with the recomputed reporting window",
    "selectorCorrection": null,
    "launch": 197,
    "resultPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/mutant.json",
    "resultSha256": "17c2ed31c86d5f0b3573463c89b5a68e45ca0f9bcb964f3709bf822b410e4dbf",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0161-TDHThQ/mutant.json.supervisor.json",
    "supervisorSha256": "7ddbf6421b5cf46c357b7f58723de658e5efe0c58275267f2e0425aeeffc12a2",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0162",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "Operator policy Apply \\(live DB\\) readiness rejects expansion while a contraction still commits",
    "selectorCorrection": null,
    "launch": 198,
    "resultPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/baseline.json",
    "resultSha256": "20fa2e887455331e04d0bd8b7361709b2a124c7bac223a21ae703deb3c66f50d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/baseline.json.supervisor.json",
    "supervisorSha256": "72a205c0e70d90cbc6ae4820c68ff2137613e03842d5241e4f34f105415f1e33",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0162",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "Operator policy Apply \\(live DB\\) readiness rejects expansion while a contraction still commits",
    "selectorCorrection": null,
    "launch": 199,
    "resultPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/mutant.json",
    "resultSha256": "9f5caf8714d914b5731e4ea89d347f7c79fc3da6be1261502b4f672f16fa6921",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0162-L5o2g4/mutant.json.supervisor.json",
    "supervisorSha256": "396c63df8d1c92f29c8503b75b0fc7efa57a536049b72e85a2d9df7c2d1cccf0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0164",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: same location serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 200,
    "resultPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/baseline.json",
    "resultSha256": "d0587c83ccfe5d0dca9c9034263e22f5508ba85677ebbe7436c7bda7ce95d2f5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/baseline.json.supervisor.json",
    "supervisorSha256": "402c414e544767ea7bdaf9794896373a601f62b0bc3961566b286d82ce7de347",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0164",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: same location serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 201,
    "resultPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/mutant.json",
    "resultSha256": "8b802548af37cd48be01a9361e3290d3331cca511a0dec9ff3034e0303127eeb",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0164-zK2DET/mutant.json.supervisor.json",
    "supervisorSha256": "a5e558b370f6b9e6a6b5025e60cd21f63d38391deb287043a9a93e03e82389f5",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0165",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: first override serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 202,
    "resultPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/baseline.json",
    "resultSha256": "be8ad88a8d4ddd9abd5ae6bf547cee051f231b0bf3d711932a8aaf8d5d942435",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/baseline.json.supervisor.json",
    "supervisorSha256": "271ce65bad1c1a581a659b15c17e92eb1789b0e239cc4f485791da382fa21b43",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0165",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "ad358d280f798d6aee7e75d77abe6f1638b2ff4d43d5db78b4324a9e8785eed2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: first override serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 203,
    "resultPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/mutant.json",
    "resultSha256": "047262eed0f8706e7c76fbb4a884f90ba286535d3acd4fec6de69667df7edade",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0165-74WdFv/mutant.json.supervisor.json",
    "supervisorSha256": "167724a76d02b669f07a9aa4b0d667b65bcf91812fec0a4830d83a5fc7e518d7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0166",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: parent default serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 204,
    "resultPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/baseline.json",
    "resultSha256": "2a61fe0567fd1cf0f3a9708fbf72dd3f8e7fb9dbe1bcc71e482de7c75e99549d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/baseline.json.supervisor.json",
    "supervisorSha256": "0a88c95a90e9221cc468a8702de341121fe40143458d2871c42c9f27cd9429ad",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0166",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) form write versus Apply: parent default serializes account before proposal and makes the old token stale",
    "selectorCorrection": null,
    "launch": 205,
    "resultPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/mutant.json",
    "resultSha256": "e6064ff78c79d0892487a76eb884beec602a0e6e31fa5b03af7a759c2d88a35c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0166-Nwheqx/mutant.json.supervisor.json",
    "supervisorSha256": "7e8cd9552fea08e2122855673c9aea2cd3e007c30761ad992b6ba51ab37d2d6b",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0167",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) two prepared proposals racing to create the first policy row commit exactly one receipt and audit",
    "selectorCorrection": null,
    "launch": 206,
    "resultPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/baseline.json",
    "resultSha256": "cade80d1e7bf2a0e38ae9be0d2cb5685620d84d3db244bb7dfe10e573e0155d1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/baseline.json.supervisor.json",
    "supervisorSha256": "0b73bbb546c83957384c81a3bc0fa6b6f26217507463c50113d9fd855cacf948",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0167",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) two prepared proposals racing to create the first policy row commit exactly one receipt and audit",
    "selectorCorrection": null,
    "launch": 207,
    "resultPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/mutant.json",
    "resultSha256": "6775fb01c9cec3b67ebe26f7f48f727c88c8d5078b44bde342ce2f2c8c27871e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0167-sXYkLU/mutant.json.supervisor.json",
    "supervisorSha256": "0fa8ccb02293e17bb1418e5bc01fb47d4718dc9fa1f658a9b3dd69e6e48fff25",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0168",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) Apply preceding a concurrent form write preserves its receipt and serializes the form after commit",
    "selectorCorrection": null,
    "launch": 208,
    "resultPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/baseline.json",
    "resultSha256": "cb61166183db40be0972b8e2f4949964476fa28889268d7dfcb0ae00def6e352",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/baseline.json.supervisor.json",
    "supervisorSha256": "87af819c7abb0823ab11952ada83bf07e41be7a1766c7dca910db162588bf60b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0168",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "e41c31c8658483d5161ef2e91ebfdd4c81c162e5bae9aeda8c3548af96134b0f",
    "selector": "Operator policy Apply \\(live DB\\) Apply preceding a concurrent form write preserves its receipt and serializes the form after commit",
    "selectorCorrection": null,
    "launch": 209,
    "resultPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/mutant.json",
    "resultSha256": "5797be07933e8fab1ed4c30cbf340c3ee11a60e8704ec5f46f0911f83a20d6fa",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0168-eXKHdy/mutant.json.supervisor.json",
    "supervisorSha256": "dde6d1b398792ad9fd591051e68a3d576c87b5014cc79e03f645eb2bc498cc91",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0169",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "Operator policy Apply \\(live DB\\) an archived target refuses setting an override scope but permits manual contractions and repeated receipts",
    "selectorCorrection": null,
    "launch": 210,
    "resultPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/baseline.json",
    "resultSha256": "0cb29be397005a4944eafa21bbee8c4d4b55eb75af4b22fa47da9e9331b6294a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/baseline.json.supervisor.json",
    "supervisorSha256": "32ea113ba19530024fc2cc85cb9bb9d7032af5c88717401d9218a0e3db1507c5",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0169",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "a8028daba2b309bb250936b16878f80c2ecdf5bbad9e775f3cca66aac2a9ae79",
    "selector": "Operator policy Apply \\(live DB\\) an archived target refuses setting an override scope but permits manual contractions and repeated receipts",
    "selectorCorrection": null,
    "launch": 211,
    "resultPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/mutant.json",
    "resultSha256": "12aef70ae6ab60e939c0788c8179046300781da6b5a37c034817752adcc41a7e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0169-z6ctMK/mutant.json.supervisor.json",
    "supervisorSha256": "0e72fa72bfd610d520faa541b4abdc6160718f1b4214db6fca9324884e334cab",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0170",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) a committed form change invalidates the parent token even for an existing location override",
    "selectorCorrection": null,
    "launch": 212,
    "resultPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/baseline.json",
    "resultSha256": "92c9e2684d6217ae1caaecb6e6c8aec632896f4937b8b06ccc7c092a365558e7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/baseline.json.supervisor.json",
    "supervisorSha256": "26b8ca5ca8a291ab764b16b0ab0e84c0757e71ad5bf2aad6f3d191964ee34f71",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0170",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator policy Apply \\(live DB\\) a committed form change invalidates the parent token even for an existing location override",
    "selectorCorrection": null,
    "launch": 213,
    "resultPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/mutant.json",
    "resultSha256": "075c7a596be217993ad57f07d536a5e28e9161080c254282bfc77bb9f3c093ef",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0170-mvbfVY/mutant.json.supervisor.json",
    "supervisorSha256": "52f074f63d418451e4dd3f1cca8e1ef9eb15cfb45cba05fac50ae7df4f4f2159",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0173",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "policy-state reads \\(live DB\\) location scope: a manual row replaces the whole default, an inheritor stamps both rows, an archived target keeps its state with no cohort",
    "selectorCorrection": null,
    "launch": 214,
    "resultPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/baseline.json",
    "resultSha256": "f36fbe3c65911526817407f64722b78815aa87f8fbbfae7f811c1c670c7f4360",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/baseline.json.supervisor.json",
    "supervisorSha256": "25b61f4aa84e5e967772ffc80c2d78c1c94c98388de946fa31c5de2c056fe9a2",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0173",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "policy-state reads \\(live DB\\) location scope: a manual row replaces the whole default, an inheritor stamps both rows, an archived target keeps its state with no cohort",
    "selectorCorrection": null,
    "launch": 215,
    "resultPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/mutant.json",
    "resultSha256": "eb144939d4ed5694121db0982a03da38fedf3009fdef1db68ffd50e083dd1316",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0173-siLYcu/mutant.json.supervisor.json",
    "supervisorSha256": "c2cb2de9918e0927a89676c4592050a61822f865cb55aab0f5b0e18ab0c4936a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0174",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "policy-state reads \\(live DB\\) stamps absent rows, then opaque updated_at text read in the same lock-free statement as the values",
    "selectorCorrection": null,
    "launch": 216,
    "resultPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/baseline.json",
    "resultSha256": "bbbb8e2d934e834340a2b2cfcebc219fb33e801d4532802875c738e802529cf5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/baseline.json.supervisor.json",
    "supervisorSha256": "08ecf50a879d174a77f00584d0d182c16991c26e23f2af36f490967a400e4b18",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0174",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "policy-state reads \\(live DB\\) stamps absent rows, then opaque updated_at text read in the same lock-free statement as the values",
    "selectorCorrection": null,
    "launch": 217,
    "resultPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/mutant.json",
    "resultSha256": "430e926ee14a731f9ad1cd8c105140334d43173ed1021442592a638d0a8dec12",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0174-bZly1y/mutant.json.supervisor.json",
    "supervisorSha256": "ffdc3c909baae225823b3b879d2999ab94fede7ea259a70f52023cc2697cdbf0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0191",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "selector": "buildProposalRows policy stamping policy proposal view derives friction from the stored before/after and never from a stored flag",
    "selectorCorrection": null,
    "launch": 218,
    "resultPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/baseline.json",
    "resultSha256": "2ea218be2345e5908a324b2974e47d8d41fe5bbacfc7bf86c21ed85857f77ed6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/baseline.json.supervisor.json",
    "supervisorSha256": "4cebd3cc8b98540043ff289ccf3a475375214ffed6f10c80cc3fdd4596afd02b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0191",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "selector": "buildProposalRows policy stamping policy proposal view derives friction from the stored before/after and never from a stored flag",
    "selectorCorrection": null,
    "launch": 219,
    "resultPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/mutant.json",
    "resultSha256": "f720f17a6daafec69bfde560dc35e1d45cd003f20ffdeb551b05205be5a1612e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0191-OLb3v4/mutant.json.supervisor.json",
    "supervisorSha256": "f57f0786497a55dff74ac8879d8bcd125ea7db2f23ea679847f8248b2e518a60",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0198",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "7b7f8b0247cd38477777183a5e8683f137fc256aed33af1dabdefbb379fcbc2c",
    "selector": "operator owner reads \\(live DB\\) getConversationForOwner carries each turn its own stored proposals, and none of another account's",
    "selectorCorrection": null,
    "launch": 220,
    "resultPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/baseline.json",
    "resultSha256": "c7f2df3cb4635e0288aa7069859abee2280c3a5ae45137ca8ff730a2a1ae892f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/baseline.json.supervisor.json",
    "supervisorSha256": "9f6066fd2a2993621fda02289d6a98a0bbb7593252ef8d764fa1e5c9ba398709",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0198",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "7b7f8b0247cd38477777183a5e8683f137fc256aed33af1dabdefbb379fcbc2c",
    "selector": "operator owner reads \\(live DB\\) getConversationForOwner carries each turn its own stored proposals, and none of another account's",
    "selectorCorrection": null,
    "launch": 221,
    "resultPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/mutant.json",
    "resultSha256": "f21fc5803b4209f20aa0e33585209d78e3097a6bf0d1928215b5664f140e1a4a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0198-MhODq5/mutant.json.supervisor.json",
    "supervisorSha256": "c2f8610425ffd83f4d6176befe822d2b2314f1889a665c33e16ee4b120697e72",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0200",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) getConversationForOwner bounds the transcript to the most recent turns",
    "selectorCorrection": null,
    "launch": 222,
    "resultPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/baseline.json",
    "resultSha256": "fd37e06b7a2985b4cec8f6421b14ae4c81ccd5ae4af82c6a8c5e0532b6230488",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/baseline.json.supervisor.json",
    "supervisorSha256": "61dafeb8c321e21d1aed482b3a0cd800741aa73e94fb40500e5fe605e8235d41",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0200",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) getConversationForOwner bounds the transcript to the most recent turns",
    "selectorCorrection": null,
    "launch": 223,
    "resultPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/mutant.json",
    "resultSha256": "e6260aa8e8f65d4fc53b9b3a16295b26df6eb18fe944b9bc597a7b7bd7cde6b3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0200-ol2Rhd/mutant.json.supervisor.json",
    "supervisorSha256": "ce934b7136698574e774bedc14206253e6aec9bcacf95cd69a18146a13770c59",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0203",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "operator owner reads \\(live DB\\) hydrates reused proposals without changing their owning turn \\(outside transcript: false\\)",
    "selectorCorrection": null,
    "launch": 224,
    "resultPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/baseline.json",
    "resultSha256": "364e0657bd5570101ee10addcf3888bd8579df22424cf25f68f6caf94333785f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/baseline.json.supervisor.json",
    "supervisorSha256": "d5d5dd7bc550e00e99a47498194a2a5bb8e49d12ae6f8139e3f3aaca33f3fb55",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0203",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "operator owner reads \\(live DB\\) hydrates reused proposals without changing their owning turn \\(outside transcript: false\\)",
    "selectorCorrection": null,
    "launch": 225,
    "resultPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/mutant.json",
    "resultSha256": "0f7a084cb2048c7c6f19fae5fc2261ffdc36a86e0c62e9eb1586fce0b05789de",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0203-lQ3Pzr/mutant.json.supervisor.json",
    "supervisorSha256": "01f06de0fa9695fc684130f9dd9e4c922580d2fe5588e4754a6050ce15dc085c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0204",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "operator owner reads \\(live DB\\) hydrates reused proposals without changing their owning turn \\(outside transcript: true\\)",
    "selectorCorrection": null,
    "launch": 226,
    "resultPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/baseline.json",
    "resultSha256": "cd2e84a77264ca273a2bdbf0bc71a11f53523d689e9e08f63a2db382f11f61ba",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/baseline.json.supervisor.json",
    "supervisorSha256": "5b6d4e9ce66a34a538f85acd682028c58934ec6fefc81840650d08b39a7c471a",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0204",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "operator owner reads \\(live DB\\) hydrates reused proposals without changing their owning turn \\(outside transcript: true\\)",
    "selectorCorrection": null,
    "launch": 227,
    "resultPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/mutant.json",
    "resultSha256": "cf6c21cedf7b4b3631d1077cf3e377c4ebc510254c5bfd9038afa012ae88b9fe",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0204-FJ69nu/mutant.json.supervisor.json",
    "supervisorSha256": "930508421f143770a953bef1dae819f8bb6b67dfd02d1d679faa1a88139af9c9",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0205",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) stored refusals survive both owner GET builders in order and stay scoped to their turn and account",
    "selectorCorrection": null,
    "launch": 228,
    "resultPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/baseline.json",
    "resultSha256": "3478035a0ecf1fd9bcdc92e0ab426f1169f546e9bceabc758e0607d915e907b2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/baseline.json.supervisor.json",
    "supervisorSha256": "692aa99994256089561b4002126504936dd125db875a20cbbfb6c386ccb6cd2b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0205",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) stored refusals survive both owner GET builders in order and stay scoped to their turn and account",
    "selectorCorrection": null,
    "launch": 229,
    "resultPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/mutant.json",
    "resultSha256": "dea7c3e5c53148b82d995bf1fa834caacff18111932e469ce7f536a9444161dc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0205-I2AEn7/mutant.json.supervisor.json",
    "supervisorSha256": "3822ea8b2b547057c77b92c19a4f0bbc5bf41477bc0427c7d130d0562f239c19",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0206",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) each turn carries its own unsupported requests and no other turn's",
    "selectorCorrection": null,
    "launch": 230,
    "resultPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/baseline.json",
    "resultSha256": "4078dfbf16f9eff50fb1e081ae31e98ac744cbb629c505f7611ad75a12044142",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/baseline.json.supervisor.json",
    "supervisorSha256": "7193edb381808de0ed2d0f64915ab732c6f6aa78afc7b7146c693164e9ef7e70",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0206",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "94c354664b6a1081908b1ba74e2ddeb38332ea9a4e26bec0db4f95775535aca6",
    "selector": "operator owner reads \\(live DB\\) each turn carries its own unsupported requests and no other turn's",
    "selectorCorrection": null,
    "launch": 231,
    "resultPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/mutant.json",
    "resultSha256": "5c1341ae3142ae496f87435b9c55a1bacc05580009fe1dc2845ef477147b75ca",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0206-qF6Sd6/mutant.json.supervisor.json",
    "supervisorSha256": "6c1007de10dcfa37a85a7d6beb3a30bc3ff0ef414433b6a3a1964ca07a1ed0ee",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0247",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores null tone without widening the ordinary model input or writing unrelated voice fields",
    "selectorCorrection": null,
    "launch": 232,
    "resultPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/baseline.json",
    "resultSha256": "ab2936ef3c39d2c2f35fa9872575ca9f0ff2209d4514c3fd074203ddd0c75db3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/baseline.json.supervisor.json",
    "supervisorSha256": "2b88cf121d770ec64c862d5ed63bb8b75c1363eb9dcc08ba4135f8e885f04add",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0247",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores null tone without widening the ordinary model input or writing unrelated voice fields",
    "selectorCorrection": null,
    "launch": 233,
    "resultPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/mutant.json",
    "resultSha256": "04fb49f43644d3fe5dd5873ec32c9c3595aec7b537ccd4d3f3f89338d8693050",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0247-0w4WNt/mutant.json.supervisor.json",
    "supervisorSha256": "16c935f076fb75e3e809155cd7cd2154a9c9e98ccd0b82303196d3d62d97aae1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0248",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_products_services",
    "selectorCorrection": null,
    "launch": 234,
    "resultPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/baseline.json",
    "resultSha256": "fa4808ce1ccb851aabcb62e46b55d05c1d776b9b80f99ef54ff60d724e887e0f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/baseline.json.supervisor.json",
    "supervisorSha256": "74ffd74b357c0630ed76c1988ba018e5666e3042202ed85929d882115f538191",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0248",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_products_services",
    "selectorCorrection": null,
    "launch": 235,
    "resultPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/mutant.json",
    "resultSha256": "afbf2879eb7549ae8d758e36822eac46f0797fae98633c047224c730e2898924",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0248-zeEqyY/mutant.json.supervisor.json",
    "supervisorSha256": "f051d904efd17f4d4483e0c56ba94c9866fe73104d44c116d0802359076bb08a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0249",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_avoid_facts",
    "selectorCorrection": null,
    "launch": 236,
    "resultPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/baseline.json",
    "resultSha256": "2a1fb0da03ec65bbb085afccf59f9f96cce97a2348293a9e0a848a06cb6d683b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/baseline.json.supervisor.json",
    "supervisorSha256": "2658e7c02adc966c4826e855ea411db14b11658ae1417c52a583ddd62088da15",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0249",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_avoid_facts",
    "selectorCorrection": null,
    "launch": 237,
    "resultPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/mutant.json",
    "resultSha256": "1d9a9349316656f84c137fd9369fbfbb9a7c284a5d6e3b9aa7a2ccaec308d939",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0249-N3kZ3o/mutant.json.supervisor.json",
    "supervisorSha256": "b80dad4345fc29c6187c3b040579f85cc8614fe414b9d80cd3ac4c93b1b88e72",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0250",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_highlight_facts",
    "selectorCorrection": null,
    "launch": 238,
    "resultPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/baseline.json",
    "resultSha256": "7124e1b9edc22863a061cf77668940fa3c93d586c47db6f4af95e171c84d7fa8",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/baseline.json.supervisor.json",
    "supervisorSha256": "010f41a0af1dce3c0c1cf59f71df37a514f9b266061b486300004b3e1fe9c145",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0250",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "63ab300a1acfe94bb5c0bc859771b791487680e1ef55d18cfe921e4539b7d75d",
    "selector": "validated Receipt inverses restores only the field owned by set_highlight_facts",
    "selectorCorrection": null,
    "launch": 239,
    "resultPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/mutant.json",
    "resultSha256": "b0812aab8650202287fa25681fb229cd7724a5f1b755e359318dfe55b359cb42",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0250-g9hZvn/mutant.json.supervisor.json",
    "supervisorSha256": "26b816256c8c9e0c99f0bdcc0015d1665bafafb0f9c1d642eab639922053ca55",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0251",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "selector": "validated Receipt inverses preserves absent account defaults and single-dial policy inverses",
    "selectorCorrection": null,
    "launch": 240,
    "resultPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/baseline.json",
    "resultSha256": "beffbcac2a12f63d562f4dc5a116ee9919e6dff92fb7e5df68dbfb7f44ab4290",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/baseline.json.supervisor.json",
    "supervisorSha256": "71cec6f8904aaac498d9d8ad0877ad892bdabd03e5b2ca92d9bc6b84b50c9c63",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0251",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "selector": "validated Receipt inverses preserves absent account defaults and single-dial policy inverses",
    "selectorCorrection": null,
    "launch": 241,
    "resultPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/mutant.json",
    "resultSha256": "47a9395acd803c7ac08548ed29b575a0ee5311e3c184ead9709cfff9a27d5b44",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0251-vD8khu/mutant.json.supervisor.json",
    "supervisorSha256": "a3005c376c50de0104ceab212aa65c93493de29bf6eb1e946535325a7b465f43",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0252",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "selector": "validated Receipt inverses restores all cleared override dials and derives undo from the immediate receipt",
    "selectorCorrection": null,
    "launch": 242,
    "resultPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/baseline.json",
    "resultSha256": "f9fee2ba9e5ffb8a513f16db1b871680d9b29eaecf1aa389d719ccc89cdbb4a3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/baseline.json.supervisor.json",
    "supervisorSha256": "16cb580ca4e3a31a28f3f0eefeb52e528e30fccd09cf38926dfcddbdfd2f4715",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0252",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "d3dc979fa36ce6e0b5f761adca508444bef873b37effbea6b282de84c00e71db",
    "selector": "validated Receipt inverses restores all cleared override dials and derives undo from the immediate receipt",
    "selectorCorrection": null,
    "launch": 243,
    "resultPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/mutant.json",
    "resultSha256": "1cb324f91a3a81b36458db8ec6cb52a80fbae989c87927187c14ec3c558cc180",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0252-1ShxZI/mutant.json.supervisor.json",
    "supervisorSha256": "8ea3a811ea4574e6cb08a9107a165876d27f4be46f425b033866fbe86c79a90b",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0253",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "be55aad0aae70450c8177e445acb9ab5ac4cfe92d34409cc73923055911df402",
    "selector": "validated Receipt inverses rejects missing, unsettled, obsolete, foreign and mismatched source evidence",
    "selectorCorrection": null,
    "launch": 244,
    "resultPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/baseline.json",
    "resultSha256": "0155e5dbee99d690d5358e9c57ad4c3782e6dfe7bbad0f52bbc21ee9a5e48403",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/baseline.json.supervisor.json",
    "supervisorSha256": "c754e8f382022461d3893c2d60821c3f5b69d9fd7add020a8786f366e62c38f2",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0253",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "be55aad0aae70450c8177e445acb9ab5ac4cfe92d34409cc73923055911df402",
    "selector": "validated Receipt inverses rejects missing, unsettled, obsolete, foreign and mismatched source evidence",
    "selectorCorrection": null,
    "launch": 245,
    "resultPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/mutant.json",
    "resultSha256": "74feffbf665941b17721776fe2f061dbd4f1a94e357083d2d3ee77a831563c82",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0253-B4rkPP/mutant.json.supervisor.json",
    "supervisorSha256": "2fe6f000f26582b086f3bb1646c51517de4b7dcf49a003f1527fbcd63db9dce9",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0254",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "ef03e7dc61ed92b2b3c8c28f6f28f05e0276ebd5a9fe56a5a5d541b246ef040d",
    "selector": "validated Receipt inverses rejects malformed receipt state and a shape-valid receipt from the wrong domain",
    "selectorCorrection": null,
    "launch": 246,
    "resultPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/baseline.json",
    "resultSha256": "598833922d3b1d22ef353781d518dcdacbe6cfb2e52b9553f84244e24aa7fa88",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/baseline.json.supervisor.json",
    "supervisorSha256": "018638b75e91384f88bed039b881fd01597fe2e49f460c9795c932cb68e6886c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0254",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore-inputs.ts",
    "originalOid": "fd9fb3cc0de3f061f8966a646e19bd9b85357d3f",
    "mutantSha256": "ef03e7dc61ed92b2b3c8c28f6f28f05e0276ebd5a9fe56a5a5d541b246ef040d",
    "selector": "validated Receipt inverses rejects malformed receipt state and a shape-valid receipt from the wrong domain",
    "selectorCorrection": null,
    "launch": 247,
    "resultPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/mutant.json",
    "resultSha256": "678af259bbcc6513091fb4c5d136a822da2d00017172850e7a6df24247cf535a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0254-ckTFLq/mutant.json.supervisor.json",
    "supervisorSha256": "3a6ff5ea8d260d4a3ff70843b23b885956ac6b0172b1fb072f5279e68d5adea8",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0255",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains Restore waits for voice Apply and reads its committed state",
    "selectorCorrection": null,
    "launch": 248,
    "resultPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/baseline.json",
    "resultSha256": "7b2a3099140511153184a61968217a7ca7290b5f28ea082b47cc95d1f32906ca",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/baseline.json.supervisor.json",
    "supervisorSha256": "ac248e56348382b17bf5ddc6830ced66a317e73d53ba5cf1067169c2e2033c6a",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0255",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains Restore waits for voice Apply and reads its committed state",
    "selectorCorrection": null,
    "launch": 249,
    "resultPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/mutant.json",
    "resultSha256": "2d3502b457abc3ce74d6aa0cd85643c2cb06d5e96cb4a6d9c7d0d4961a1cc480",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0255-KbbLbb/mutant.json.supervisor.json",
    "supervisorSha256": "30ca335f2ac711851aba22b365527c00fb5bc6e76cf0feafad0894280856ae46",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0256",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains Restore waits for policy Apply and reads its committed state",
    "selectorCorrection": null,
    "launch": 250,
    "resultPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/baseline.json",
    "resultSha256": "5457ce65345d271518f7995be2c5e0fd222c48aa3265398f9e8280b164c95c70",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/baseline.json.supervisor.json",
    "supervisorSha256": "30bde4a77a83ec3139d197f28f3f7f2cb5d54915dc4c9faa783ed8457330b491",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0256",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains Restore waits for policy Apply and reads its committed state",
    "selectorCorrection": null,
    "launch": 251,
    "resultPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/mutant.json",
    "resultSha256": "a33fb7349d5f822d3f9f34cb02b6e0452150884b7317597f3deb2e84560be27a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0256-BfZLkl/mutant.json.supervisor.json",
    "supervisorSha256": "d5b38a22f2c26b93b3087155478c6d693f8c9c146899d400ddacbe4fc27e11b0",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0258",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains voice Apply waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 252,
    "resultPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/baseline.json",
    "resultSha256": "60eb0b09a46e49ed7ba6457a0195632f7d649ca67036eb5f88609d15f3603c66",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/baseline.json.supervisor.json",
    "supervisorSha256": "d43fa309a6086685ad8e2e32a70b341645c063b6bd68177a89a82e68fa5410a9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0258",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains voice Apply waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 253,
    "resultPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/mutant.json",
    "resultSha256": "9998f8fd4d9ac99812b332fe695740a6c028d9617f0aa503639f40972fe5e04c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0258-WbLiiR/mutant.json.supervisor.json",
    "supervisorSha256": "e4ffc02fe8285ff68efe45d9045dc6f3f16e45d6af8a50cab516d936ef67f8f2",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0259",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains policy Apply waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 254,
    "resultPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/baseline.json",
    "resultSha256": "c5c2cd8fff23ddd473f4cf4b60f93816cb2b98e4df22e6cd70068c558f955715",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/baseline.json.supervisor.json",
    "supervisorSha256": "603cdc31b633484a23600182fdd44740d1d401b6942c4ddfbc5a0cf4b587e73e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0259",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains policy Apply waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 255,
    "resultPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/mutant.json",
    "resultSha256": "8188964bb203edab91fbdbbbcb09695497a47bd363188bbd0b1986b2ee33c3fe",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0259-bOwixB/mutant.json.supervisor.json",
    "supervisorSha256": "857a87f97a597fb16c97c3f37dfaa9d4d4eead3c5bede97db38ea467118178c3",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0260",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains archive waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 256,
    "resultPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/baseline.json",
    "resultSha256": "3d3103bee44e4d6a1fb71b510cd370d8e1835344a3250f858ca485729fd11f1c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/baseline.json.supervisor.json",
    "supervisorSha256": "bc255f5a4decd6a325d3e2da1f18624eb621cfd96eb465b2c20d1459c4d9a1db",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0260",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "restore preparation serializes against lifecycle and both Apply domains archive waits for Restore preparation without observing a settings write",
    "selectorCorrection": null,
    "launch": 257,
    "resultPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/mutant.json",
    "resultSha256": "897d564b1f5e4a6d7838aa2a27d6cae1c1aa26b2c39dcbf053f1336da639ef3a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0260-8jVdow/mutant.json.supervisor.json",
    "supervisorSha256": "77f5563131d0c1a57d135d485d1ed49168ca7cece7c2df5358eb151e3e6475a1",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0263",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "821841f59cf4124ff31513c27fb473eb2e3676508df64bb11046d86cd2fd0fa3",
    "selector": "Operator Restore \\(live DB\\) restore preserves an originally absent account default",
    "selectorCorrection": null,
    "launch": 258,
    "resultPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/baseline.json",
    "resultSha256": "bf111ed58d26fe6a251484b8ae45f8473ce3a494d2e389776ec2571bf54374c4",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/baseline.json.supervisor.json",
    "supervisorSha256": "74318e443b463f9cd7296324f15bde99b6b57cc97fa189ac6b034561c29c9fc9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0263",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "821841f59cf4124ff31513c27fb473eb2e3676508df64bb11046d86cd2fd0fa3",
    "selector": "Operator Restore \\(live DB\\) restore preserves an originally absent account default",
    "selectorCorrection": null,
    "launch": 259,
    "resultPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/mutant.json",
    "resultSha256": "f7e7e215ff7efe485021aecf0fe4af18e6f24f241bab6e8b9df337f301b60fa2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0263-sBz4Es/mutant.json.supervisor.json",
    "supervisorSha256": "7f84fd80018adaf8edab9647a7783da2b472b939c7b49f3b7d2d7a551265a9d4",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0264",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "selector": "Operator Restore \\(live DB\\) restore expansion requires the exact phrase and current readiness",
    "selectorCorrection": null,
    "launch": 260,
    "resultPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/baseline.json",
    "resultSha256": "2a5518092179dc53943c50d82645260de6041ae737978191a54f406a69d3dd9a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/baseline.json.supervisor.json",
    "supervisorSha256": "9cc30f6d902a3ffb35f158fad4e6846003aeb496a15f5a576103ea9f5b4eb8d2",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0264",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "852c4e657a4927bb88e443b299ae750938af2e826c09655654650f72dcaad2d1",
    "selector": "Operator Restore \\(live DB\\) restore expansion requires the exact phrase and current readiness",
    "selectorCorrection": null,
    "launch": 261,
    "resultPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/mutant.json",
    "resultSha256": "f396f2e148dd40c01ac48799013999a887e1867b9ad6781eb2ff2391628dc147",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0264-PsBhED/mutant.json.supervisor.json",
    "supervisorSha256": "d24072e0c4bc506d006dcb3783a0234ecf1763267f72d94cb5d2532cae9431b5",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0265",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator Restore \\(live DB\\) restore rejects a changed account default and foreign receipt",
    "selectorCorrection": null,
    "launch": 262,
    "resultPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/baseline.json",
    "resultSha256": "ddd01442d96f917d91a0e9940ff8d1dd7fd7abde92f1d9509c51155fa7ba3668",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/baseline.json.supervisor.json",
    "supervisorSha256": "91f58f4868be94cfc1007404ca6bd163620835e847f10b4fa92be7934b90d3d9",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0265",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/policy-state.ts",
    "originalOid": "664a91c83b95327dbc193b957b5247a404a44911",
    "mutantSha256": "f15d84d5f0aa680bcd69bf778f181493cead77f81b3b59ccbec239d923a016c2",
    "selector": "Operator Restore \\(live DB\\) restore rejects a changed account default and foreign receipt",
    "selectorCorrection": null,
    "launch": 263,
    "resultPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/mutant.json",
    "resultSha256": "1a2aaff2c6426c65e0862d421c568aba47c3325c8a9e643033bc45d0e42f941b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0265-HDBXHO/mutant.json.supervisor.json",
    "supervisorSha256": "3301972da60cffb83e7175611c7444f4a20895538a423c36c544186fd49040d9",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0266",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "selector": "Operator Restore \\(live DB\\) concurrent restore preparation creates one proposal per source and version",
    "selectorCorrection": null,
    "launch": 264,
    "resultPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/baseline.json",
    "resultSha256": "cc8a187f173ecef54a3470e1a0002657954a44b632ef35626306e55ec4783741",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/baseline.json.supervisor.json",
    "supervisorSha256": "7c879206ac776004c7691847fc5c1ce50ba02c1f9ce58316d167e2a9b56871b1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0266",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "selector": "Operator Restore \\(live DB\\) concurrent restore preparation creates one proposal per source and version",
    "selectorCorrection": null,
    "launch": 265,
    "resultPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/mutant.json",
    "resultSha256": "cc7b94365e6ccb6bf3db3013b10e9f4be2fb3504103aefdf7f2674ef10c281e1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0266-U6fet0/mutant.json.supervisor.json",
    "supervisorSha256": "3e8d4e857513b300b5cfca66e82c62a278a959409871a96ad9d15f9fbdc6ef1a",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0267",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "selector": "Operator Restore \\(live DB\\) restore_last resolves only the latest applied receipt in the stored scope",
    "selectorCorrection": null,
    "launch": 266,
    "resultPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/baseline.json",
    "resultSha256": "5a32fb9874aca5836da928100600d5891a2ac10ff6bac12afbb7177b8e86a612",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/baseline.json.supervisor.json",
    "supervisorSha256": "b5362eb04063c696c92af204a2c6eaef412c203d6d2b977ffd5adbf468b0f4c3",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0267",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "selector": "Operator Restore \\(live DB\\) restore_last resolves only the latest applied receipt in the stored scope",
    "selectorCorrection": null,
    "launch": 267,
    "resultPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/mutant.json",
    "resultSha256": "8581042874cfbfa594b8731c63edc607ba564a655295ffa0f64b3ae9bb6666a6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0267-Tos6Jz/mutant.json.supervisor.json",
    "supervisorSha256": "c7b628fc4f0711119c2d6186a277d16916537fc69b37410865113aedfa01f9e4",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0268",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "1b9ea457ae1f322e681e9c8902c1d4f98492d612300bb6ecff9d13983a84a323",
    "selector": "Operator Restore \\(live DB\\) Restore preparation rejects invalid actors, archived locations and unapplied sources without settings writes",
    "selectorCorrection": null,
    "launch": 268,
    "resultPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/baseline.json",
    "resultSha256": "d34ec822b27df5e4e715b47d411fd92ce06317b8bd4dadd7d0af5b33651edd90",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/baseline.json.supervisor.json",
    "supervisorSha256": "3be887c6f7d59e047e92bd73e196ecc4834c7a1ad6d2b294a385e3bda1f473b6",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0268",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "1b9ea457ae1f322e681e9c8902c1d4f98492d612300bb6ecff9d13983a84a323",
    "selector": "Operator Restore \\(live DB\\) Restore preparation rejects invalid actors, archived locations and unapplied sources without settings writes",
    "selectorCorrection": null,
    "launch": 269,
    "resultPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/mutant.json",
    "resultSha256": "714366325a5ec16e1be5408b6cc6c7f1001dec1f7c5afc4eccbc39a9c9062480",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0268-ErZBD5/mutant.json.supervisor.json",
    "supervisorSha256": "85a6bf30b403e75a1333517524dd75319d26976adb1f67e97510b84ed4e0cd96",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0269",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "selector": "Operator Restore \\(live DB\\) Restore revalidates source provenance on preparation, readback and Apply",
    "selectorCorrection": null,
    "launch": 270,
    "resultPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/baseline.json",
    "resultSha256": "5a480e3248c335acbb083d9ec8edbb14b5c2fcf46bdeb66972db98399c0360bb",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/baseline.json.supervisor.json",
    "supervisorSha256": "b257ca10158479a12ae3e00d8f357e819d8d1eca13837a763c6e0c75c1c21f5c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0269",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "selector": "Operator Restore \\(live DB\\) Restore revalidates source provenance on preparation, readback and Apply",
    "selectorCorrection": null,
    "launch": 271,
    "resultPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/mutant.json",
    "resultSha256": "7f03e7abb621ba9819326803265c7e9978fd07992e383f337a7bd4a66d0d6a37",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0269-L9QILt/mutant.json.supervisor.json",
    "supervisorSha256": "c013060582c0249e9cac10b157e94d2437842dc2006109725fd845340e956315",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0270",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "selector": "Operator Restore \\(live DB\\) malformed source receipt shapes refuse Restore without settings or proposal writes",
    "selectorCorrection": null,
    "launch": 272,
    "resultPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/baseline.json",
    "resultSha256": "6445a22f649766f56ce79dbdbdd75949f680c67da44c00268b232f9c5e726ed7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/baseline.json.supervisor.json",
    "supervisorSha256": "4857024d6255261e0493a590a2cc9da7bc004da10d612d07527d953751b514e1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0270",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/proposals.ts",
    "originalOid": "92123f46de2d1f9bd16af4fd87964c096daf0c87",
    "mutantSha256": "236767dc4a2a7a4d996edf80e9236c3ee4b05083cd83682cd81946a3af1ba98f",
    "selector": "Operator Restore \\(live DB\\) malformed source receipt shapes refuse Restore without settings or proposal writes",
    "selectorCorrection": null,
    "launch": 273,
    "resultPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/mutant.json",
    "resultSha256": "4ccb344949f6b4cf7b0c51e107ec9d92955e9e36661e574bd3e128e2f8ac79a3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0270-ky8VS7/mutant.json.supervisor.json",
    "supervisorSha256": "2a2f9f87ed9c83fe5a5dbf95606614ab7b6a776be6366ae546d0af978239fd15",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0271",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "Operator Restore \\(live DB\\) reused Restore proposals remain pending visible and actionable across turns and reload beyond the transcript window",
    "selectorCorrection": null,
    "launch": 274,
    "resultPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/baseline.json",
    "resultSha256": "f998a244eab1f7ed841d38afa455993decf42722bd80d153333713ce6d8e521e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/baseline.json.supervisor.json",
    "supervisorSha256": "b2f72849eaa7fbf5e19750dd8e79bdbfa8fca6a79962bb1f0e87ba0b1ec524cf",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0271",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "84b648c22fa8fd93567bd2f8fba061b1eb9f524c19dc06b5ebb922304633299c",
    "selector": "Operator Restore \\(live DB\\) reused Restore proposals remain pending visible and actionable across turns and reload beyond the transcript window",
    "selectorCorrection": null,
    "launch": 275,
    "resultPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/mutant.json",
    "resultSha256": "adc00ee8207c4ee3f6ed94f40d9c66a94733b5701d0b7cd2c87d7c207b16c224",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0271-xOt9r7/mutant.json.supervisor.json",
    "supervisorSha256": "de0a3b065a873f026f65776e85b3e32d2364ad723e0122d6022e466e01e58e78",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0273",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "013a4fafec8ba59d34d28535eb1fa89e084f9b5ef5363c8ed923c937959049be",
    "selector": "Operator Restore \\(live DB\\) atomic policy restore rolls back after a post-write error and records one audit",
    "selectorCorrection": null,
    "launch": 276,
    "resultPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/baseline.json",
    "resultSha256": "435d69befb577d3b586b2d5e5e5970d01e7a0f8b0d13e2d7e20712a0d8057f28",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/baseline.json.supervisor.json",
    "supervisorSha256": "11470202564ef58bb25cade1208223fffbaca7bc9fd6596d95317aa5f7151426",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0273",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/apply.ts",
    "originalOid": "a5f0932e98a70761b269198e089e38c70d1c2608",
    "mutantSha256": "013a4fafec8ba59d34d28535eb1fa89e084f9b5ef5363c8ed923c937959049be",
    "selector": "Operator Restore \\(live DB\\) atomic policy restore rolls back after a post-write error and records one audit",
    "selectorCorrection": null,
    "launch": 277,
    "resultPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/mutant.json",
    "resultSha256": "23866cad9414a21ad62177de986cd28ef20c5d6776c0ba7982785bd8016cf415",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0273-jaF8AM/mutant.json.supervisor.json",
    "supervisorSha256": "2286f160c0b0cdb182a8da87a90de3aea1530ebeae527b8e02604fbd2e1bd576",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0274",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "selector": "Operator Restore \\(live DB\\) button restore preparation and concurrent turn submission retain one visible pending proposal",
    "selectorCorrection": null,
    "launch": 278,
    "resultPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/baseline.json",
    "resultSha256": "bbe42881c1e0416f8bab930d4fbc5f03c6c74238e3ea38f94ed07eeb0fffbaa2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/baseline.json.supervisor.json",
    "supervisorSha256": "4e76c315b69d31f015d9d393bd5aaa1594f8859f4db83a4e97bc252fcda6d042",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0274",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "ea8541e5d435269ba5648eb111e268bf9103effd12640a71da610392fe042e2d",
    "selector": "Operator Restore \\(live DB\\) button restore preparation and concurrent turn submission retain one visible pending proposal",
    "selectorCorrection": null,
    "launch": 279,
    "resultPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/mutant.json",
    "resultSha256": "ae42f61b09eccf9559b2ab51f6bf6dc86073f15d64711b739cc831d7540f9dbd",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0274-96Hruc/mutant.json.supervisor.json",
    "supervisorSha256": "7dc90625f649d7fb80c6df062e9b8859425cc3899eb205549440392a6c0c01ba",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0275",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "selector": "Operator Restore \\(live DB\\) restore_last reselects a concurrently applied newer receipt under scope locks",
    "selectorCorrection": null,
    "launch": 280,
    "resultPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/baseline.json",
    "resultSha256": "22964c94a2c09caa660c44a1997842b059ec8a7e365cdc7e5510a6cf18563907",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/baseline.json.supervisor.json",
    "supervisorSha256": "56e805cc24e657652faf236bd3963baf23b007b216d47c2f31735552f90a1fc1",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0275",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "45c00bbe1055be91866222dfcc1bae941bedfe65fbdfa268093e6768f6e38e90",
    "selector": "Operator Restore \\(live DB\\) restore_last reselects a concurrently applied newer receipt under scope locks",
    "selectorCorrection": null,
    "launch": 281,
    "resultPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/mutant.json",
    "resultSha256": "7a8e4104bbc5a919b34fd305f44012dcc283dbddeb75b1c547faa0c54c68cbb1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0275-NohdTD/mutant.json.supervisor.json",
    "supervisorSha256": "6130e6c2858ab3f53dc4934cc0e5a04eb18b06cea90d3ee0223ad1ede5941943",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0280",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "AgentTurnWorker \\(live DB\\) distinct same-lane Operator refusals retain distinct durable subjects with mixed ordinary and Restore indices",
    "selectorCorrection": null,
    "launch": 282,
    "resultPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/baseline.json",
    "resultSha256": "c32b577467124a99e6923f376b74bb997e1f3cc86ae322a2ea1633e7c961a33b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/baseline.json.supervisor.json",
    "supervisorSha256": "0b1220f437412ec7fe4edc545567ae2831db3992291f773c744a58d84963be40",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0280",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "c95e0880d39515ce99d51cfde27deb3735e242d7caeb2353d90d8500b6adcb9e",
    "selector": "AgentTurnWorker \\(live DB\\) distinct same-lane Operator refusals retain distinct durable subjects with mixed ordinary and Restore indices",
    "selectorCorrection": null,
    "launch": 283,
    "resultPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/mutant.json",
    "resultSha256": "e1e1fb1866905c65811d39cacec17a96cb59c6c7e35009ae5f2c21df27b2c52e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0280-t37eD7/mutant.json.supervisor.json",
    "supervisorSha256": "6231e6f8756859112ec971d2c3ac8c461bf56fc5e81abad4998aa33b8005e9a2",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0281",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "b211236749d20fe94cb5f2156dbb077841a9854d50aa0de281f66eca732173f3",
    "selector": "AgentTurnWorker \\(live DB\\) say we are licensed returns refused without unsupported or Apply",
    "selectorCorrection": null,
    "launch": 284,
    "resultPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/baseline.json",
    "resultSha256": "309d13a010a8d1ae7ad87ae9eaecd8e32414ec3040d0816d8c6b674ed682587b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/baseline.json.supervisor.json",
    "supervisorSha256": "ad5f58225409702b07885572470e33400fa1c5538b1890166d4dcbc68e2d938f",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0281",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/reads.ts",
    "originalOid": "aa9d4cb1944cda71bed7b1723daabb4ac7ab7b4f",
    "mutantSha256": "b211236749d20fe94cb5f2156dbb077841a9854d50aa0de281f66eca732173f3",
    "selector": "AgentTurnWorker \\(live DB\\) say we are licensed returns refused without unsupported or Apply",
    "selectorCorrection": null,
    "launch": 285,
    "resultPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/mutant.json",
    "resultSha256": "7354997513a7c4ded73ef882e8c4c83d180979c824c460cdd91ab22338d086b1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0281-IS0dii/mutant.json.supervisor.json",
    "supervisorSha256": "1f5592279b63cc5602e51bcd1771d317976a5f6c166c51c0b5f38b9d21545896",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0283",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "selector": "AgentTurnWorker \\(live DB\\) a refusal ledger failure rolls back the completed turn and its already prepared Restore",
    "selectorCorrection": null,
    "launch": 286,
    "resultPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/baseline.json",
    "resultSha256": "fcff0da86c802b86d9c94360fc801562a6add5f9bd3d82cb4c10c09bbc063e1d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/baseline.json.supervisor.json",
    "supervisorSha256": "63c5b1d2fd1d42c043dc893fdb6b0bde33ff066c88efa5bd17bf15d94a2252f7",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0283",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "selector": "AgentTurnWorker \\(live DB\\) a refusal ledger failure rolls back the completed turn and its already prepared Restore",
    "selectorCorrection": null,
    "launch": 287,
    "resultPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/mutant.json",
    "resultSha256": "18de5f74176e0a1939f3587ec06db8a0a33bf2a0dfcdc2b5c613482e1bcdd933",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0283-e6CngR/mutant.json.supervisor.json",
    "supervisorSha256": "af8c011f5b21f5be562a480df851acc1c008858ad38dd7af8280d5836e58707c",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0285",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "selector": "AgentTurnWorker \\(live DB\\) restore completion and concurrent turn submission finish without a parent conversation deadlock",
    "selectorCorrection": null,
    "launch": 288,
    "resultPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/baseline.json",
    "resultSha256": "17d619058b0018fcb1fc92d0270c1832cf9b8d2736940fac7e58b6f320e40e05",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/baseline.json.supervisor.json",
    "supervisorSha256": "90ff47ab2dfbd5dc5ddb0be44466c7ac9d1e4a0d88ca623b0ae1bbf807d05863",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0285",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "src/lib/agents/operator/restore.ts",
    "originalOid": "8850b624d4207ca538508bdc3736c055863d54bf",
    "mutantSha256": "fd673163c4427bb65d53356d629a5e419d47ca84ddc0075c6eaa38e08496a03b",
    "selector": "AgentTurnWorker \\(live DB\\) restore completion and concurrent turn submission finish without a parent conversation deadlock",
    "selectorCorrection": null,
    "launch": 289,
    "resultPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/mutant.json",
    "resultSha256": "7fba60443f10df78780696626190ebe85f62840783c03319e8ba04785d9cf854",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0285-Xu8FkQ/mutant.json.supervisor.json",
    "supervisorSha256": "04c26cd5f6e77b3487533a72fe6e2104078ced768620be192e704fa42290b627",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0333",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval runs every structured task and Operator regression through both registered providers \\(9 x 2\\)",
    "selectorCorrection": null,
    "launch": 290,
    "resultPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/baseline.json",
    "resultSha256": "3cfd0b9e485227c906d0701fc596c53c6d56949e83b2eddb587b789e154d0bc1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/baseline.json.supervisor.json",
    "supervisorSha256": "c1f2b4c1efaeee897f58166999cbb86e8c1a48283a71e0e1289009613ec48673",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0333",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval runs every structured task and Operator regression through both registered providers \\(9 x 2\\)",
    "selectorCorrection": null,
    "launch": 291,
    "resultPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/mutant.json",
    "resultSha256": "6216e9781be9ba6c1fc3bcad2a0a8a944480d52dd8a92a064ecd33ed94e85fc2",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0333-P8Xdqt/mutant.json.supervisor.json",
    "supervisorSha256": "e14a72f25780a5ffa8aad39a585cbe075d20a8f56c6458631b79ef82e248ffb3",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0335",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval fails a case whose fallback output breaks the registered schema",
    "selectorCorrection": null,
    "launch": 292,
    "resultPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/baseline.json",
    "resultSha256": "243aa92a85de843d105e70b3788741005f05f345f26d8271588191fd942b809b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/baseline.json.supervisor.json",
    "supervisorSha256": "67b0afc63f7bebd3a0876c96a359ea075c841e04aee019fcc238bd62c221c496",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0335",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval fails a case whose fallback output breaks the registered schema",
    "selectorCorrection": null,
    "launch": 293,
    "resultPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/mutant.json",
    "resultSha256": "3884f5ab46351e721db8e05b91a97d76317141dcb3eb9ff555b05be2711ca258",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0335-yWOAWk/mutant.json.supervisor.json",
    "supervisorSha256": "7eec7ca035697f707162ced262d9c053d8b04e3904614a8fe7421eab3fb085e9",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0336",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval fails a schema-valid but semantically wrong result \\(question-only Operator output\\)",
    "selectorCorrection": null,
    "launch": 294,
    "resultPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/baseline.json",
    "resultSha256": "7cb4b3ef4fe33121d496c0dc3d6ddf70d3d87c4f5e665829786dec68add8af45",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/baseline.json.supervisor.json",
    "supervisorSha256": "90975b0183e5157771349e1f7cf1a4e9f628224b7c4c6f634843bf3c8a8a3d80",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0336",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval fails a schema-valid but semantically wrong result \\(question-only Operator output\\)",
    "selectorCorrection": null,
    "launch": 295,
    "resultPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/mutant.json",
    "resultSha256": "c66a66e8d1d4652606c99f1d1b7016bcff44fd81397ff7c53db16ae6f0897e24",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0336-KWueQM/mutant.json.supervisor.json",
    "supervisorSha256": "1c354d0bf22c124383410570245324a25c8efc2612e95207184b049a59255540",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0337",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "d8394df94511c09d3cb5de691f3a0c2afd1326ccfdeb7a3060078349867b6c53",
    "selector": "runStructuredEval fails an Operator proposal with the wrong star threshold or scope",
    "selectorCorrection": null,
    "launch": 296,
    "resultPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/baseline.json",
    "resultSha256": "86518112617e8fe0a26bcad3691063e671bf041b803e14b7a921db3fa8206527",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/baseline.json.supervisor.json",
    "supervisorSha256": "cb465ec900ad508620ec4be17661552d8e02b1ef068515a0863772aed723128a",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0337",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "d8394df94511c09d3cb5de691f3a0c2afd1326ccfdeb7a3060078349867b6c53",
    "selector": "runStructuredEval fails an Operator proposal with the wrong star threshold or scope",
    "selectorCorrection": null,
    "launch": 297,
    "resultPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/mutant.json",
    "resultSha256": "8a789d40837cd39d5f346b66ea884633bd22935266208abf5770c7a8a6d3569a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0337-hDbbEQ/mutant.json.supervisor.json",
    "supervisorSha256": "0da996ac4b5fd7c1eb5a88ff0e248b4468dd3c3f4e527796352b15cf5829e206",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0341",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval records a fallback exception once and continues to the next case without retrying",
    "selectorCorrection": null,
    "launch": 298,
    "resultPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/baseline.json",
    "resultSha256": "c9be2b8fe9155fa462c93f36f9cde5f0229c8720d015747e480f1ddcd8c3e078",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/baseline.json.supervisor.json",
    "supervisorSha256": "29ec648f6ec049eb7ce92e0bce13ef98ab77b8b9f55f1386bd49d6f5af5e853c",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0341",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "runStructuredEval records a fallback exception once and continues to the next case without retrying",
    "selectorCorrection": null,
    "launch": 299,
    "resultPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/mutant.json",
    "resultSha256": "2279bf35d942b79ef0838ed9b4a2912b3855f593e4a12b1c566456900fe85c5e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0341-MTF1T6/mutant.json.supervisor.json",
    "supervisorSha256": "f601b5d4e6932c5d088684f4d62a7a54a3ff3e0a29b8c89b01dfa4ec33a4aea5",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0344",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "Operator deployed-regression fixtures owner-operator-all-locations-off requires an account contraction despite blocked readiness and no pending reviews",
    "selectorCorrection": null,
    "launch": 300,
    "resultPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/baseline.json",
    "resultSha256": "b5fc0c7906703a61b2fb028a277e459351e25bb5c64cc8527c00065d1d3b3a96",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/baseline.json.supervisor.json",
    "supervisorSha256": "0194c76c04a3e141ae5b59d7559a9827588ab18429da5172886603349f764930",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0344",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "Operator deployed-regression fixtures owner-operator-all-locations-off requires an account contraction despite blocked readiness and no pending reviews",
    "selectorCorrection": null,
    "launch": 301,
    "resultPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/mutant.json",
    "resultSha256": "eaa22e48c52981b18e0eff441b974f99bc08b79c7aaf71b7aa900c991a56f405",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0344-e7kx88/mutant.json.supervisor.json",
    "supervisorSha256": "7d99a956d727309e3d781c0fd045789c0272932d4d1c471971bebc02ea43ca73",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0345",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "Operator deployed-regression fixtures owner-operator-account-default-off requires an account contraction despite blocked readiness and no pending reviews",
    "selectorCorrection": null,
    "launch": 302,
    "resultPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/baseline.json",
    "resultSha256": "3cbeb19ae52b696c34911dbbcc4a235e90b6e299c06a4ff454452e7b2f4230fc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/baseline.json.supervisor.json",
    "supervisorSha256": "b7e816b55e4b0ef2623d7147cf5064d4d17ca23af6911720a19578d94632968b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0345",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": "tests/llm-eval/structured-runner.ts",
    "originalOid": "a09409640ba1b6ad04d9666cd1e092f55a12e463",
    "mutantSha256": "120741f30a84320aea003a2a74ffb458aa89fb23f945edd9f075870bf8b54c7f",
    "selector": "Operator deployed-regression fixtures owner-operator-account-default-off requires an account contraction despite blocked readiness and no pending reviews",
    "selectorCorrection": null,
    "launch": 303,
    "resultPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/mutant.json",
    "resultSha256": "cab9fbb6b96455dfb20513d1eb67091beb3438bc8a071c71f4bba5644a6884fa",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0345-eYH92c/mutant.json.supervisor.json",
    "supervisorSha256": "af0959a6c210c41ab1b5687616d8b89f53b8caaf34189cf84bbf1667dbb9acda",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0507",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "e03fe1e5b76978e9a7c04135942abc81b5b9f1789b0f94ff1dbd0f72c046ace8",
    "selector": "Operator same-round continuation safeguards counts retained attempts and refuses a third semantic mutant",
    "selectorCorrection": null,
    "launch": 304,
    "resultPath": "/private/tmp/operator-continuation-rt-0507-cizhdS/baseline.json",
    "resultSha256": "b72b2e7c948805119dc8bea343578ed11b5475e2315ace1657de52b9430af2bc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0507-cizhdS/baseline.json.supervisor.json",
    "supervisorSha256": "cf64a2592c1d2d770c4b8949ce176e0b24ed57d7295f45ca7e5eb9492fa53cc4",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0507",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "e03fe1e5b76978e9a7c04135942abc81b5b9f1789b0f94ff1dbd0f72c046ace8",
    "selector": "Operator same-round continuation safeguards counts retained attempts and refuses a third semantic mutant",
    "selectorCorrection": null,
    "launch": 305,
    "resultPath": "/private/tmp/operator-continuation-rt-0507-cizhdS/mutant.json",
    "resultSha256": "692ea25dc07d29f8c705e2ae077665f9827a4b66d76752d60774b257247130be",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0507-cizhdS/mutant.json.supervisor.json",
    "supervisorSha256": "fee203d49d6fbd77721f8e728e8ef5efe9dfd3a1e62a1fb850f1434d58d300c0",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0508",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "f6d52762be5ad04f46e0e823f03328357008a760ae582fb9059b5516d027b0c4",
    "selector": "Operator same-round continuation safeguards rejects reset counters lower rounds and missing candidate metadata",
    "selectorCorrection": null,
    "launch": 306,
    "resultPath": "/private/tmp/operator-continuation-rt-0508-raRWms/baseline.json",
    "resultSha256": "29e760fc61318824ff04b3329b6466d4841fb9c6c227a8578f3a8a2b81a9f35c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0508-raRWms/baseline.json.supervisor.json",
    "supervisorSha256": "62a243a010a40aa7472aa02215e51a3e06528796c38bebe70a2647f530f49983",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0508",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "f6d52762be5ad04f46e0e823f03328357008a760ae582fb9059b5516d027b0c4",
    "selector": "Operator same-round continuation safeguards rejects reset counters lower rounds and missing candidate metadata",
    "selectorCorrection": null,
    "launch": 307,
    "resultPath": "/private/tmp/operator-continuation-rt-0508-raRWms/mutant.json",
    "resultSha256": "5f6d431468a8bd0ad813bc94bea519f4f8d16d6eb19e2b5b3577af5260cb8aba",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0508-raRWms/mutant.json.supervisor.json",
    "supervisorSha256": "4963f923c2902750467f3f8cf9e42101eed3b60d83ee3996f8b71d777f539cbc",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0509",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "b144fbdeee9b4f02fedf3876133cedd3c6357a73fe08c7da8d10d6bbf819d1c9",
    "selector": "Operator same-round continuation safeguards retains lineage after branch rename and journal deletion without generic fallback",
    "selectorCorrection": null,
    "launch": 308,
    "resultPath": "/private/tmp/operator-continuation-rt-0509-db5svE/baseline.json",
    "resultSha256": "4b52806e8762744577b479826e7eb6d6274a6b545d50f99f41189fe4d9b86986",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0509-db5svE/baseline.json.supervisor.json",
    "supervisorSha256": "519e84c0370ca5d9828e34c00fdb9eee47f2fdaaf300b63f335add15b7bf18d6",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0509",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "b144fbdeee9b4f02fedf3876133cedd3c6357a73fe08c7da8d10d6bbf819d1c9",
    "selector": "Operator same-round continuation safeguards retains lineage after branch rename and journal deletion without generic fallback",
    "selectorCorrection": null,
    "launch": 309,
    "resultPath": "/private/tmp/operator-continuation-rt-0509-db5svE/mutant.json",
    "resultSha256": "e58db77ec13767595ba82b9162d0acdcd7692b6415d686b2e02882cbc8a120e7",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0509-db5svE/mutant.json.supervisor.json",
    "supervisorSha256": "d637b140c296c14530b0471d77a9799ae6a42b7de725ac24f6bab1c42b5e77f8",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0510",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "6db5c11b1af1ee3510a63e48f9bf2e4ea02b636229457f39dfcf5da848d315f3",
    "selector": "Operator same-round continuation safeguards refuses mutation and launch before immutable admission even on the exact branch",
    "selectorCorrection": null,
    "launch": 310,
    "resultPath": "/private/tmp/operator-continuation-rt-0510-gbtX5x/baseline.json",
    "resultSha256": "d01353c718809bb5d7e909a23a7dd3dea8f724ab603fff54ebc28a4d741b0e14",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0510-gbtX5x/baseline.json.supervisor.json",
    "supervisorSha256": "e27e11ed95be1ad3a6eae44371dce50721e3a01848bd5cd9232cca3a0937dab4",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0510",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "6db5c11b1af1ee3510a63e48f9bf2e4ea02b636229457f39dfcf5da848d315f3",
    "selector": "Operator same-round continuation safeguards refuses mutation and launch before immutable admission even on the exact branch",
    "selectorCorrection": null,
    "launch": 311,
    "resultPath": "/private/tmp/operator-continuation-rt-0510-gbtX5x/mutant.json",
    "resultSha256": "a547762f0d97f5da5c07df1fe742f57fc712abf335dd69e9c9bf4b3aed673109",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0510-gbtX5x/mutant.json.supervisor.json",
    "supervisorSha256": "72afe0ec257f7e57124ac727e9b69e9d5cc8b12129d7c233f99092bd5245bc66",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0511",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "db2e14f34d7eaff8907fec525c47c5e4bb4af6956df90a1dd20dc8d8005a7fea",
    "selector": "Operator same-round continuation safeguards rejects altered retained result digests instead of trusting legacy mapping prose",
    "selectorCorrection": null,
    "launch": 312,
    "resultPath": "/private/tmp/operator-continuation-rt-0511-EoeL36/baseline.json",
    "resultSha256": "c4676b388fc37a63a29878483b2653bcb622a2c12041e88b6954364ed1ea260e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0511-EoeL36/baseline.json.supervisor.json",
    "supervisorSha256": "6f5948a17037be2d0bb8cf2163ae93bd7bc3d382c2e7e7249d55352542369274",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0511",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "db2e14f34d7eaff8907fec525c47c5e4bb4af6956df90a1dd20dc8d8005a7fea",
    "selector": "Operator same-round continuation safeguards rejects altered retained result digests instead of trusting legacy mapping prose",
    "selectorCorrection": null,
    "launch": 313,
    "resultPath": "/private/tmp/operator-continuation-rt-0511-EoeL36/mutant.json",
    "resultSha256": "8e4599e8f44f8e9a1f1ad8e8714c0be0946feab82b31664f6f628986d96e5181",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0511-EoeL36/mutant.json.supervisor.json",
    "supervisorSha256": "1c8a074376086e03be1a1e4cdef7a9c568af7a33e0ea5a25ed27f314c0c2946b",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0512",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "f16f6b4c0680d7cff3ee098418e0a0849b46aca73fdfdad38c264ee75d7fb2b7",
    "selector": "Operator continuation evidence corroboration accepts only a digested candidate-bound green baseline and assertion-failing mutant pair",
    "selectorCorrection": null,
    "launch": 314,
    "resultPath": "/private/tmp/operator-continuation-rt-0512-hmJPZQ/baseline.json",
    "resultSha256": "65df55d09f6b1779d6c8dd29a6ef99d07d4cda77d9591a080ea3f1d91cb7ae41",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0512-hmJPZQ/baseline.json.supervisor.json",
    "supervisorSha256": "56c9773b8c3d207105ebd9d31cb44bacb9f65c9ead6468ebcdec16077a78f70e",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0512",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "f16f6b4c0680d7cff3ee098418e0a0849b46aca73fdfdad38c264ee75d7fb2b7",
    "selector": "Operator continuation evidence corroboration accepts only a digested candidate-bound green baseline and assertion-failing mutant pair",
    "selectorCorrection": null,
    "launch": 315,
    "resultPath": "/private/tmp/operator-continuation-rt-0512-hmJPZQ/mutant.json",
    "resultSha256": "ea66be7306244777013616341d725555d18d503866a90ce6f679e58609d28b63",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0512-hmJPZQ/mutant.json.supervisor.json",
    "supervisorSha256": "3fab658e889d59bb62f1eabb9c6bcbbe34f30d2953f518a21447879bde4590be",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0513",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "93dc18c3ae174e9711b0cabc247ae625689c9dd4650f2e42f470187d0353c171",
    "selector": "Operator continuation evidence corroboration rejects another candidate selector admission target or attempt as kill evidence",
    "selectorCorrection": null,
    "launch": 316,
    "resultPath": "/private/tmp/operator-continuation-rt-0513-JUj6w0/baseline.json",
    "resultSha256": "53ac8c3ce50059418bfe6009c243c366ed03966cca4c0bca59d07d14250457d4",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0513-JUj6w0/baseline.json.supervisor.json",
    "supervisorSha256": "6554f3e763585c093137b67cadce8803832aed02a1dd99e455e0d2d8e8b6c999",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0513",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "93dc18c3ae174e9711b0cabc247ae625689c9dd4650f2e42f470187d0353c171",
    "selector": "Operator continuation evidence corroboration rejects another candidate selector admission target or attempt as kill evidence",
    "selectorCorrection": null,
    "launch": 317,
    "resultPath": "/private/tmp/operator-continuation-rt-0513-JUj6w0/mutant.json",
    "resultSha256": "025a4576dc3de485e71d5053169efe42846d8a11863e19feaecec8ed8ede82d8",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0513-JUj6w0/mutant.json.supervisor.json",
    "supervisorSha256": "9d98d27afa8d94dead1a1fa35df32d525b2f2ec6da8437b29cf6974a88ae3b1f",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0514",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "489463f46a570f07b58544e071421e03852c000a3476923e0c4b9ce4f5a4fe57",
    "selector": "Operator continuation evidence corroboration rejects altered artifacts multiple executed tests setup errors and red baselines",
    "selectorCorrection": null,
    "launch": 318,
    "resultPath": "/private/tmp/operator-continuation-rt-0514-8S047P/baseline.json",
    "resultSha256": "70abfe5de60bf04705b3b0930b4c2f9ed733e45eaabac9d770d660d5dfedd35d",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0514-8S047P/baseline.json.supervisor.json",
    "supervisorSha256": "5c43b80ce16d51adbc495398b77c06cffc861771340f21b88de2c43011442665",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0514",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "489463f46a570f07b58544e071421e03852c000a3476923e0c4b9ce4f5a4fe57",
    "selector": "Operator continuation evidence corroboration rejects altered artifacts multiple executed tests setup errors and red baselines",
    "selectorCorrection": null,
    "launch": 319,
    "resultPath": "/private/tmp/operator-continuation-rt-0514-8S047P/mutant.json",
    "resultSha256": "1f5113ea0e4f8eae377cf33b4004bd31b4b7ed07d3dfa898175a0a4401176546",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0514-8S047P/mutant.json.supervisor.json",
    "supervisorSha256": "148247179cc92b65310750e56178dd5ce2e99b4505714e5ba4dfee6cba5201cc",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0515",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/feature/scripts/red-team-status.mjs",
    "originalOid": "3126ab66a92bc61bd078814ff262d09e2f1bdcce",
    "mutantSha256": "b9b0fc4b0940acab6c7d0ce0b1f973974145f965bf81861a66459006b085211d",
    "selector": "Operator continuation evidence corroboration refuses normal-risk waiver after continuation lineage survives a branch rename",
    "selectorCorrection": null,
    "launch": 320,
    "resultPath": "/private/tmp/operator-continuation-rt-0515-DFm11m/baseline.json",
    "resultSha256": "a8ed5c91ecda23e1a443d36902921dd3c7b2f1e3c4fe305eac6732190f2f5db3",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0515-DFm11m/baseline.json.supervisor.json",
    "supervisorSha256": "0e2bfda739be6f160aec2b79d97c679cb9c564d6e58790da2d91264ef040b1a1",
    "code": 0,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0515",
    "attempt": 1,
    "phase": "mutant",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/feature/scripts/red-team-status.mjs",
    "originalOid": "3126ab66a92bc61bd078814ff262d09e2f1bdcce",
    "mutantSha256": "b9b0fc4b0940acab6c7d0ce0b1f973974145f965bf81861a66459006b085211d",
    "selector": "Operator continuation evidence corroboration refuses normal-risk waiver after continuation lineage survives a branch rename",
    "selectorCorrection": null,
    "launch": 321,
    "resultPath": "/private/tmp/operator-continuation-rt-0515-DFm11m/mutant.json",
    "resultSha256": "3cd724feccc5172efbe736ca6f0631e8d6b15cdfe4cce1eda3e756bd4dbbcafe",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0515-DFm11m/mutant.json.supervisor.json",
    "supervisorSha256": "7adffbb3f956dd64c7a30a7af4123845e7354af94f3488d0744bd35c04dfcfbb",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0516",
    "attempt": 1,
    "phase": "baseline",
    "control": "e3bd968ae9fca8e0d787291cf067c266e67d89f9",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "cbbcac12a6bd75b3acc93ccbd8ae2d18bfd91c17",
    "mutantSha256": "2ba73adcd67a410862bc4262e625b61df9c4e5be23a6e0ba2c7a5f6f0e27ab90",
    "selector": "Operator same-round continuation safeguards runs an admitted baseline mutant and restoration with corroborated report evidence",
    "selectorCorrection": null,
    "launch": 322,
    "resultPath": "/private/tmp/operator-continuation-rt-0516-YhBidM/baseline.json",
    "resultSha256": "2bc0dcd7d4999d3eb769198ea2d3375c5b9be7229991b9f7018c28e1e38e389a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0516-YhBidM/baseline.json.supervisor.json",
    "supervisorSha256": "8d4acc1196497c4b8947bf9787da7c287d9adeab98817fd307c69cf70218dc7d",
    "code": 1,
    "rootSelection": "not selected by root"
  },
  {
    "id": "rt-0103",
    "attempt": 1,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "^GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=00000000-0000-4000-8000-000000000003$",
    "selectorCorrection": "operator-fallow-round-1-selection-and-resolves",
    "launch": 323,
    "resultPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/baseline.json",
    "resultSha256": "0d2440ff926d88c080570af71dc9e8b18f3bdc43212456b2f149c4429bf11a77",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/baseline.json.supervisor.json",
    "supervisorSha256": "b5ce4809f4ebbf1579e2730626d73ca503c4bafc1730f3adaf5163796f615ade",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0103",
    "attempt": 1,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": "src/app/api/operator/gate.ts",
    "originalOid": "264fc46df7673175aaca4837cafe59c2b888a445",
    "mutantSha256": "abfc585a44763245df1e220c480008da21de028769e04b8b0c05540b8f923f94",
    "selector": "^GET Rules timeline rejects malformed, unpaired or unbounded query inputs: \\?cursorId=00000000-0000-4000-8000-000000000003$",
    "selectorCorrection": "operator-fallow-round-1-selection-and-resolves",
    "launch": 324,
    "resultPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/mutant.json",
    "resultSha256": "3c973052d5d6e3bc286cab649cb5439da00b1701609c93e8b5aab149e2bd38e1",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0103-2zz6Bg/mutant.json.supervisor.json",
    "supervisorSha256": "e77eeb0db09562fae1aba1871681b339d4c9866fc440cd613d4d2314ddf0abdf",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0502",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "c7633515f52733fbd1b4026d65744b3f7b710d60cb99954c871d580125d5e6c7",
    "selector": "Operator same-round continuation safeguards continues at launch 31 and shares the finite ceiling through launch 1500",
    "selectorCorrection": null,
    "launch": 325,
    "resultPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/baseline.json",
    "resultSha256": "32c9205c2b37521b7ac3e88b8cb0f59b972ab78b5708a7724fa7aacf32995a2f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/baseline.json.supervisor.json",
    "supervisorSha256": "5b5b4d16073f618a7c8e87e86069938448ac2b6260174eaef050b2d3ff9db9ac",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0502",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "c7633515f52733fbd1b4026d65744b3f7b710d60cb99954c871d580125d5e6c7",
    "selector": "Operator same-round continuation safeguards continues at launch 31 and shares the finite ceiling through launch 1500",
    "selectorCorrection": null,
    "launch": 326,
    "resultPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/mutant.json",
    "resultSha256": "4a418667aec7b44ccf22467150171827076ddcf2d724ff76cd2ad0f1ad841826",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0502-64PHHp/mutant.json.supervisor.json",
    "supervisorSha256": "bd8f236ebc1e3f8dcc68065229bbe68ccab039cc50fd283c7ca673b68f8369f7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0503",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "80d3ccb3838405b083c2a620f9f45138c68cb17c0859c0c15c0c0d1a081ef5b8",
    "selector": "Operator same-round continuation safeguards rejects invalid and over-ceiling continuation timeouts",
    "selectorCorrection": null,
    "launch": 327,
    "resultPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/baseline.json",
    "resultSha256": "c2d5892031dfea4907d803db852662da82109cc184943422aae53788e7948bd8",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/baseline.json.supervisor.json",
    "supervisorSha256": "8653fb1be31eca0b606b5120db91ac15f97817c0787cce45b729943b6539113d",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0503",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "80d3ccb3838405b083c2a620f9f45138c68cb17c0859c0c15c0c0d1a081ef5b8",
    "selector": "Operator same-round continuation safeguards rejects invalid and over-ceiling continuation timeouts",
    "selectorCorrection": null,
    "launch": 328,
    "resultPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/mutant.json",
    "resultSha256": "3479939a9994a7dcd18eed25e55cd8db78e1e71dcfd5b0f0fb0e62418ddfdd4e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0503-r6vUnZ/mutant.json.supervisor.json",
    "supervisorSha256": "af74f46c5fcf7c32323f9ce1e98879524b15497f07e8679ceee0eab20945eb86",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0504",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "4ad465f37870127d0a3be2a59caf132adbbf5aa4a3bbebfb6cc5a4a5f0c45133",
    "selector": "Operator same-round continuation safeguards preserves every original mutation and supervisor in the checkpoint prefix",
    "selectorCorrection": null,
    "launch": 329,
    "resultPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/baseline.json",
    "resultSha256": "96347a6f3788b000098d68b6005ca059a5a93bfc67516967f98c81eb159b5b2a",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/baseline.json.supervisor.json",
    "supervisorSha256": "ef2404c31a8890e7324139561bfff5773f51c99c2f49e26dc3619de6fedc227e",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0504",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "4ad465f37870127d0a3be2a59caf132adbbf5aa4a3bbebfb6cc5a4a5f0c45133",
    "selector": "Operator same-round continuation safeguards preserves every original mutation and supervisor in the checkpoint prefix",
    "selectorCorrection": null,
    "launch": 330,
    "resultPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/mutant.json",
    "resultSha256": "ea9e7403c5bbd280204b35fae322635d4422445151fa60a8bf296b5bdbfcd9d9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0504-W5toqf/mutant.json.supervisor.json",
    "supervisorSha256": "ae571fc9a64dd6396882e38f31dec8dcf4e173e88f464549245d7d7d77cb6968",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0505",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "05ddec2a63728c62bd200a0d340c8bbbd0fec144bc3d35ef3404844b66375d42",
    "selector": "Operator same-round continuation safeguards rejects missing swapped or reset legacy candidate launch mappings",
    "selectorCorrection": null,
    "launch": 331,
    "resultPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/baseline.json",
    "resultSha256": "7c602a5491ee67a9b8c9ab4a91811b08b6bacc15432394b10b963b5c7c9673bf",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/baseline.json.supervisor.json",
    "supervisorSha256": "0b889ab68d36402d39fdb4b896883373d4f2e56a072b21f080baca96e5328e00",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0505",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "05ddec2a63728c62bd200a0d340c8bbbd0fec144bc3d35ef3404844b66375d42",
    "selector": "Operator same-round continuation safeguards rejects missing swapped or reset legacy candidate launch mappings",
    "selectorCorrection": null,
    "launch": 332,
    "resultPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/mutant.json",
    "resultSha256": "26f959d093a8563d48218a891c526bf14ed89356bd8f279944e4550938a532d0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0505-gIHB6S/mutant.json.supervisor.json",
    "supervisorSha256": "e8101cc5343ed6dc63e8c920dc8d572f3754ba340148d986be31394697945b45",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0506",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "0ab30c5916c0f3ef668dfd39ae6ca1a13c770e94e8c321a158b7fe67ca6e89df",
    "selector": "Operator same-round continuation safeguards rejects changed inventory identities duplicate selectors and unapproved suffix files",
    "selectorCorrection": null,
    "launch": 333,
    "resultPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/baseline.json",
    "resultSha256": "0a8a62902e10384fb75da702f1b26e19aa5504eaee9e99e80f28359a7a95add0",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/baseline.json.supervisor.json",
    "supervisorSha256": "bf4a6a75dbbbdea8c8c16b6010b3c44f5b4b66a23f70dd0bf26229b371faa834",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0506",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "0ab30c5916c0f3ef668dfd39ae6ca1a13c770e94e8c321a158b7fe67ca6e89df",
    "selector": "Operator same-round continuation safeguards rejects changed inventory identities duplicate selectors and unapproved suffix files",
    "selectorCorrection": null,
    "launch": 334,
    "resultPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/mutant.json",
    "resultSha256": "2f057d3b12f8117735c54aac19db2fd8a24c1c19096ebce8e7604c29c806a01c",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0506-HOTTjB/mutant.json.supervisor.json",
    "supervisorSha256": "fe490a3f6f4750a1f9fc72a41f1bc955fc4a607296afeb93f7d8601640de78a7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0507",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "d706b99ca02ff4e555edb5ddca8f68e8cce4a2a6492b5183325bc641bcef98fe",
    "selector": "Operator same-round continuation safeguards counts retained attempts and refuses a third semantic mutant",
    "selectorCorrection": null,
    "launch": 335,
    "resultPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/baseline.json",
    "resultSha256": "f6d77d9d0e1414cc3b5542a5fe716a3cf737de212ab5f2eeab9f59f1413f4cb5",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/baseline.json.supervisor.json",
    "supervisorSha256": "ac238fe30f692deca30252a911687c786b69b76a52e8abb6ec5a194c83b906e3",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0507",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "d706b99ca02ff4e555edb5ddca8f68e8cce4a2a6492b5183325bc641bcef98fe",
    "selector": "Operator same-round continuation safeguards counts retained attempts and refuses a third semantic mutant",
    "selectorCorrection": null,
    "launch": 336,
    "resultPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/mutant.json",
    "resultSha256": "0822166870aa59dbf1f586df97b365f91745d67e47e837c2eae67ac4847a4673",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0507-4gVhtX/mutant.json.supervisor.json",
    "supervisorSha256": "f08c1696e9f99342b9740231ea4d2cd3c8d89163b0858a829d18580507e6a0c7",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0508",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "6941d20574814b32383627a4298f7e3b19ffe4d9178806a87c2af897bf7281c0",
    "selector": "Operator same-round continuation safeguards rejects reset counters lower rounds and missing candidate metadata",
    "selectorCorrection": null,
    "launch": 337,
    "resultPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/baseline.json",
    "resultSha256": "2b8b35cca25e68aa2e9cd474458c67924049a13b74a4fa2e72334f977fd773ba",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/baseline.json.supervisor.json",
    "supervisorSha256": "2e01d2298c0c0be7833587d9a8d6597f881729f1cb87dca8423199374c73593b",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0508",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "6941d20574814b32383627a4298f7e3b19ffe4d9178806a87c2af897bf7281c0",
    "selector": "Operator same-round continuation safeguards rejects reset counters lower rounds and missing candidate metadata",
    "selectorCorrection": null,
    "launch": 338,
    "resultPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/mutant.json",
    "resultSha256": "39bc9f84631fb2c2d5a846daeb7991bfd13a2af9a851327d0e9f2aa69f1f43f9",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0508-Um4ASv/mutant.json.supervisor.json",
    "supervisorSha256": "513ca01e723b366659d8ddab6a2bbbed26be8ee11b27c349a42e0ba35c9c4fd3",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0509",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "b569b5597e132151d7bb4cc24ee5a5481a2ff3c5d9440cb94f3ec3a3f86ead75",
    "selector": "Operator same-round continuation safeguards retains lineage after branch rename and journal deletion without generic fallback",
    "selectorCorrection": null,
    "launch": 339,
    "resultPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/baseline.json",
    "resultSha256": "820649c444ef1e97db684f9e8745a070f9639c974fcd66e3107d3389077d5adb",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/baseline.json.supervisor.json",
    "supervisorSha256": "2123fff537d367d251705de8961ddc522b2e36aac06717ee243349e16e7bd4d5",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0509",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "b569b5597e132151d7bb4cc24ee5a5481a2ff3c5d9440cb94f3ec3a3f86ead75",
    "selector": "Operator same-round continuation safeguards retains lineage after branch rename and journal deletion without generic fallback",
    "selectorCorrection": null,
    "launch": 340,
    "resultPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/mutant.json",
    "resultSha256": "44a40c163d5aa337236269514c237d32bbea64621e28b1b4a960032c7fcd4388",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0509-3Fx4mB/mutant.json.supervisor.json",
    "supervisorSha256": "66ffea210fd732a05e4294b019ff239ce73bd364438151192916e4b98f271ef2",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0510",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "8114840b406991a0ba56b760a8a27ed61db3fecf59af6aa9c0931ee907b30f06",
    "selector": "Operator same-round continuation safeguards refuses mutation and launch before immutable admission even on the exact branch",
    "selectorCorrection": null,
    "launch": 341,
    "resultPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/baseline.json",
    "resultSha256": "e0b1b395c1ff223e6423adc6dc499825c78579466f4d4c661287cc7c218d6075",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/baseline.json.supervisor.json",
    "supervisorSha256": "9fbd5e9d6fcd6875a0c60880b688b959a0ca21316f5f2ad575f5d55aaeacbf85",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0510",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "8114840b406991a0ba56b760a8a27ed61db3fecf59af6aa9c0931ee907b30f06",
    "selector": "Operator same-round continuation safeguards refuses mutation and launch before immutable admission even on the exact branch",
    "selectorCorrection": null,
    "launch": 342,
    "resultPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/mutant.json",
    "resultSha256": "1749babd15684431509efea7e92430b98bc76336d6a36db228c53d7066c6070e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0510-OYLNgp/mutant.json.supervisor.json",
    "supervisorSha256": "b4045c6a4eda70123a84b6f446515b1dd3fe8339867120b81d9029f8d8c95db6",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0511",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "3a95df35c9031e02bbb31195a0332f3ada468a06f3312d5470dec909ce9bd7b0",
    "selector": "Operator same-round continuation safeguards rejects altered retained result digests instead of trusting legacy mapping prose",
    "selectorCorrection": null,
    "launch": 343,
    "resultPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/baseline.json",
    "resultSha256": "a2876225413564bde7eb32c3431dcf9c639740040d217c09c6a19c4850639116",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/baseline.json.supervisor.json",
    "supervisorSha256": "efd6078923467dbc25f90d9938ac8efa3c08f2490712a67b1b6e1318d7da30fc",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0511",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "3a95df35c9031e02bbb31195a0332f3ada468a06f3312d5470dec909ce9bd7b0",
    "selector": "Operator same-round continuation safeguards rejects altered retained result digests instead of trusting legacy mapping prose",
    "selectorCorrection": null,
    "launch": 344,
    "resultPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/mutant.json",
    "resultSha256": "73e17a5f6aacaa8a3992da81041a4fd094db3c1397ab83ca5d35bed58b8683dc",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0511-C4DRfm/mutant.json.supervisor.json",
    "supervisorSha256": "641a90588287de5170f67b1d8142667a98c9f88ef8a0e5cae556d83396f7e479",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0512",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "153ae4f06e8ab03953c7708eb4604a78fbd886f6c88ee6962bc2f92c8c2ecc74",
    "selector": "Operator continuation evidence corroboration accepts only a digested candidate-bound green baseline and assertion-failing mutant pair",
    "selectorCorrection": null,
    "launch": 345,
    "resultPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/baseline.json",
    "resultSha256": "afd7cf9f9fc95cf350b22f674ded35ccf0327d2fdf5b08bd06dc24c4bd6d3100",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/baseline.json.supervisor.json",
    "supervisorSha256": "7b500a6f5793743e957b1a94d181cf893a8b8e81ce84749c51d07decf2bfc69a",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0512",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "153ae4f06e8ab03953c7708eb4604a78fbd886f6c88ee6962bc2f92c8c2ecc74",
    "selector": "Operator continuation evidence corroboration accepts only a digested candidate-bound green baseline and assertion-failing mutant pair",
    "selectorCorrection": null,
    "launch": 346,
    "resultPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/mutant.json",
    "resultSha256": "6bc11ab877ac49830d2d239feea84098e941a1af3c7e76840663f402e760acae",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0512-Vaw3NC/mutant.json.supervisor.json",
    "supervisorSha256": "61441a4acc7a1e44005a8fdefcf5e4b33f2d106d072cffdadfbdf89e6338e2ad",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0513",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "aaabc18b315dc8730ba32dd176d550a81ee751e3358601c4799cb26ac3a03a07",
    "selector": "Operator continuation evidence corroboration rejects another candidate selector admission target or attempt as kill evidence",
    "selectorCorrection": null,
    "launch": 347,
    "resultPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/baseline.json",
    "resultSha256": "17863eb6448500d3886750fe641f039014b1586cbe98be5ddcf1a8085e2b253f",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/baseline.json.supervisor.json",
    "supervisorSha256": "6b5030fbe682e5ef26a1386568785995cf3f7d12dbe226cac09354977aa785cf",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0513",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "aaabc18b315dc8730ba32dd176d550a81ee751e3358601c4799cb26ac3a03a07",
    "selector": "Operator continuation evidence corroboration rejects another candidate selector admission target or attempt as kill evidence",
    "selectorCorrection": null,
    "launch": 348,
    "resultPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/mutant.json",
    "resultSha256": "125de38c7ae3a0825c0ba42916e1d6e2bda3c8f89536bf3b56173335521b0f9b",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0513-OMmZUX/mutant.json.supervisor.json",
    "supervisorSha256": "ce545e6e2e3289fbed2ec542f72ca658fb6d9c8e7c6918dab30b713c910deafd",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0514",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "79c5ce9c02cc984479af60c98503e9edb1838cca370435e137e7b6c04928578f",
    "selector": "Operator continuation evidence corroboration rejects altered artifacts multiple executed tests setup errors and red baselines",
    "selectorCorrection": null,
    "launch": 349,
    "resultPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/baseline.json",
    "resultSha256": "981aad055dd1b26254157f714ea1fdf449b9e01470b9689f03e02f4c8e542958",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/baseline.json.supervisor.json",
    "supervisorSha256": "b8604dc88ae5b18e24dd57e444fd4afd1d6ac0471dc0c884096a3402f5b0bb32",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0514",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "79c5ce9c02cc984479af60c98503e9edb1838cca370435e137e7b6c04928578f",
    "selector": "Operator continuation evidence corroboration rejects altered artifacts multiple executed tests setup errors and red baselines",
    "selectorCorrection": null,
    "launch": 350,
    "resultPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/mutant.json",
    "resultSha256": "21f842ce2977a061fcd662d83386bafe3ab23d4f67fc61f4daa1467bf82f9794",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0514-zydoLV/mutant.json.supervisor.json",
    "supervisorSha256": "fd8a7e5fc09c03e8c786d3d58c323e1980cc5b97d79c2b2d5d2e9f48faa793d4",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0515",
    "attempt": 2,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/feature/scripts/red-team-status.mjs",
    "originalOid": "24b04b599910e3b50780af0d0229298bb982c092",
    "mutantSha256": "528dac3ee6cd8cc015f6b352343d31d8ff39409a6982d9392cf460766d5602b8",
    "selector": "Operator continuation evidence corroboration refuses normal-risk waiver after continuation lineage survives a branch rename",
    "selectorCorrection": null,
    "launch": 351,
    "resultPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/baseline.json",
    "resultSha256": "da5cdfd7f23f53491bda735d0ce4184728274bda7bfb991669940adda5eeade6",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/baseline.json.supervisor.json",
    "supervisorSha256": "a312b119d73eaa52b9dd426051c920d58ce8437f74f5d56492564c39635c3054",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0515",
    "attempt": 2,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/feature/scripts/red-team-status.mjs",
    "originalOid": "24b04b599910e3b50780af0d0229298bb982c092",
    "mutantSha256": "528dac3ee6cd8cc015f6b352343d31d8ff39409a6982d9392cf460766d5602b8",
    "selector": "Operator continuation evidence corroboration refuses normal-risk waiver after continuation lineage survives a branch rename",
    "selectorCorrection": null,
    "launch": 352,
    "resultPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/mutant.json",
    "resultSha256": "b495220374e0dcbb09620b4092535179fe16606334a63b86222bf73af544f10e",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0515-6FeDgJ/mutant.json.supervisor.json",
    "supervisorSha256": "430a9f42ee6e403b77711472b9a6b814250f245891814b1c7137ed610b49a413",
    "code": 1,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0516",
    "attempt": 1,
    "phase": "baseline",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "7636fed1bb11fcd408456a7c1316dca69850e8f7ad8a90cf910792cf6e8c79ec",
    "selector": "Operator same-round continuation safeguards runs an admitted baseline mutant and restoration with corroborated report evidence",
    "selectorCorrection": null,
    "launch": 353,
    "resultPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/baseline.json",
    "resultSha256": "26d441e980613b145cca2272027463a5b968be972664aa8032fd6bebf79a5ebd",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/baseline.json.supervisor.json",
    "supervisorSha256": "f46d9775e592ae9206d65a3024ca3bcdbba3e0845bc911f02ac63ba466d25a70",
    "code": 0,
    "rootSelection": "killed"
  },
  {
    "id": "rt-0516",
    "attempt": 1,
    "phase": "mutant",
    "control": "b1fe8af88e84167318e7ba3a662e0be1539560c4",
    "target": ".agents/skills/red-team/scripts/mutation-runner.mjs",
    "originalOid": "f2c5a45f55fbc9e9ddbe02438dfcc14219d3f1a7",
    "mutantSha256": "7636fed1bb11fcd408456a7c1316dca69850e8f7ad8a90cf910792cf6e8c79ec",
    "selector": "Operator same-round continuation safeguards runs an admitted baseline mutant and restoration with corroborated report evidence",
    "selectorCorrection": null,
    "launch": 354,
    "resultPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/mutant.json",
    "resultSha256": "d6c496053dcdb4af3c072a37f5b199ed04eaba3f973522d55a5185002c19b5ee",
    "supervisorPath": "/private/tmp/operator-continuation-rt-0516-IfenPb/mutant.json.supervisor.json",
    "supervisorSha256": "6c9ab16e99372acf99cfe72055f9d27a29e0485926fb54343d6429f28eb69b92",
    "code": 1,
    "rootSelection": "killed"
  }
]
```

### Unresolved cases (0)

| Candidate | Outcome | Reason |
|---|---|---|
