# Independent extension design review

The following proposal is retained as the pre-approval review artifact. The actual subsequent owner approval is recorded in `second-pass-authorization.md`. Implementation must use the exact five source-template test promises in the amended intake; the UI template expands into both approved cases. The alert patch's structured-log wording was corrected before application.

# Proposed Run E second adversarial pass

Status: concrete design for owner review. **Not owner-approved.** No verifier, skill, intake, alerting, production or test file was changed while preparing this proposal, and no test/provider call was made. The authorization text below is proposed wording; the eventual record must quote the actual question and actual owner response verbatim.

## Decision requested

Authorize one branch-specific extension for `codex/owner-operator-run-e`, **round 2 only**, capped at **1,600 supervised local test launches**. It completes the unmeasured original inventory, verifies the accepted E fixes and their directly affected callers, and verifies the extension's own safeguards. It grants no third round, external provider calls, external Claude/Opus delegation, production Operator enablement, accepted-risk disposition, or waiver of unmeasured coverage.

The same grant authorizes the finite supporting paths below, the corrected deterministic report directory, and adding/installing/reading back the matching Restore invariant alert on staging as part of approved E verification. It does not claim an alert delivery drill before one executes. A matching production rule must exist before any future production Operator enablement; this grant does not authorize that enablement.

Final report formatting is included: retain the exact execution grant permanently in immutable admission history, with final risk-waiver `authorizations: []` because no risk is waived. No second approval is needed merely to express this agreed report format.

## Frozen evidence and budget

Round-1 measurements and the mutation finalizer completed against `890eea76c8c04b8d2acfcc73a895ec3112560e38`, fork/merge-base `30896acbcb2ee127131504e531f230fcfc7e4409`, before the root's authorized code fixes. Final report generation remained pinned to that measured head and overlapped the root's fixes; the completed artifact bytes were frozen under `/private/tmp/run-e-round1-report/` after generation and have never been altered. Do not claim that final report bytes predated the fixes. Independently read and hashed:

| Artifact | SHA-256 |
| --- | --- |
| `findings.json` | `b869b052d2f39574c51418e2a608f136c43e375853e3692385921f95c2259a0c` |
| `findings.md` | `42cc8719dba7356dac5e626b6d606628789b5d24698de4e7998cbcb138b0cc46` |
| Ordered `{id,file,test}` identities, compact JSON serialization | `cb7c194ac0f963e76e723f123007c143b913aea924360b77439b6a8007c4476b` |

The original 2,113 rows contain 722 in-scope cases: 15 killed and 707 `skipped-budget`; 1,391 are explicitly excluded. Original status is `INCOMPLETE_BUDGET`, with three open P1 findings. These are historical facts, not replaced by the proposed pass.

The minimum for the 707 unmeasured cases is 1,414 launches: one green individual baseline and one mutant per case. The two current UI regression cases require at least four more launches, leaving at most 182 launches for safeguard cases, necessary affected-case remeasurement and retries. **1,600 is a cap, not a promise of completion.** Every actual baseline, mutant, timeout and unsuccessful attempt spends budget. Preserve exactly-one-test checks, 120-second timeout, at most two mutations per case, local environment isolation and existing finalization. Any unfinished row retains its honest incomplete outcome; there is no automatic increase.

The new UI identities are the expanded cases in `src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx`:

- `adopts a rejected timeline Apply and refreshes its Restore source: prepared here`
- `adopts a rejected timeline Apply and refreshes its Restore source: loaded after refresh`

Inventory the scoped safeguard tests before measurement. Append their identities after the original ordered inventory; do not replace old identities to fit a count. Retain the 15 historical kills, and remeasure any whose executed behavior is directly affected by the fixes. Preserve all unsuccessful attempts as evidence rather than relabeling them kills.

## Exact supporting surface

Six verifier support files, using the current D exception as the local precedent:

1. `.agents/skills/red-team/scripts/mutation-runner.mjs`
2. `.agents/skills/red-team/SKILL.md`
3. `.claude/skills/red-team/SKILL.md`
4. `scripts/ci/__tests__/red-team-mutation-runner.test.ts`
5. `.agents/skills/feature/scripts/red-team-status.mjs`
6. `scripts/ci/__tests__/red-team-status.test.ts`

