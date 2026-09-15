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