Both named checker paths exist in the current repository; the sixth path was verified by file discovery. There is no `.claude/skills/feature/scripts/` mirror to add.

Additional supporting surface:

- `docs/runbooks/beta-launch-alerting.md`, limited to the matching Restore invariant rule in `/private/tmp/run-e-restore-alert-proposed.patch` (apply_patch format). That concrete patch has been read alongside the route emitter.
- `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**`, correcting the current canonical intake's nonmatching `docs/reviews/red-team/codex-owner-operator-run-e/**` entry. The typo correction and original report publication were deferred; neither licenses rewriting the original report bytes.

The existing E scope already covers the accepted product/test fixes. Change both intake copies consistently, preserving every other contract field and existing test promise. The surface amendment adds exactly the six support files and alert path and corrects exactly that report directory. The new test promises describe only the two named UI regressions and finite safeguards specified below. The owner grant should explicitly include this amendment; changing intake text alone never creates authority.

For runner admission, use an **exact finite path set**, not intake globs. Pin corrected code baseline `54cb1a05e82de192355e379b7eb7b76182189306`; the original measured head remains `890eea76c8c04b8d2acfcc73a895ec3112560e38`. The corrected code baseline does not contain the canonical original reports because publication was deferred for the intake-path typo. **Do not require a report blob to exist at that baseline.** After actual owner approval, commit the exact untouched original reports to the corrected report directory, verify their committed bytes against the frozen SHA-256 values above, and pin that history commit/blob pair separately. Then append admission authorization in a later commit. No historical `head_sha` or result changes accompany publication.

Subsequent changes from the corrected code baseline may touch only the six support files above, `docs/runbooks/beta-launch-alerting.md`, and these seven exact metadata paths:

- `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.json`
- `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.md`
- `docs/superpowers/plans/codex-owner-operator-run-e-intake.json`
- `docs/superpowers/plans/codex-owner-operator-run-e-plan.md`
- `docs/superpowers/plans/codex-owner-operator-run-e-deviations.md`
- `docs/reviews/codex-owner-operator-run-e/second-pass-authorization.md`
- `docs/reviews/codex-owner-operator-run-e/budget-extension-review.md`

Unknown paths fail closed. Existing product fixes must be in the pinned baseline, so the extension cannot smuggle later product changes through a broad E glob. A required additional code correction after admission invalidates the pin and requires root adjudication within the same second-round/cap contract; never silently move HEAD or reset spent launches.

## Admission and launch design

Implement an E-only counterpart to `authorizedRunDBudget`, with unique grant ID `owner-run-e-second-pass-1600`. It must require:

1. Exact branch, numeric round `2`, nonnegative integer launch counter, corrected-baseline ancestry and a clean committed tree. No untracked worktree artifacts; scratch stays ignored or under `/private/tmp`.
2. Immutable historical JSON/Markdown matching the hashes above and committed blob identities; exactly 2,113 original ordered identities matching the digest. Reject changed findings, reasons, outcomes, counts, status, provenance or reordered/replaced identities in admission history.
3. Admission JSON remains the original round-1 JSON with exactly one appended execution authorization: strict `{id,date,finding_ids,text}`, actual owner date, empty `finding_ids`, unique E grant ID, and exact question/response. Every other original evidence field is unchanged. Admission Markdown preserves every original byte as a prefix, including trailing newlines, then appends the exact grant.
4. Canonical intake differs only by the agreed surface correction/additions and exact finite new test promises; runtime `.feature/intake.json` matches its committed canonical copy. Intake, report or working-tree edits cannot grant a larger budget.
5. The first launch journals the committed HEAD, exact grant digest, 1,600 cap and `firstRun: 1` before releasing the paused child. Every later launch revalidates the same grant/HEAD and permits only matching journaled production mutations. Reject missing pins after a positive counter, staged/unjournaled drift, malformed counters and branch changes. No fallback to the ordinary 30-launch allowance when E admission is invalid.
6. Launch 1,600 is the last permitted launch; 1,601 is refused without executing a child. `round-start` and `run` reject E round 3 or higher unconditionally, based on either the E branch or its journaled grant ID. Evaluate that guard before the generic prose matcher, including when text says “no third round,” “third round authorized,” or any mixed wording. Other branches' budgets and existing exceptions remain unchanged.

## Report certification and preservation

The existing D precedent is insufficient for the complete requested hard-cap guarantee: `red-team-status.mjs:284–287` accepts round 3 whenever authorization text merely contains “third round,” including negation. Therefore the fifth/sixth support paths are necessary. Add a narrow E-only rejection before that generic branch, matching either the E report branch or E grant identity; test both positive and negated text. Do not redesign third-round policy for other branches.

For final E round-2 certification, corroborate the immutable committed admission and closed launch journal: same admission HEAD/grant digest/cap, valid nonnegative count at most 1,600, no open mutation/dotenv/supervisor state, original ordered identity prefix intact, and retained historical report bytes. Fresh results identify the measured corrected HEAD and append evidence. They may resolve historical outcomes only with recorded new measurements; original bytes remain recoverable from pinned historical/admission commits. Append new identities rather than renumbering originals. Preserve prior P1 findings and explicit root dispositions; no accepted-risk authorizations are introduced.

The final JSON's `authorizations: []` is intentional: completed execution authority is retained verbatim in the pinned admission JSON and Markdown history, as in final Run D formatting. The checker verifies that archived execution authority where needed; it must not require a fabricated finding ID or treat the grant as a risk waiver. The original JSON/Markdown hashes identify the original evidence; an admission file with the appended grant naturally has a different, separately pinned hash.

## Required threat checks

Use disposable repositories and public runner/checker interfaces. Record green individual baselines and semantic mutations for the scoped added tests; incidental source-text pins alone are not sufficient evidence.

| Threat | Required observable refusal or acceptance |
| --- | --- |
| Missing, uncommitted, duplicated, malformed, wrong-date or altered grant | No child executes; no budget fallback. |
| Wrong branch, ancestry, supporting path, product edit or intake field | Admission fails before the first launch. |
| Same-length identity replacement/reordering; changed historical result or reason; Markdown newline loss | Admission fails despite unchanged inventory length. |
| Staged/dirty/untracked worktree; HEAD/grant drift after launch 1 | No next child; prior counter/pin preserved. |
| Authorized journaled mutant versus unjournaled replacement | First is permitted and restored; second refuses without overwriting foreign content. |
| Counter `-1`, fractional, string, null; positive counter without a pin | Refusal; no reset or retroactive authorization. |
| Last permitted launch and first excess launch | 1,600 may execute; 1,601 does not. |
| Third/higher round opened or directly launched, including denial text | Runner refuses; checker also rejects forged E round-3 reports. |
| Final empty risk-waiver array with intact archived execution grant | Valid round-2 format accepted; missing/altered admission or journal proof rejected. |
| Ordinary branch or existing C/D exception | Existing budget and scope semantics unchanged. |

The root's alert patch must match all six operational facets: signal identity, filter, error level, grouping title, every-event cadence/throttle and destination action. The Restore route's exception signal must match the installed/read-back staging rule. Static rule verification and installed-rule readback do not substitute for delivery-drill evidence.

## Independent recommendation

**Recommend owner approval of this bounded proposal together with `/private/tmp/run-e-restore-alert-proposed.patch`.** This is design approval advice, not approval of an implementation or a claim that the owner has granted it. The two material design corrections are included above: checker-side rejection of forged third-round reports, and explicit inclusion of final history/risk-waiver formatting in the initial grant. The history publication sequence correctly distinguishes the measured head, corrected code baseline and future immutable report commit. The launch arithmetic is feasible but has limited retry headroom, so retain honest `INCOMPLETE_BUDGET` if the cap is reached.

The alert patch matches the actual endpoint tag and exception message and names cadence, grouping, environment and destination without claiming delivery. One wording precision for root: the helper passes `proposalId` to its structured error log, not to `captureException` context. The response procedure should say “proposal ID from the correlated structured error log” rather than imply that Sentry itself stores the ID. No emitter change is required.

Proposed owner question for the root to present with this file and the alert patch:

> May I make the Run E-only verifier and supporting changes described in `/private/tmp/run-e-next-pass-proposal.md`, including the attached Restore alert patch and corrected report directory, and run its second adversarial pass capped at 1,600 supervised local test launches? This covers the 707 unmeasured original cases, the two UI regression cases, directly affected fix coverage and finite verifier safeguards. It preserves original evidence and your exact grant in permanent history, leaves the final risk-waiver list empty, includes staging alert installation/readback, uses native Codex only, and grants no third round, provider calls, production Operator enablement or coverage waiver.

Record no owner response until one is actually received. The original E implementation/shipping authority remains distinct from this proposed exceptional verifier-budget grant.

## Implementation review and root triage

The exact actual approval is retained in `second-pass-authorization.md`; its owner response has no trailing period. The original reports were published unchanged in `76f7914636e3d20c4a676a5d7ef512e17dab25ce`, then the exact grant was appended for admission. Native Codex agents independently cross-reviewed the runner and checker they did not author; root reviewed both artifacts and accepted the following corrections.

| Finding | Root verdict and resulting safeguard | Validation |
|---|---|---|
| E-RUN1 | ACCEPT, fixed. An existing E execution pin prohibits round-start even if the journal round was changed backwards, preserving the spent counter and grant. | Public runner regression asserts refusal and exact unchanged journal after pinned round drift. |
| Initial baseline cleanliness | ACCEPT, fixed. Initial E admission requires a clean tracked tree. A journaled mutation is admissible only after the first baseline pins execution authority. | Public test distinguishes rejected initial mutation from accepted later matching mutation. |
| E-CHECK-1 | ACCEPT, fixed. The E pin or a recorded E second-round journal requires full round-2 certification even when the report falsely labels itself round 1. | RED reproduced the proof bypass; six downgrade variants now reject, while genuine ungranted first-round evidence remains accepted. |
| Positive count and narrative preservation | ACCEPT, fixed. Final certification requires at least one supervised launch and retains the complete admission Markdown prefix, including the exact grant. | Zero/malformed/excess count and rewritten/truncated history tests reject. |

Runner validation: **191 tests passed**, including 44 E cases and 147 existing cases. Six existing paused-supervisor probes failed under a restricted process-inspection sandbox; a direct `ps` probe confirmed the denial. The successful full rerun used process-inspection permission without weakening assertions or extending timeouts. Result capture: `/private/tmp/run-e-runner-full-suite-result.txt`; fixture and exact test inventory: `/private/tmp/run-e-runner-test-handoff.md`.

Checker validation after E-CHECK-1: **73 tests passed**, 25.31 seconds; `/private/tmp/run-e-checker-downgrade-green.log`. The previous proof-bypass reproduction is retained separately. Independent runner and checker reviews are `/private/tmp/run-e-runner-implementation-review.md` and `/private/tmp/run-e-checker-implementation-review.md`; their initial REVISE decisions and bounded follow-up verdicts remain visible. No accepted-risk finding or external provider call is introduced. These are ordinary guard-unit results, not claims that the second adversarial pass has already executed.

## Root-reviewed discovery corrections

The original static census followed some imports across mocked functions and unreachable branches. Root verified the exact source cuts, nine byte-identical test-file groups and the two remaining files' individual diffs. These 162 rows do not exercise E's changed behavior; this corrects discovery overinclusion rather than waiving coverage. Original report bytes and all original identities remain intact. Uncertain cases, changed tests, the repository-wide migration audit and the new refusal projection test remain mandatory.

The following finite manifest binds each approved ID to its exact source-based exclusion reason. Certification reads this document from the committed admission HEAD and verifies canonical JSON SHA-256 `ec9afe3a0eb73387201dc1783c8628f96f543355761cf15f5509d9155dfbaf0e`. A different ID, reason or manifest cannot convert an unmeasured case into an exclusion. The earlier blanket prohibition on skipped-budget-to-excluded is refined only for this exact reviewed set; every other such conversion still fails. No original exclusion is edited.

Two omitted parameterized settings cases are separately appended to the final inventory, never substituted for old identities. Including them and the two UI regressions, the provisional 711 product cases become 549 after these scope corrections. The 1,600-launch cap is unchanged; the final committed guard census and fixed-oracle recheck are additional obligations.

<!-- RUN_E_SCOPE_CORRECTIONS_START -->
```json
{
  "schema": 1,
  "sourceHead": "54cb1a05e82de192355e379b7eb7b76182189306",
  "groups": [
    {
      "id": "mocked-solicitation-unit",
      "reason": "Discovery correction (root ACCEPT): generateAsksForBatch/regenerateAsk → runLlmTask → Operator schema is cut by the file-wide runLlmTask replacement. The changed Operator schema members are not consulted by any listed case; actual importOriginal only preserves unrelated exports and constructs schemas at module load. Evidence: src/lib/solicitation/__tests__/ask-generation.test.ts:81 — vi.mock(@/lib/llm/run-task) returns runLlmTask:mocks.runLlmTask for the whole unchanged file; no unmock/delegating actual runLlmTask call exists.; src/lib/solicitation/ask-generation.ts:57 — The generating module imports and calls runLlmTask at its provider boundary; the graph’s only E runtime origins for these cases are Operator schema declarations.",
      "ids": [
        "src/lib/solicitation/__tests__/ask-generation.test.ts:285",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:311",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:330",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:399",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:419",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:436",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:449",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:463",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:500",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:510",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:518",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:546",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:569",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:590",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:614",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:633",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:642",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:650",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:659",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:671",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:692",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:727",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:748",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:777",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:797",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:821",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:981",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:995",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1009",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1020",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1069",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1096",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1116",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1127",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1142",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1169",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1403",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1445",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1461",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1479",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1522",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1549",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1568",
        "src/lib/solicitation/__tests__/ask-generation.test.ts:1585"
      ]
    },
    {
      "id": "mocked-solicitation-generation-db",
      "reason": "Discovery correction (root ACCEPT): The file-wide llmMocks.runLlmTask replacement cuts the only recorded path into changed Operator schemas. Real DB writes remain real but concern unchanged Solicitation lane behavior; schema-ready has only a comment diff. Evidence: src/lib/solicitation/__tests__/ask-generation.integration.test.ts:56 — The module factory spreads importOriginal then replaces runLlmTask with llmMocks.runLlmTask; none of the listed tests reinstates the actual function.; src/lib/solicitation/__tests__/ask-generation.integration.test.ts:90 — OPENAI_MODEL is imported as a fixed registry constant, not by executing the Operator schema.",
      "ids": [
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:680",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:759",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:843",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:933",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1106",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1137",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1153",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1181",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1266",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1430",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1533",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1561",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1590",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1615",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1634",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1692",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1738",
        "src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1759"
      ]
    },
    {
      "id": "mocked-solicitation-auto-approval-db",
      "reason": "Discovery correction (root ACCEPT): The generation-finale edge into changed Operator output schemas stops at llmMocks.runLlmTask. Live approval/outbox decisions use unchanged Solicitation code and are not E behavior. Evidence: src/lib/solicitation/__tests__/auto-approval.integration.test.ts:68 — File-wide run-task mock replaces runLlmTask with llmMocks.runLlmTask; cost audit’s separate delegating spy does not reinstate the LLM task implementation.",
      "ids": [
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:679",
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:816",
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:860",
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:908",
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:932",
        "src/lib/solicitation/__tests__/auto-approval.integration.test.ts:954"
      ]
    },
    {
      "id": "mocked-settings-route",
      "reason": "Discovery correction (root ACCEPT): Unchanged GET/PATCH routes → changed settings writer/read functions are replaced entirely by the test module factory. The public types/schema file has only a TypeScript interface addition, so it supplies no alternate changed runtime edge. Evidence: src/app/api/settings/auto-approval/__tests__/route.test.ts:32 — vi.mock(@/lib/auto-approval/settings) constructs local error classes and returns only mock getAutoApprovalSettings/patchAutoApprovalSettings functions; no importOriginal or actual settings implementation is used.",
      "ids": [
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:129",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:141",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:163",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:173",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:181",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:191",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:204",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:226",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:243",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:261",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:268",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:278",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:1",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:2",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:3",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:4",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:5",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:6",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:7",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:288:8",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:307:1",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:307:2",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:307:3",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:307:4",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:307:5",
        "src/app/api/settings/auto-approval/__tests__/route.test.ts:323"
      ]
    },
    {
      "id": "mocked-apply-route",
      "reason": "Discovery correction (root ACCEPT): Unchanged Apply route → changed applyProposal implementation is replaced with mockApply for the whole file. No other changed runtime production path is exercised by these route-orchestration cases. Evidence: src/app/api/operator/__tests__/apply-route.test.ts:36 — The apply module mock returns applyProposal:(...a)=>mockApply(...a). Both route and test file are unchanged across E.",
      "ids": [
        "src/app/api/operator/__tests__/apply-route.test.ts:77",
        "src/app/api/operator/__tests__/apply-route.test.ts:89",
        "src/app/api/operator/__tests__/apply-route.test.ts:111",
        "src/app/api/operator/__tests__/apply-route.test.ts:126",
        "src/app/api/operator/__tests__/apply-route.test.ts:203"
      ]
    },
    {
      "id": "mocked-decline-route",
      "reason": "Discovery correction (root ACCEPT): Unchanged Decline route → proposals module is replaced with mockDecline. The discovery graph incorrectly followed the mocked proposals import into E Restore changes. Evidence: src/app/api/operator/__tests__/decline-route.test.ts:32 — The proposals module mock returns declineProposal:(...a)=>mockDecline(...a); the route and test file are unchanged.",
      "ids": [
        "src/app/api/operator/__tests__/decline-route.test.ts:62",
        "src/app/api/operator/__tests__/decline-route.test.ts:87"
      ]
    },
    {
      "id": "mocked-unchanged-conversation-cases",
      "reason": "Discovery correction (root ACCEPT): The four unchanged route cases use a whole-module mock for getConversationForOwner/readSummaryEntitlement, cutting the changed reads.ts edge. The newly added refusal-projection case at line33 is explicitly retained under DirectionA. Evidence: src/app/api/operator/__tests__/conversation-route.test.ts:20 — Both reads exports are replaced by mocks.; src/app/api/operator/__tests__/conversation-route.test.ts:33 — The new refusal-projection test remains measurable and is NOT included in this correction group.",
      "ids": [
        "src/app/api/operator/__tests__/conversation-route.test.ts:73",
        "src/app/api/operator/__tests__/conversation-route.test.ts:145",
        "src/app/api/operator/__tests__/conversation-route.test.ts:199",
        "src/app/api/operator/__tests__/conversation-route.test.ts:229"
      ]
    },
    {
      "id": "audit-fixed-path-inputs",
      "reason": "Discovery correction (root ACCEPT): E only adds migration121’s exact path to MIGRATION_SHAPE_FILES. Every listed case supplies a fixed different path, or no-DDL text that returns before the membership check. The different paths therefore have identical set membership before/after E. The real repository walk is retained because it reaches migration121. Evidence: scripts/ci/live-db-suites-audit.ts:135 — Sole E runtime change adds src/lib/shared/__tests__/migration-121-operator-refusals.integration.test.ts to the allowlist.; scripts/ci/live-db-suites-audit.ts:484 — No DDL returns before the membership check at488.; scripts/ci/__tests__/live-db-suites-audit.test.ts:31 — HELPER_PATH and APPLY_074 are fixed non121 paths; the local file variable at80 is fixed migration074. All other audited fixture paths are literal x/y/076/088/outreach-render/helper paths.; scripts/ci/__tests__/live-db-suites-audit.test.ts:425 — The repository-wide listAuditedFiles/readFile/audit case is retained, not excluded.",
      "ids": [
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:34",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:38",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:42",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:47",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:55",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:63",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:71",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:79",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:89",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:95",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:103",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:111",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:121",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:135",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:143",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:149",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:157",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:171",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:181",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:195",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:208",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:215",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:228",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:243",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:251",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:273:1",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:273:2",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:273:3",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:273:4",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:278:1",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:278:2",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:278:3",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:278:4",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:286",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:320",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:333",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:346",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:364",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:372",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:384",
        "scripts/ci/__tests__/live-db-suites-audit.test.ts:389"
      ]
    },
    {
      "id": "foreign-task-registry-metadata",
      "reason": "Discovery correction (root ACCEPT): Each listed case indexes getLlmTask with a fixed non-Operator task ID and checks its unchanged model/limits/schema pointer. Registry lookup returns only that entry. Changed Operator schema properties cannot affect these unrelated entries. Evidence: src/lib/llm/tasks.ts:72 — getLlmTask returns LLM_TASKS[taskId] without inspecting any other task schema.; src/lib/responses/__tests__/model-pinning.test.ts:24 — Listed fixed keys are reply_generation, insights, triage, judge and solicitation_ask; owner_operator case73 is conservatively retained.",
      "ids": [
        "src/lib/responses/__tests__/model-pinning.test.ts:24",
        "src/lib/responses/__tests__/model-pinning.test.ts:30",
        "src/lib/responses/__tests__/model-pinning.test.ts:43",
        "src/lib/responses/__tests__/model-pinning.test.ts:51",
        "src/lib/responses/__tests__/model-pinning.test.ts:62"
      ]
    },
    {
      "id": "restraint-loading-error-cut",
      "reason": "Discovery correction (root ACCEPT): Each listed case either leaves fetch pending or returns HTTP500. Pending cases render the state panel without parsing a body; error cases throw at response.ok before isRestraintPayload. None renders changed RestraintReport or consults the new refusal category. Evidence: src/components/dashboard/restraint/RestraintContent.tsx:52 — A loading/error panel returns at66 before rendering RestraintReport.; src/components/dashboard/restraint/RestraintContent.tsx:95 — Error JSON is parsed at95; HTTP failure throws at96 before payload/category validation at97.; src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:160 — Never-settling fetch; lines257/294 use pendingFetch. Lines266/277/303/490 supply false response.ok and status500.",
      "ids": [
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:160",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:257",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:266",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:277",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:294",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:303",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:490"
      ]
    },
    {
      "id": "namespace-precedence-false-edge",
      "reason": "Discovery correction (root ACCEPT): The discovery graph treated namespace import vocabulary.* as every changed export. These four cases read only POLICY_GATE_HELD_REFUSAL_CATEGORIES, AUTO_APPROVAL_BLOCK_PRECEDENCE and resolvePolicyGateRefusal, all runtime-unchanged and independent of REFUSAL_CATEGORIES presentation order. Evidence: worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:46 — The three namespace accessor helpers at46/54/62 select only the unchanged policy map/precedence/resolver.; src/lib/refusals/vocabulary.ts:709 — resolvePolicyGateRefusal uses the explicit policy map and precedence; it never consults the presentation REFUSAL_CATEGORIES list E extends.",
      "ids": [
        "worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:103",
        "worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:126",
        "worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:156",
        "worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:177"
      ]
    }
  ]
}
```
<!-- RUN_E_SCOPE_CORRECTIONS_END -->

Independent native Codex source audit approved exactly these 162 IDs across 11 groups, with zero unproven or additional IDs. Root incorporated every documentary reference correction before pinning this manifest. The audit is retained at `/private/tmp/run-e-scope-corrections-review.md`; its exact accepted-ID list is `/private/tmp/run-e-scope-corrections-accepted-ids.json`.

The final checker scope-support suite passed **73/73** in 28.69 seconds (`/private/tmp/run-e-checker-scope-tests.log`). It exercises exact approved corrections, unapproved IDs/reasons, measured-row waiver attempts, missing or altered committed proof, duplicate/reversed markers and the earlier admission threats. The final manifest digest-only synchronization is covered by the subsequent complete gate. Both independent implementation reviews approve the corrected safeguards. The checker corroborates admission, history, identities and a closed capped journal; the reporter remains responsible for individual baseline and mutation evidence.
