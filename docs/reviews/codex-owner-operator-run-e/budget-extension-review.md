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

## Root-adjudicated continuation of the same second pass

The owner-approved proposal above explicitly allows a required post-admission correction through root adjudication within the same second round and cap. Root applied that clause to the completed source census and the finite verifier correction described in E-S3. Product code and tests outside the six named verifier support files remain unchanged. The source census accounts for every remaining identity; excluded old behavior is not claimed as measured coverage. The complete regression gate still runs those tests.

Original admission: `b6ee3973b3e0ad9f6749f02c5428e6b4980cf837`. Root ran the frozen controller finalizer before these edits: 124 launches, 62 restored mutation records, 124 inactive supervisors, closed dotenv state and a clean worktree. The original controller SHA-256 is `168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae`. Its source and original admission remain recoverable from that commit.

The exact raw checkpoint SHA-256 is `83399abc3e6937b9eb251e3b6a30490f511853d82958a472fed3d3036e797285`; the compact `JSON.stringify` digest used by the guard is `1fd1ce99a5a70d8ba0feacb6ca0b30a2f0623207295f32e184258a104122df72`. The entire checkpoint below is permanent evidence. The original budgetAuthorization stays unchanged. The successor must preserve these mutation/supervisor arrays as exact prefixes, including their restored/closed state, and record its single continuation pin before launch 125.

<!-- RUN_E_CHECKPOINT_124_START -->
```json
{
  "version": 1,
  "round": 2,
  "runs": 124,
  "mutations": [
    {
      "path": "src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx",
      "originalOid": "1802746343492a573dc5933adf2934614ba75fcf",
      "patchSha256": "81e4232fa6b7dae6d602c6301a5b5f8b4a8492bc651b36fb60b790c57e5a0559",
      "mutantOid": "c2f4536bc861be983b1f6e0afe05785305028b73",
      "state": "restored",
      "at": "2026-09-15T03:02:05.166Z"
    },
    {
      "path": "src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx",
      "originalOid": "1802746343492a573dc5933adf2934614ba75fcf",
      "patchSha256": "81e4232fa6b7dae6d602c6301a5b5f8b4a8492bc651b36fb60b790c57e5a0559",
      "mutantOid": "c2f4536bc861be983b1f6e0afe05785305028b73",
      "state": "restored",
      "at": "2026-09-15T03:02:08.764Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "b02361022725e6352efb9f73392355c949e5641784110396be4755726f1836bf",
      "mutantOid": "31a975ca73a83509eb90b99b3bad662e2d5b0958",
      "state": "restored",
      "at": "2026-09-15T03:02:11.700Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "048e92e6a817f3a1adeefc37d02a15ac048c7428b2ac6693b023789b7f2e5550",
      "mutantOid": "c82eb0be2ef1209e680c0826d9142b709427231a",
      "state": "restored",
      "at": "2026-09-15T03:04:11.709Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "9e583553b9ef68f52ed39894a6453aaaedf7da7b9ee3f481ba8f18f2513b752b",
      "mutantOid": "0f3de8f78a9aa105f22f59d9d51c30a6bc85f2dd",
      "state": "restored",
      "at": "2026-09-15T03:04:14.150Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "a8a6447d1ca4d374441e314d979b0322ef0414dc30031e8d0ca659ef5f577bf6",
      "mutantOid": "b2a43a1fa275c194df7b2de342cce623849aca7f",
      "state": "restored",
      "at": "2026-09-15T03:04:16.511Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "a8a6447d1ca4d374441e314d979b0322ef0414dc30031e8d0ca659ef5f577bf6",
      "mutantOid": "b2a43a1fa275c194df7b2de342cce623849aca7f",
      "state": "restored",
      "at": "2026-09-15T03:04:18.768Z"
    },
    {
      "path": "src/lib/agents/operator/restore.ts",
      "originalOid": "9149b3a9ef2f9018422dcd177973a60eb3da1122",
      "patchSha256": "1df1831e6dff5b6956921d2c46fb0b85fcd7496630335c4bea56ad1cd8e2880b",
      "mutantOid": "7828fa7315fb3f8a423190b846bf4de9455fa674",
      "state": "restored",
      "at": "2026-09-15T03:04:21.117Z"
    },
    {
      "path": "src/lib/agents/operator/restore.ts",
      "originalOid": "9149b3a9ef2f9018422dcd177973a60eb3da1122",
      "patchSha256": "41c36a9a6175732c740b771cd4ebffb0da79d95692c363259984c63f2cb39702",
      "mutantOid": "954d8a5d010099d2a197b298e5365f7ae2e6dfbd",
      "state": "restored",
      "at": "2026-09-15T03:04:23.502Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "c6c4a6cde67f6aeafccf741edac706f7fb002730e2153aeaa84ff605380755c6",
      "mutantOid": "bfa4a08d569ebe7e99bb01e0fcc938d6a0add515",
      "state": "restored",
      "at": "2026-09-15T03:04:25.357Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "c6c4a6cde67f6aeafccf741edac706f7fb002730e2153aeaa84ff605380755c6",
      "mutantOid": "bfa4a08d569ebe7e99bb01e0fcc938d6a0add515",
      "state": "restored",
      "at": "2026-09-15T03:04:26.817Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "54b468f3034e508e612fe6f44794fd3a0846df669faaea91ca216d1c41e82d6e",
      "mutantOid": "48d7eb78f15f27d65c9a7f6a9e6c52f3c5a8042c",
      "state": "restored",
      "at": "2026-09-15T03:04:28.409Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "54b468f3034e508e612fe6f44794fd3a0846df669faaea91ca216d1c41e82d6e",
      "mutantOid": "48d7eb78f15f27d65c9a7f6a9e6c52f3c5a8042c",
      "state": "restored",
      "at": "2026-09-15T03:04:29.913Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "9e583553b9ef68f52ed39894a6453aaaedf7da7b9ee3f481ba8f18f2513b752b",
      "mutantOid": "0f3de8f78a9aa105f22f59d9d51c30a6bc85f2dd",
      "state": "restored",
      "at": "2026-09-15T03:04:31.401Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "10adffe1c070dd35945a2c57154985a488dfa4eaed74b14311ca3a5189e11ed3",
      "mutantOid": "858d03810ecf299b1d638d836a64d2e521b3a28b",
      "state": "restored",
      "at": "2026-09-15T03:06:03.003Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "10adffe1c070dd35945a2c57154985a488dfa4eaed74b14311ca3a5189e11ed3",
      "mutantOid": "858d03810ecf299b1d638d836a64d2e521b3a28b",
      "state": "restored",
      "at": "2026-09-15T03:06:04.551Z"
    },
    {
      "path": "src/lib/agents/operator/restore-inputs.ts",
      "originalOid": "3b3256ff9f1bfeb630d85b413fe9c8855e9c0386",
      "patchSha256": "10adffe1c070dd35945a2c57154985a488dfa4eaed74b14311ca3a5189e11ed3",
      "mutantOid": "858d03810ecf299b1d638d836a64d2e521b3a28b",
      "state": "restored",
      "at": "2026-09-15T03:06:06.090Z"
    },
    {
      "path": "src/lib/agents/operator/turns.ts",
      "originalOid": "c20fe5b9f23dde40198d74fb3e1714b745ea9678",
      "patchSha256": "7f02fd64929920a081ff72b50594eadd40ff9acd004b9b848731eb62f40ca622",
      "mutantOid": "71f4ecafbcf58b917821482b4280657154222f77",
      "state": "restored",
      "at": "2026-09-15T03:08:12.010Z"
    },
    {
      "path": "src/lib/agents/operator/refusal-completion.ts",
      "originalOid": "3e1ee41872ab2c072a3195ba2672d68129f1fd25",
      "patchSha256": "c6c4a6cde67f6aeafccf741edac706f7fb002730e2153aeaa84ff605380755c6",
      "mutantOid": "bfa4a08d569ebe7e99bb01e0fcc938d6a0add515",
      "state": "restored",
      "at": "2026-09-15T03:08:14.584Z"
    },
    {
      "path": "src/lib/agents/operator/refusals.ts",
      "originalOid": "407e0d6267c1d9ff33f9d76d55f70e4c9e9c9eba",
      "patchSha256": "cd4dcc998e8b823e420820bae79117a8b4cc534d78db45540858b663a2ef22ba",
      "mutantOid": "de7e15aeccfc9989c5b6b117ab8adb5f7361e967",
      "state": "restored",
      "at": "2026-09-15T03:10:56.677Z"
    },
    {
      "path": "src/lib/agents/operator/turns.ts",
      "originalOid": "c20fe5b9f23dde40198d74fb3e1714b745ea9678",
      "patchSha256": "7f9b36a9f205b2671050cbb5705ae4917e4696fbf0f41c1f7699bbeb54c59737",
      "mutantOid": "07a27c6f51a2d888bc1ea97d29ab3986c824ef72",
      "state": "restored",
      "at": "2026-09-15T03:10:59.717Z"
    },
    {
      "path": "src/lib/agents/operator/turns.ts",
      "originalOid": "c20fe5b9f23dde40198d74fb3e1714b745ea9678",
      "patchSha256": "0f6290f09d3bd645293fad13690da30673bd9b219f34db2cbdc6b93a9db31576",
      "mutantOid": "5af0e419721aa1ed6a76e375689dc4c24b5acb64",
      "state": "restored",
      "at": "2026-09-15T03:11:02.746Z"
    },
    {
      "path": "src/lib/agents/operator/turns.ts",
      "originalOid": "c20fe5b9f23dde40198d74fb3e1714b745ea9678",
      "patchSha256": "8a26da92748d5238b0301717070b4ba09d3411d0ff1db51e3aba572028a4f688",
      "mutantOid": "409284a88819950df2f6d320dc08b6f13b5326ef",
      "state": "restored",
      "at": "2026-09-15T03:12:06.987Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "312496077812bebf1bbcdb59e300a13f1474a94758ef052d13d3e6068a0ca1b0",
      "mutantOid": "cf21855e8dedabb74c0f58ac1747ef6e9368b18f",
      "state": "restored",
      "at": "2026-09-15T03:12:09.899Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:12.341Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:14.677Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:16.957Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:19.402Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:21.915Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:24.516Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:27.014Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:29.531Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:32.010Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:34.547Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:37.116Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:39.691Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:42.427Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:45.499Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:48.077Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:50.640Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:53.206Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:55.778Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:12:58.362Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:00.972Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:03.577Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:06.309Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:08.984Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:11.588Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:14.164Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:16.605Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:18.940Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:21.227Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:23.526Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:26.204Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:29.196Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:31.890Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:34.746Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:37.934Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:41.116Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:44.988Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "312496077812bebf1bbcdb59e300a13f1474a94758ef052d13d3e6068a0ca1b0",
      "mutantOid": "cf21855e8dedabb74c0f58ac1747ef6e9368b18f",
      "state": "restored",
      "at": "2026-09-15T03:13:48.211Z"
    },
    {
      "path": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "originalOid": "afed2b35feda8d365ca5e6ebd1e6f955de8a1402",
      "patchSha256": "d76ca2c000410908c64cdbc109a1cd47d8878aae0c5e7380b635b122be656800",
      "mutantOid": "782e725b6be875c3ad4a353df9e7e0c310a8817d",
      "state": "restored",
      "at": "2026-09-15T03:13:51.404Z"
    }
  ],
  "dotenv": {
    "open": false,
    "files": []
  },
  "supervisors": [
    {
      "pid": 10667,
      "pgid": 10667,
      "startedAt": "Mon Sep 14 20:02:03 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:03.602Z"
    },
    {
      "pid": 11331,
      "pgid": 11331,
      "startedAt": "Mon Sep 14 20:02:05 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:05.466Z"
    },
    {
      "pid": 11573,
      "pgid": 11573,
      "startedAt": "Mon Sep 14 20:02:07 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:07.766Z"
    },
    {
      "pid": 11718,
      "pgid": 11718,
      "startedAt": "Mon Sep 14 20:02:09 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:09.011Z"
    },
    {
      "pid": 11850,
      "pgid": 11850,
      "startedAt": "Mon Sep 14 20:02:11 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:11.242Z"
    },
    {
      "pid": 11930,
      "pgid": 11930,
      "startedAt": "Mon Sep 14 20:02:11 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:02:11.949Z"
    },
    {
      "pid": 19228,
      "pgid": 19228,
      "startedAt": "Mon Sep 14 20:04:10 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:10.348Z"
    },
    {
      "pid": 19336,
      "pgid": 19336,
      "startedAt": "Mon Sep 14 20:04:11 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:11.957Z"
    },
    {
      "pid": 19440,
      "pgid": 19440,
      "startedAt": "Mon Sep 14 20:04:13 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:13.087Z"
    },
    {
      "pid": 19590,
      "pgid": 19590,
      "startedAt": "Mon Sep 14 20:04:14 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:14.444Z"
    },
    {
      "pid": 19677,
      "pgid": 19677,
      "startedAt": "Mon Sep 14 20:04:15 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:15.627Z"
    },
    {
      "pid": 19778,
      "pgid": 19778,
      "startedAt": "Mon Sep 14 20:04:16 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:16.761Z"
    },
    {
      "pid": 19925,
      "pgid": 19925,
      "startedAt": "Mon Sep 14 20:04:17 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:17.896Z"
    },
    {
      "pid": 20329,
      "pgid": 20329,
      "startedAt": "Mon Sep 14 20:04:19 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:19.040Z"
    },
    {
      "pid": 20683,
      "pgid": 20683,
      "startedAt": "Mon Sep 14 20:04:20 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:20.239Z"
    },
    {
      "pid": 20765,
      "pgid": 20765,
      "startedAt": "Mon Sep 14 20:04:21 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:21.369Z"
    },
    {
      "pid": 20915,
      "pgid": 20915,
      "startedAt": "Mon Sep 14 20:04:22 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:22.558Z"
    },
    {
      "pid": 20996,
      "pgid": 20996,
      "startedAt": "Mon Sep 14 20:04:23 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:23.763Z"
    },
    {
      "pid": 21100,
      "pgid": 21100,
      "startedAt": "Mon Sep 14 20:04:24 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:24.898Z"
    },
    {
      "pid": 21201,
      "pgid": 21201,
      "startedAt": "Mon Sep 14 20:04:25 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:25.607Z"
    },
    {
      "pid": 21291,
      "pgid": 21291,
      "startedAt": "Mon Sep 14 20:04:26 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:26.358Z"
    },
    {
      "pid": 21394,
      "pgid": 21394,
      "startedAt": "Mon Sep 14 20:04:27 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:27.071Z"
    },
    {
      "pid": 21549,
      "pgid": 21549,
      "startedAt": "Mon Sep 14 20:04:27 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:27.852Z"
    },
    {
      "pid": 22138,
      "pgid": 22138,
      "startedAt": "Mon Sep 14 20:04:28 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:28.699Z"
    },
    {
      "pid": 22243,
      "pgid": 22243,
      "startedAt": "Mon Sep 14 20:04:29 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:29.449Z"
    },
    {
      "pid": 22323,
      "pgid": 22323,
      "startedAt": "Mon Sep 14 20:04:30 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:30.164Z"
    },
    {
      "pid": 22411,
      "pgid": 22411,
      "startedAt": "Mon Sep 14 20:04:30 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:30.899Z"
    },
    {
      "pid": 22525,
      "pgid": 22525,
      "startedAt": "Mon Sep 14 20:04:31 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:04:31.643Z"
    },
    {
      "pid": 28812,
      "pgid": 28812,
      "startedAt": "Mon Sep 14 20:06:02 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:02.373Z"
    },
    {
      "pid": 28914,
      "pgid": 28914,
      "startedAt": "Mon Sep 14 20:06:03 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:03.259Z"
    },
    {
      "pid": 28997,
      "pgid": 28997,
      "startedAt": "Mon Sep 14 20:06:04 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:04.051Z"
    },
    {
      "pid": 29077,
      "pgid": 29077,
      "startedAt": "Mon Sep 14 20:06:04 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:04.798Z"
    },
    {
      "pid": 29181,
      "pgid": 29181,
      "startedAt": "Mon Sep 14 20:06:05 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:05.584Z"
    },
    {
      "pid": 29263,
      "pgid": 29263,
      "startedAt": "Mon Sep 14 20:06:06 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:06:06.335Z"
    },
    {
      "pid": 43674,
      "pgid": 43674,
      "startedAt": "Mon Sep 14 20:08:10 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:08:10.358Z"
    },
    {
      "pid": 43779,
      "pgid": 43779,
      "startedAt": "Mon Sep 14 20:08:12 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:08:12.253Z"
    },
    {
      "pid": 43925,
      "pgid": 43925,
      "startedAt": "Mon Sep 14 20:08:13 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:08:13.615Z"
    },
    {
      "pid": 44028,
      "pgid": 44028,
      "startedAt": "Mon Sep 14 20:08:14 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:08:14.828Z"
    },
    {
      "pid": 68166,
      "pgid": 68166,
      "startedAt": "Mon Sep 14 20:10:55 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:10:55.105Z"
    },
    {
      "pid": 68279,
      "pgid": 68279,
      "startedAt": "Mon Sep 14 20:10:56 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:10:56.966Z"
    },
    {
      "pid": 68385,
      "pgid": 68385,
      "startedAt": "Mon Sep 14 20:10:58 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:10:58.495Z"
    },
    {
      "pid": 68495,
      "pgid": 68495,
      "startedAt": "Mon Sep 14 20:10:59 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:11:00.001Z"
    },
    {
      "pid": 68646,
      "pgid": 68646,
      "startedAt": "Mon Sep 14 20:11:01 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:11:01.522Z"
    },
    {
      "pid": 68759,
      "pgid": 68759,
      "startedAt": "Mon Sep 14 20:11:03 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:11:03.045Z"
    },
    {
      "pid": 76898,
      "pgid": 76898,
      "startedAt": "Mon Sep 14 20:12:05 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:05.256Z"
    },
    {
      "pid": 77054,
      "pgid": 77054,
      "startedAt": "Mon Sep 14 20:12:07 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:07.270Z"
    },
    {
      "pid": 77157,
      "pgid": 77157,
      "startedAt": "Mon Sep 14 20:12:08 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:08.703Z"
    },
    {
      "pid": 77462,
      "pgid": 77462,
      "startedAt": "Mon Sep 14 20:12:10 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:10.234Z"
    },
    {
      "pid": 77654,
      "pgid": 77654,
      "startedAt": "Mon Sep 14 20:12:11 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:11.495Z"
    },
    {
      "pid": 77849,
      "pgid": 77849,
      "startedAt": "Mon Sep 14 20:12:12 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:12.627Z"
    },
    {
      "pid": 78075,
      "pgid": 78075,
      "startedAt": "Mon Sep 14 20:12:13 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:13.942Z"
    },
    {
      "pid": 78317,
      "pgid": 78317,
      "startedAt": "Mon Sep 14 20:12:14 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:14.960Z"
    },
    {
      "pid": 78505,
      "pgid": 78505,
      "startedAt": "Mon Sep 14 20:12:16 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:16.080Z"
    },
    {
      "pid": 78672,
      "pgid": 78672,
      "startedAt": "Mon Sep 14 20:12:17 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:17.231Z"
    },
    {
      "pid": 78898,
      "pgid": 78898,
      "startedAt": "Mon Sep 14 20:12:18 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:18.506Z"
    },
    {
      "pid": 79129,
      "pgid": 79129,
      "startedAt": "Mon Sep 14 20:12:19 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:19.687Z"
    },
    {
      "pid": 79346,
      "pgid": 79346,
      "startedAt": "Mon Sep 14 20:12:21 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:21.006Z"
    },
    {
      "pid": 79819,
      "pgid": 79819,
      "startedAt": "Mon Sep 14 20:12:22 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:22.280Z"
    },
    {
      "pid": 80177,
      "pgid": 80177,
      "startedAt": "Mon Sep 14 20:12:23 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:23.580Z"
    },
    {
      "pid": 80788,
      "pgid": 80788,
      "startedAt": "Mon Sep 14 20:12:24 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:24.803Z"
    },
    {
      "pid": 81005,
      "pgid": 81005,
      "startedAt": "Mon Sep 14 20:12:26 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:26.111Z"
    },
    {
      "pid": 81201,
      "pgid": 81201,
      "startedAt": "Mon Sep 14 20:12:27 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:27.304Z"
    },
    {
      "pid": 81420,
      "pgid": 81420,
      "startedAt": "Mon Sep 14 20:12:28 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:28.624Z"
    },
    {
      "pid": 81587,
      "pgid": 81587,
      "startedAt": "Mon Sep 14 20:12:29 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:29.818Z"
    },
    {
      "pid": 81811,
      "pgid": 81811,
      "startedAt": "Mon Sep 14 20:12:31 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:31.122Z"
    },
    {
      "pid": 81999,
      "pgid": 81999,
      "startedAt": "Mon Sep 14 20:12:32 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:32.296Z"
    },
    {
      "pid": 82225,
      "pgid": 82225,
      "startedAt": "Mon Sep 14 20:12:33 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:33.617Z"
    },
    {
      "pid": 82456,
      "pgid": 82456,
      "startedAt": "Mon Sep 14 20:12:34 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:34.833Z"
    },
    {
      "pid": 82655,
      "pgid": 82655,
      "startedAt": "Mon Sep 14 20:12:36 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:36.146Z"
    },
    {
      "pid": 83353,
      "pgid": 83353,
      "startedAt": "Mon Sep 14 20:12:37 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:37.399Z"
    },
    {
      "pid": 83648,
      "pgid": 83648,
      "startedAt": "Mon Sep 14 20:12:38 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:38.740Z"
    },
    {
      "pid": 83858,
      "pgid": 83858,
      "startedAt": "Mon Sep 14 20:12:39 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:39.969Z"
    },
    {
      "pid": 84189,
      "pgid": 84189,
      "startedAt": "Mon Sep 14 20:12:41 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:41.476Z"
    },
    {
      "pid": 84493,
      "pgid": 84493,
      "startedAt": "Mon Sep 14 20:12:42 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:42.916Z"
    },
    {
      "pid": 84776,
      "pgid": 84776,
      "startedAt": "Mon Sep 14 20:12:44 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:44.572Z"
    },
    {
      "pid": 84971,
      "pgid": 84971,
      "startedAt": "Mon Sep 14 20:12:45 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:45.796Z"
    },
    {
      "pid": 85199,
      "pgid": 85199,
      "startedAt": "Mon Sep 14 20:12:47 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:47.138Z"
    },
    {
      "pid": 85390,
      "pgid": 85390,
      "startedAt": "Mon Sep 14 20:12:48 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:48.368Z"
    },
    {
      "pid": 85664,
      "pgid": 85664,
      "startedAt": "Mon Sep 14 20:12:49 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:49.703Z"
    },
    {
      "pid": 85834,
      "pgid": 85834,
      "startedAt": "Mon Sep 14 20:12:50 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:50.930Z"
    },
    {
      "pid": 86378,
      "pgid": 86378,
      "startedAt": "Mon Sep 14 20:12:52 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:52.274Z"
    },
    {
      "pid": 86881,
      "pgid": 86881,
      "startedAt": "Mon Sep 14 20:12:53 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:53.498Z"
    },
    {
      "pid": 87148,
      "pgid": 87148,
      "startedAt": "Mon Sep 14 20:12:54 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:54.838Z"
    },
    {
      "pid": 87343,
      "pgid": 87343,
      "startedAt": "Mon Sep 14 20:12:56 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:56.076Z"
    },
    {
      "pid": 88078,
      "pgid": 88078,
      "startedAt": "Mon Sep 14 20:12:57 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:57.408Z"
    },
    {
      "pid": 88280,
      "pgid": 88280,
      "startedAt": "Mon Sep 14 20:12:58 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:12:58.657Z"
    },
    {
      "pid": 88485,
      "pgid": 88485,
      "startedAt": "Mon Sep 14 20:13:00 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:00.019Z"
    },
    {
      "pid": 88686,
      "pgid": 88686,
      "startedAt": "Mon Sep 14 20:13:01 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:01.261Z"
    },
    {
      "pid": 88909,
      "pgid": 88909,
      "startedAt": "Mon Sep 14 20:13:02 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:02.623Z"
    },
    {
      "pid": 89103,
      "pgid": 89103,
      "startedAt": "Mon Sep 14 20:13:03 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:03.864Z"
    },
    {
      "pid": 89336,
      "pgid": 89336,
      "startedAt": "Mon Sep 14 20:13:05 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:05.237Z"
    },
    {
      "pid": 89536,
      "pgid": 89536,
      "startedAt": "Mon Sep 14 20:13:06 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:06.628Z"
    },
    {
      "pid": 89777,
      "pgid": 89777,
      "startedAt": "Mon Sep 14 20:13:08 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:08.026Z"
    },
    {
      "pid": 89977,
      "pgid": 89977,
      "startedAt": "Mon Sep 14 20:13:09 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:09.277Z"
    },
    {
      "pid": 90210,
      "pgid": 90210,
      "startedAt": "Mon Sep 14 20:13:10 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:10.653Z"
    },
    {
      "pid": 90483,
      "pgid": 90483,
      "startedAt": "Mon Sep 14 20:13:11 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:11.875Z"
    },
    {
      "pid": 91839,
      "pgid": 91839,
      "startedAt": "Mon Sep 14 20:13:13 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:13.288Z"
    },
    {
      "pid": 92508,
      "pgid": 92508,
      "startedAt": "Mon Sep 14 20:13:14 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:14.463Z"
    },
    {
      "pid": 92715,
      "pgid": 92715,
      "startedAt": "Mon Sep 14 20:13:15 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:15.728Z"
    },
    {
      "pid": 92900,
      "pgid": 92900,
      "startedAt": "Mon Sep 14 20:13:16 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:16.899Z"
    },
    {
      "pid": 93107,
      "pgid": 93107,
      "startedAt": "Mon Sep 14 20:13:18 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:18.170Z"
    },
    {
      "pid": 93251,
      "pgid": 93251,
      "startedAt": "Mon Sep 14 20:13:19 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:19.234Z"
    },
    {
      "pid": 93572,
      "pgid": 93572,
      "startedAt": "Mon Sep 14 20:13:20 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:20.433Z"
    },
    {
      "pid": 94131,
      "pgid": 94131,
      "startedAt": "Mon Sep 14 20:13:21 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:21.516Z"
    },
    {
      "pid": 94327,
      "pgid": 94327,
      "startedAt": "Mon Sep 14 20:13:22 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:22.721Z"
    },
    {
      "pid": 94468,
      "pgid": 94468,
      "startedAt": "Mon Sep 14 20:13:23 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:23.817Z"
    },
    {
      "pid": 94728,
      "pgid": 94728,
      "startedAt": "Mon Sep 14 20:13:25 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:25.024Z"
    },
    {
      "pid": 95205,
      "pgid": 95205,
      "startedAt": "Mon Sep 14 20:13:26 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:26.491Z"
    },
    {
      "pid": 95759,
      "pgid": 95759,
      "startedAt": "Mon Sep 14 20:13:28 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:28.085Z"
    },
    {
      "pid": 96361,
      "pgid": 96361,
      "startedAt": "Mon Sep 14 20:13:29 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:29.481Z"
    },
    {
      "pid": 96758,
      "pgid": 96758,
      "startedAt": "Mon Sep 14 20:13:30 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:30.904Z"
    },
    {
      "pid": 96985,
      "pgid": 96985,
      "startedAt": "Mon Sep 14 20:13:32 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:32.176Z"
    },
    {
      "pid": 97229,
      "pgid": 97229,
      "startedAt": "Mon Sep 14 20:13:33 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:33.569Z"
    },
    {
      "pid": 97492,
      "pgid": 97492,
      "startedAt": "Mon Sep 14 20:13:35 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:35.037Z"
    },
    {
      "pid": 97780,
      "pgid": 97780,
      "startedAt": "Mon Sep 14 20:13:36 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:36.606Z"
    },
    {
      "pid": 98046,
      "pgid": 98046,
      "startedAt": "Mon Sep 14 20:13:38 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:38.234Z"
    },
    {
      "pid": 98334,
      "pgid": 98334,
      "startedAt": "Mon Sep 14 20:13:39 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:39.887Z"
    },
    {
      "pid": 98879,
      "pgid": 98879,
      "startedAt": "Mon Sep 14 20:13:41 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:41.453Z"
    },
    {
      "pid": 99570,
      "pgid": 99570,
      "startedAt": "Mon Sep 14 20:13:43 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:43.151Z"
    },
    {
      "pid": 141,
      "pgid": 141,
      "startedAt": "Mon Sep 14 20:13:45 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:45.298Z"
    },
    {
      "pid": 345,
      "pgid": 345,
      "startedAt": "Mon Sep 14 20:13:46 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:46.653Z"
    },
    {
      "pid": 865,
      "pgid": 865,
      "startedAt": "Mon Sep 14 20:13:48 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:48.512Z"
    },
    {
      "pid": 1134,
      "pgid": 1134,
      "startedAt": "Mon Sep 14 20:13:50 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:50.029Z"
    },
    {
      "pid": 1544,
      "pgid": 1544,
      "startedAt": "Mon Sep 14 20:13:51 2026",
      "active": false,
      "command": "/Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/node",
      "at": "2026-09-15T03:13:51.816Z"
    }
  ],
  "budgetAuthorization": {
    "id": "owner-run-e-second-pass-1600",
    "maxRuns": 1600,
    "sha256": "3c3912fbe380ca1120121dadb50efe4d17d11c7b292ef17199a243c1e23e8a69",
    "headSha": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "firstRun": 1
  }
}
```
<!-- RUN_E_CHECKPOINT_124_END -->

### Additional discovery proof

Root accepted exactly 292 additional discovery corrections in 40 narrow groups: 290 original skipped-budget identities and the two already documented omission-delta identities `settings.test.ts:1883:7` and `:1883:8`. They are disjoint from the original 162-case proof and from every already measured identity. All 244 remaining candidates stay required. The reasons distinguish actual input/branch cuts from incidental changed execution outside the asserted contract. This is not an assertion-strength result or a coverage waiver.

Canonical `JSON.stringify` SHA-256: `e0cde5e28d709850630f5c1470e150d9d94269c7c04b0dd5c8e26020bfc271b3`. All source references below resolve against the manifest's immutable sourceHead and base `30896acbcb2ee127131504e531f230fcfc7e4409`. The verbose per-case proof remains at `/private/tmp/run-e-same-round-scope-corrections.json` and the complete 536-identity accounting at `/private/tmp/run-e-complete-remaining-scope-audit.json`; the compact permanent manifest retains every identity and its precise final reason.

<!-- RUN_E_CONTINUATION_SCOPE_CORRECTIONS_START -->
```json
{
  "schema": 1,
  "sourceHead": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
  "groups": [
    {
      "id": "policy-snapshot-no-target",
      "reason": "Discovery correction (root ACCEPT): Missing account or foreign/missing target inputs return null before policy-state.ts:379/:391 construct the changed populated state. No new targetRowSuspended output exists for these fixtures.",
      "ids": [
        "src/lib/agents/operator/__tests__/policy-state.integration.test.ts:398"
      ]
    },
    {
      "id": "policy-snapshot-cohort-contract",
      "reason": "Discovery correction (root ACCEPT): The populated snapshot computes targetRowSuspended at policy-state.ts:379/:391, but the assertions concern only the old 30-day review cohort and UTC day boundaries. New suspension output is incidental to this declared contract.",
      "ids": [
        "src/lib/agents/operator/__tests__/policy-state.integration.test.ts:549"
      ]
    },
    {
      "id": "policy-consequence-type-fixture",
      "reason": "Discovery correction (root ACCEPT): The fixture adds targetRowSuspended:false for the extended type, but unchanged consequenceForPolicy reads only accountDefault/location. These unit cases do not call readPolicySnapshot/mapSnapshot and never consume the new field.",
      "ids": [
        "src/lib/agents/operator/__tests__/policy-state.test.ts:31",
        "src/lib/agents/operator/__tests__/policy-state.test.ts:58"
      ]
    },
    {
      "id": "owner-read-summary-contract",
      "reason": "Discovery correction (root ACCEPT): Stored text turns pass through the rewritten turn projection, but these cases assert unchanged location policy/connection summary fields only. They do not assert new refusal output or referenced-proposal hydration. Common projection execution is incidental to the tested summary contract.",
      "ids": [
        "src/lib/agents/operator/__tests__/reads.integration.test.ts:403",
        "src/lib/agents/operator/__tests__/reads.integration.test.ts:869"
      ]
    },
    {
      "id": "owner-read-empty-input",
      "reason": "Discovery correction (root ACCEPT): No-conversation branches return before hydration; existing empty-conversation branches reach hydrateProposalReferences with zero turns/proposal IDs. New turn mapping callbacks and missing-ID hydration do not execute on values. In reads.integration:654 activeLocationId rejects only after the empty hydration on the existing-conversation arm; both branches are not claimed to return early.",
      "ids": [
        "src/lib/agents/operator/__tests__/reads.integration.test.ts:550",
        "src/lib/agents/operator/__tests__/reads.integration.test.ts:599",
        "src/lib/agents/operator/__tests__/reads.integration.test.ts:654"
      ]
    },
    {
      "id": "turn-direct-claim-create",
      "reason": "Discovery correction (root ACCEPT): These cases directly call unchanged claimTurn lease or createTurn raw-text/replay behavior. They never invoke AgentTurnWorker.ts:312-333 reply-plan assembly or turns.ts completion materialization.",
      "ids": [
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:745",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1392"
      ]
    },
    {
      "id": "turn-pre-generation-error",
      "reason": "Discovery correction (root ACCEPT): Mocked provider budget/transient failure prevents successful generation and new reply-plan construction at AgentTurnWorker.ts:312-333. Assertions concern unchanged budget-failure or release/exhaustion reconciliation. Any prompt construction is incidental and consumed by the mock, not an E refusal/Restore oracle.",
      "ids": [
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:822",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:846"
      ]
    },
    {
      "id": "turn-predecessor-wait",
      "reason": "Discovery correction (root ACCEPT): The concrete predecessor wait/stall/watchdog/delay fixtures return before successful model generation and completion. Their assertions concern existing claim release, liveness, outbox retry, or stalled failure; the added AgentTurnWorker.ts:312-333 plan and completed-turn materialization are not selected.",
      "ids": [
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:911",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:946",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:969",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:994",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1011",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1020",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1033",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1057"
      ]
    },
    {
      "id": "turn-pre-generation-authority",
      "reason": "Discovery correction (root ACCEPT): Revoked-owner/offboarding guards return before snapshot/model generation, so the new AgentTurnWorker.ts:312-333 plan and :432-439 completed-turn handoff are not reached. These fixtures assert the earlier unchanged authority failure.",
      "ids": [
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1085",
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1107"
      ]
    },
    {
      "id": "turn-invalid-output-contract",
      "reason": "Discovery correction (root ACCEPT): Both mocked outputs fail existing text validation before assembly. The validator entry may execute changed code, but no Restore proposal or refusal is supplied and assertions concern retry accounting and model_output_invalid only. It is not a whole-validator unreachability claim.",
      "ids": [
        "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1133"
      ]
    },
    {
      "id": "provider-custom-schema",
      "reason": "Discovery correction (root ACCEPT): openai-provider.test.ts:126-143 supplies a custom strict schema with existing nonempty object properties; owner_operator is only the request label. It never supplies canonical Operator schema. The changed strict-helper predicate admits empty properties, but all concrete fixture objects remain nonempty.",
      "ids": [
        "src/lib/llm/__tests__/openai-provider.test.ts:170"
      ]
    },
    {
      "id": "provider-other-task-schemas",
      "reason": "Discovery correction (root ACCEPT): These exact :313 parameters select triage, judge, and solicitation_ask. Their registered schemas are unchanged and every object remains nonempty, so the revised strict-helper predicate yields the same result. They do not select the Owner Operator schema with new clear/Restore/refusal nodes.",
      "ids": [
        "src/lib/llm/__tests__/openai-provider.test.ts:313:1",
        "src/lib/llm/__tests__/openai-provider.test.ts:313:2",
        "src/lib/llm/__tests__/openai-provider.test.ts:313:3"
      ]
    },
    {
      "id": "refusal-read-legacy-fixtures",
      "reason": "Discovery correction (root ACCEPT): read.ts is byte-unchanged and imports vocabulary as types only (:3-9). All 23 test bodies are AST-byte-identical to base. Changed seedRefusal at read.integration.test.ts:201-225 adds Operator subject mapping and explicit refusalCode support; these fixtures supply neither Operator source nor refusalCode. Their legacy source mapping and code fallback results are unchanged. Per-ID extracted source arguments corroborate the cut.",
      "ids": [
        "src/lib/refusals/__tests__/read.integration.test.ts:300",
        "src/lib/refusals/__tests__/read.integration.test.ts:317",
        "src/lib/refusals/__tests__/read.integration.test.ts:343",
        "src/lib/refusals/__tests__/read.integration.test.ts:405",
        "src/lib/refusals/__tests__/read.integration.test.ts:423",
        "src/lib/refusals/__tests__/read.integration.test.ts:442",
        "src/lib/refusals/__tests__/read.integration.test.ts:459",
        "src/lib/refusals/__tests__/read.integration.test.ts:525",
        "src/lib/refusals/__tests__/read.integration.test.ts:549",
        "src/lib/refusals/__tests__/read.integration.test.ts:569",
        "src/lib/refusals/__tests__/read.integration.test.ts:605",
        "src/lib/refusals/__tests__/read.integration.test.ts:626",
        "src/lib/refusals/__tests__/read.integration.test.ts:639",
        "src/lib/refusals/__tests__/read.integration.test.ts:661",
        "src/lib/refusals/__tests__/read.integration.test.ts:688",
        "src/lib/refusals/__tests__/read.integration.test.ts:709",
        "src/lib/refusals/__tests__/read.integration.test.ts:742",
        "src/lib/refusals/__tests__/read.integration.test.ts:776",
        "src/lib/refusals/__tests__/read.integration.test.ts:795",
        "src/lib/refusals/__tests__/read.integration.test.ts:831",
        "src/lib/refusals/__tests__/read.integration.test.ts:864",
        "src/lib/refusals/__tests__/read.integration.test.ts:878",
        "src/lib/refusals/__tests__/read.integration.test.ts:1049"
      ]
    },
    {
      "id": "vocabulary-unchanged-maps-resolver",
      "reason": "Discovery correction (root ACCEPT): Only the three membership arrays change at vocabulary.ts:106-178. These cases exercise byte-unchanged legacy maps, precedence, resolver, or error-prefix text. :741 checks unchanged textual error literals and :787 iterates locked precedence tiers, not the added membership arrays. Mechanical declaration/body comparison is retained in central proof.",
      "ids": [
        "src/lib/refusals/__tests__/vocabulary.test.ts:242",
        "src/lib/refusals/__tests__/vocabulary.test.ts:550",
        "src/lib/refusals/__tests__/vocabulary.test.ts:563",
        "src/lib/refusals/__tests__/vocabulary.test.ts:574",
        "src/lib/refusals/__tests__/vocabulary.test.ts:588",
        "src/lib/refusals/__tests__/vocabulary.test.ts:609",
        "src/lib/refusals/__tests__/vocabulary.test.ts:619",
        "src/lib/refusals/__tests__/vocabulary.test.ts:625",
        "src/lib/refusals/__tests__/vocabulary.test.ts:635",
        "src/lib/refusals/__tests__/vocabulary.test.ts:696",
        "src/lib/refusals/__tests__/vocabulary.test.ts:713",
        "src/lib/refusals/__tests__/vocabulary.test.ts:741",
        "src/lib/refusals/__tests__/vocabulary.test.ts:787"
      ]
    },
    {
      "id": "vocabulary-legacy-membership",
      "reason": "Discovery correction (root ACCEPT): These cases compare fixed legacy lane-map values with REFUSAL_CATEGORIES or check the unchanged unsafe_content literal. vocabulary.ts:141-151 gains request_not_allowed, but none of the asserted map values/fixture codes selects that new member. Array access may execute; it does not establish coverage of the E membership addition.",
      "ids": [
        "src/lib/refusals/__tests__/vocabulary.test.ts:284",
        "src/lib/refusals/__tests__/vocabulary.test.ts:300",
        "src/lib/refusals/__tests__/vocabulary.test.ts:309",
        "src/lib/refusals/__tests__/vocabulary.test.ts:317",
        "src/lib/refusals/__tests__/vocabulary.test.ts:334",
        "src/lib/refusals/__tests__/vocabulary.test.ts:347",
        "src/lib/refusals/__tests__/vocabulary.test.ts:521",
        "src/lib/refusals/__tests__/vocabulary.test.ts:643"
      ]
    },
    {
      "id": "eval-judge-envelope",
      "reason": "Discovery correction (root ACCEPT): The case selects only the existing judge fixture and checks the unchanged production judge envelope. It does not assert the newly added Operator licensed-refusal fixture.",
      "ids": [
        "tests/llm-eval/__tests__/structured-runner.test.ts:157"
      ]
    },
    {
      "id": "eval-existing-fixture-contract",
      "reason": "Discovery correction (root ACCEPT): The harness may run the added licensed fixture, but these exact assertions select existing question-only/star-scope Operator, judge, provider-error, account-off, Cafe, or weekend contracts. They do not require the new licensed-refusal result. Incidental all-case execution is acknowledged; global count/all-success cases remain retained separately.",
      "ids": [
        "tests/llm-eval/__tests__/structured-runner.test.ts:180",
        "tests/llm-eval/__tests__/structured-runner.test.ts:199",
        "tests/llm-eval/__tests__/structured-runner.test.ts:218",
        "tests/llm-eval/__tests__/structured-runner.test.ts:232",
        "tests/llm-eval/__tests__/structured-runner.test.ts:247",
        "tests/llm-eval/__tests__/structured-runner.test.ts:300:1",
        "tests/llm-eval/__tests__/structured-runner.test.ts:300:2",
        "tests/llm-eval/__tests__/structured-runner.test.ts:322",
        "tests/llm-eval/__tests__/structured-runner.test.ts:332"
      ]
    },
    {
      "id": "eval-pre-key-guard",
      "reason": "Discovery correction (root ACCEPT): Missing OPENAI_API_KEY or ANTHROPIC_API_KEY is rejected by assertStructuredKeysPresent before the case loop. No added licensed fixture or Operator output validation occurs.",
      "ids": [
        "tests/llm-eval/__tests__/structured-runner.test.ts:283:1",
        "tests/llm-eval/__tests__/structured-runner.test.ts:283:2"
      ]
    },
    {
      "id": "eval-offline-or-error-helper",
      "reason": "Discovery correction (root ACCEPT): The selected cases call unchanged sanitizeLlmError or explicitly prove offline run does not import structured-runner. The added licensed Operator fixture and its helper branch are not executed.",
      "ids": [
        "tests/llm-eval/__tests__/structured-runner.test.ts:353",
        "tests/llm-eval/__tests__/structured-runner.test.ts:376"
      ]
    },
    {
      "id": "worker-unit-pre-assembly",
      "reason": "Discovery correction (root ACCEPT): Flag-off, vanished voice row, or missing policy target causes an early failure before AgentTurnWorker.ts:312-333. Changed makeSql completed-row response and primeTurn successful reply-plan fields are not consumed by completion in these fixtures.",
      "ids": [
        "worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts:124",
        "worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts:166",
        "worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts:276"
      ]
    },
    {
      "id": "snapshot-review-scrub-contract",
      "reason": "Discovery correction (root ACCEPT): The case builds the changed system prompt, but checks old review-text scrubbing/absence and metric fields. No Restore input, new category, or stored proposal is supplied. New prompt wording executes incidentally outside this assertion contract.",
      "ids": [
        "src/lib/agents/operator/__tests__/snapshot.integration.test.ts:198"
      ]
    },
    {
      "id": "snapshot-empty-proposals",
      "reason": "Discovery correction (root ACCEPT): context.ts/buildSnapshot is byte-unchanged. These fixtures contain no historical/pending proposal rows, so the new proposal mapper callback has no inputs; they do not build prompts. Assertions concern existing operating-rule and star-band projections.",
      "ids": [
        "src/lib/agents/operator/__tests__/snapshot.integration.test.ts:352",
        "src/lib/agents/operator/__tests__/snapshot.integration.test.ts:403"
      ]
    },
    {
      "id": "model-task-reference-contract",
      "reason": "Discovery correction (root ACCEPT): The unchanged owner_operator task descriptor is checked for models/token settings and outputSchema reference identity. The test does not inspect or parse the new schema members; canonical object identity equality is not coverage of its new shape.",
      "ids": [
        "src/lib/responses/__tests__/model-pinning.test.ts:73"
      ]
    },
    {
      "id": "settings-ordinary-patch",
      "reason": "Discovery correction (root ACCEPT): Every listed operation is an ordinary Reply settings operation, never restore_reply_policy. settings.ts:237-244 and :502-503/:700-702 cannot select their Restore bodies. At :441, account inputs omit locationId and short-circuit; location inputs carry non-null UUIDs, so the new explicit-null alternative is false. Restore-only additions to readiness (:309-311), complete-disable membership (:541-546), and manual-override selection (:553-556) preserve each listed input result. Assertions concern these existing ordinary operations. Changed conditions do execute; this is concrete input proof, not a whole-function byte-identity claim.",
      "ids": [
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:228",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:262",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:298",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:347",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:393",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:457",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:482",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:540",
        "src/lib/auto-approval/__tests__/settings.integration.test.ts:558",
        "src/lib/auto-approval/__tests__/settings.test.ts:458",
        "src/lib/auto-approval/__tests__/settings.test.ts:482",
        "src/lib/auto-approval/__tests__/settings.test.ts:520",
        "src/lib/auto-approval/__tests__/settings.test.ts:552",
        "src/lib/auto-approval/__tests__/settings.test.ts:584",
        "src/lib/auto-approval/__tests__/settings.test.ts:612",
        "src/lib/auto-approval/__tests__/settings.test.ts:636",
        "src/lib/auto-approval/__tests__/settings.test.ts:661",
        "src/lib/auto-approval/__tests__/settings.test.ts:686",
        "src/lib/auto-approval/__tests__/settings.test.ts:721",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:3",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:4",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:5",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:6",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:7",
        "src/lib/auto-approval/__tests__/settings.test.ts:756:8",
        "src/lib/auto-approval/__tests__/settings.test.ts:847",
        "src/lib/auto-approval/__tests__/settings.test.ts:892",
        "src/lib/auto-approval/__tests__/settings.test.ts:930",
        "src/lib/auto-approval/__tests__/settings.test.ts:961",
        "src/lib/auto-approval/__tests__/settings.test.ts:976",
        "src/lib/auto-approval/__tests__/settings.test.ts:1004",
        "src/lib/auto-approval/__tests__/settings.test.ts:1041",
        "src/lib/auto-approval/__tests__/settings.test.ts:1079",
        "src/lib/auto-approval/__tests__/settings.test.ts:1095",
        "src/lib/auto-approval/__tests__/settings.test.ts:1121",
        "src/lib/auto-approval/__tests__/settings.test.ts:1149",
        "src/lib/auto-approval/__tests__/settings.test.ts:1170",
        "src/lib/auto-approval/__tests__/settings.test.ts:1198",
        "src/lib/auto-approval/__tests__/settings.test.ts:1227",
        "src/lib/auto-approval/__tests__/settings.test.ts:1263",
        "src/lib/auto-approval/__tests__/settings.test.ts:1294",
        "src/lib/auto-approval/__tests__/settings.test.ts:1319",
        "src/lib/auto-approval/__tests__/settings.test.ts:1352",
        "src/lib/auto-approval/__tests__/settings.test.ts:1370",
        "src/lib/auto-approval/__tests__/settings.test.ts:1405",
        "src/lib/auto-approval/__tests__/settings.test.ts:1444",
        "src/lib/auto-approval/__tests__/settings.test.ts:1464",
        "src/lib/auto-approval/__tests__/settings.test.ts:1507",
        "src/lib/auto-approval/__tests__/settings.test.ts:1545",
        "src/lib/auto-approval/__tests__/settings.test.ts:1572",
        "src/lib/auto-approval/__tests__/settings.test.ts:1636",
        "src/lib/auto-approval/__tests__/settings.test.ts:1660",
        "src/lib/auto-approval/__tests__/settings.test.ts:1716",
        "src/lib/auto-approval/__tests__/settings.test.ts:1746",
        "src/lib/auto-approval/__tests__/settings.test.ts:1773",
        "src/lib/auto-approval/__tests__/settings.test.ts:1812",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:3",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:4",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:5",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:6",
        "src/lib/auto-approval/__tests__/settings.test.ts:1900:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:1900:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:1920",
        "src/lib/auto-approval/__tests__/settings.test.ts:1950:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:1950:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:2003:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:2003:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:2049:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:2049:2",
        "src/lib/auto-approval/__tests__/settings.test.ts:2067:1",
        "src/lib/auto-approval/__tests__/settings.test.ts:2067:2",
        "src/lib/auto-approval/__tests__/suspension.integration.test.ts:333",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:7",
        "src/lib/auto-approval/__tests__/settings.test.ts:1883:8"
      ]
    },
    {
      "id": "settings-get",
      "reason": "Discovery correction (root ACCEPT): The listed cases perform GET/schema-only or earlier authorization checks; they supply no internal restore_reply_policy request. settings.ts:237-244 private Restore validation, :502-503/:700-702 Restore state/apply arms, and :772-800 restored-row writer are not selected. Added Restore terms at :309-311/:541-556 do not change these concrete inputs. Exact calls and fixture proof are recorded per ID in the settings audit.",
      "ids": [
        "src/lib/auto-approval/__tests__/settings.test.ts:372",
        "src/lib/auto-approval/__tests__/settings.test.ts:503",
        "src/lib/auto-approval/__tests__/settings.test.ts:2330",
        "src/lib/auto-approval/__tests__/suspension.integration.test.ts:307"
      ]
    },
    {
      "id": "settings-solicitation",
      "reason": "Discovery correction (root ACCEPT): Each selected mutation is a Solicitation operation and returns at settings.ts:267-273 before Reply before/after-state logic. It cannot select restore_reply_policy validation (:237-244), Restore state/apply arms (:502-503/:700-702), or restored-row writer (:772-800). The case assertions concern existing Solicitation state, audit, and authorization behavior.",
      "ids": [
        "src/lib/auto-approval/__tests__/settings.test.ts:2140",
        "src/lib/auto-approval/__tests__/settings.test.ts:2204",
        "src/lib/auto-approval/__tests__/settings.test.ts:2244",
        "src/lib/auto-approval/__tests__/settings.test.ts:2282"
      ]
    },
    {
      "id": "restraint-content-legacy-contract",
      "reason": "Discovery correction (root ACCEPT): Successful legacy payloads reach RestraintReport.tsx:236-243 scopeLine incidentally. These cases assert query/window keying, old category acceptance, legacy links, or existing archive/coverage output, without asserting the new scope sentence or seeding request_not_allowed. Content.test.tsx:454 explicitly enumerates eight legacy categories. This corrects assertion-contract discovery, not runtime unreachability.",
      "ids": [
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:194",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:220",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:408:1",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:408:2",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:408:3",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:408:4",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:1",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:2",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:3",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:4",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:5",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:6",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:7",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:454:8",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:467"
      ]
    },
    {
      "id": "restraint-rejected-payload",
      "reason": "Discovery correction (root ACCEPT): Each fixture is rejected by RestraintContent payload validation before RestraintReport renders. Concrete invalid fields and early-return edges are preserved in the per-ID audit. RestraintReport.tsx:236-243 scope wording and :73/:87 request_not_allowed copy cannot be reached; the new category membership is not the field that invalidates these legacy malformed payloads.",
      "ids": [
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:1",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:2",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:3",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:4",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:5",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:6",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:7",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:8",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:9",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:10",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:11",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:12",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:340:13",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:359",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:1",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:2",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:3",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:4",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:5",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:6",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:7",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:8",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:9",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:10",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:11",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:12",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:13",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:14",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:15",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:367:16",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:421:1",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:421:2",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:421:3",
        "src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx:435"
      ]
    },
    {
      "id": "restraint-report-legacy-contract",
      "reason": "Discovery correction (root ACCEPT): The new scopeLine sentence executes, but these exact cases assert legacy category headings/sentences, links, archive totals, or coverage notes. They do not assert the changed scope wording or new request_not_allowed category; Report.test.tsx:625/:654 enumerate eight legacy categories and :693 seeds only unsafe_content/no_permission. New category behavior has separate retained cases. No claim is made that the entire changed render is unexecuted.",
      "ids": [
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:135",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:154",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:167",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:182",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:189",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:196",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:209",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:225",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:258",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:353",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:365:1",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:365:2",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:388",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:403",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:414",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:466",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:476",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:481",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:492",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:497",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:532",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:625",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:654",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:683",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:693",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:719",
        "src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:733"
      ]
    },
    {
      "id": "apply-early-no-row",
      "reason": "Discovery correction (root ACCEPT): apply.test.ts:192 passes impersonated:true and exits at apply.ts:120-122 before any read. :416 queues no row, so proposals.ts:717 returns null before mapStoredRows. Neither reaches the new Restore-aware projection or dispatch; assertions cover unchanged zero-SQL/not-found behavior.",
      "ids": [
        "src/lib/agents/operator/__tests__/apply.test.ts:192",
        "src/lib/agents/operator/__tests__/apply.test.ts:416"
      ]
    },
    {
      "id": "catalog-selected-ordinary-methods",
      "reason": "Discovery correction (root ACCEPT): These exact fixtures select only original voice or Reply scope/cap/veto parse/preview/description/writer methods. Catalog.test.ts:475 filters domain:voice, excluding new clear/prepare entries; :525 iterates a fixed three-key ordinary table. No restoreInputFromState/previewPolicyRestore, clear_location_override, or prepare projection is called. Added members may be constructed, but are not the methods under assertion.",
      "ids": [
        "src/lib/agents/operator/__tests__/catalog.test.ts:286",
        "src/lib/agents/operator/__tests__/catalog.test.ts:303",
        "src/lib/agents/operator/__tests__/catalog.test.ts:338",
        "src/lib/agents/operator/__tests__/catalog.test.ts:364",
        "src/lib/agents/operator/__tests__/catalog.test.ts:402",
        "src/lib/agents/operator/__tests__/catalog.test.ts:439",
        "src/lib/agents/operator/__tests__/catalog.test.ts:475",
        "src/lib/agents/operator/__tests__/catalog.test.ts:525"
      ]
    },
    {
      "id": "model-call-mocked-retry-contract",
      "reason": "Discovery correction (root ACCEPT): runLlmTask is mocked at model-call.test.ts:24-27. One fixture retries into text-only success with empty proposal/refusal lists; the other throws twice. New prompt text/version may be passed to the mock, but assertions concern billing/retry/failure metadata, dynamically comparing current prompt references. No model or asserted result exercises Restore indexing/refusal behavior.",
      "ids": [
        "src/lib/agents/operator/__tests__/model-call.test.ts:127",
        "src/lib/agents/operator/__tests__/model-call.test.ts:176"
      ]
    },
    {
      "id": "proposal-write-pure-build-calls",
      "reason": "Discovery correction (root ACCEPT): proposals.test.ts:86 calls unchanged insertProposals directly; :354 calls unchanged policyStateWithConsequence with mocked consequenceForPolicy; :393 calls unchanged ordinary buildProposalRows selecting set_auto_reply_scope. None reads rows through new mapStoredRows or invokes new Restore/clear behavior.",
      "ids": [
        "src/lib/agents/operator/__tests__/proposals.test.ts:86",
        "src/lib/agents/operator/__tests__/proposals.test.ts:354",
        "src/lib/agents/operator/__tests__/proposals.test.ts:393"
      ]
    },
    {
      "id": "render-text-only-validation",
      "reason": "Discovery correction (root ACCEPT): These fixtures have text/question/status_ref segments and default proposals:[]. The indexed proposal loop has no entries and refusal_ref branch is false. Assertions concern unchanged text/count/completion/ref-metric validation, without Restore/refusal materialization.",
      "ids": [
        "src/lib/agents/operator/__tests__/render.test.ts:153",
        "src/lib/agents/operator/__tests__/render.test.ts:167",
        "src/lib/agents/operator/__tests__/render.test.ts:183"
      ]
    },
    {
      "id": "render-ordinary-index-contract",
      "reason": "Discovery correction (root ACCEPT): render.test.ts:249/:274 may process ordinary tone proposals in the new indexed loop. Assertions concern old reference/scope validation and ok flags; raw scope coexistence is checked independently of the new parsed index result. No Restore/refusal input or index output is asserted. This is contract scope, not proof that the loop is unexecuted.",
      "ids": [
        "src/lib/agents/operator/__tests__/render.test.ts:249",
        "src/lib/agents/operator/__tests__/render.test.ts:274"
      ]
    },
    {
      "id": "render-legacy-stored-segments",
      "reason": "Discovery correction (root ACCEPT): render.test.ts:580 supplies stored proposal/status/pasted_review_removed/scope_check segments only. New renderSegments refusal case and restore_unavailable notice key are never selected; assertions exercise unchanged legacy rendering.",
      "ids": [
        "src/lib/agents/operator/__tests__/render.test.ts:580"
      ]
    },
    {
      "id": "schema-existing-discriminants",
      "reason": "Discovery correction (root ACCEPT): schema.test.ts:110 probes only existing text/status_ref/set_tone/scope/unsupported shapes and forbidden server-only types. It never supplies a valid refusal_ref, restore_last, or clear input. Zod may attempt new alternatives for invalid unions, but their literal discriminants reject these fixtures; no new admitted member is asserted.",
      "ids": [
        "src/lib/agents/operator/__tests__/schema.test.ts:110"
      ]
    },
    {
      "id": "operation-selected-existing-schemas",
      "reason": "Discovery correction (root ACCEPT): operation-inputs.test.ts:47/:61 destructure only three existing Reply schemas or four existing voice schemas and assert prior limits/trim/null semantics. They neither access nor enumerate new clear_location_override; Restore inverse does not widen those model input schemas.",
      "ids": [
        "src/lib/agents/operator/__tests__/operation-inputs.test.ts:47",
        "src/lib/agents/operator/__tests__/operation-inputs.test.ts:61"
      ]
    },
    {
      "id": "context-existing-projections",
      "reason": "Discovery correction (root ACCEPT): context.test.ts:238 calls only byte-unchanged local projections. :215 mocks settings and asserts old operating-rule values; :251 constructs the catalog but selects only set_auto_reply_scope/set_tone metadata. New clear/prepare entries can be constructed incidentally, but no assertion observes them or Restore source rows.",
      "ids": [
        "src/lib/agents/operator/__tests__/context.test.ts:215",
        "src/lib/agents/operator/__tests__/context.test.ts:238",
        "src/lib/agents/operator/__tests__/context.test.ts:251"
      ]
    },
    {
      "id": "proposal-card-legacy-contract",
      "reason": "Discovery correction (root ACCEPT): ProposalCard.tsx:74-76 common instance-ID/title code executes, while :90-91 Restore/clear title special cases are unselected and :202-210 Restore action requires onRestore, absent from these fixtures (test helper:289-303). Assertions concern existing scope/confirmation/dials/receipt/error states, not repeated-instance ID uniqueness or Restore behavior. This is a contract discovery correction; incidental heading-ID execution is acknowledged.",
      "ids": [
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:81",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:101",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:110",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:134",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:147",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:174",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:205",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:306",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:331",
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:435"
      ]
    }
  ]
}
```
<!-- RUN_E_CONTINUATION_SCOPE_CORRECTIONS_END -->

### Independent continuation review and root triage

Native Codex review initially requested two corrections, both accepted by root. **E-CONT-1:** a successor with stripped pins and a reset round-1 journal could fall back to the generic allowance. The command guards now derive the continuation obligation from committed ancestry, including after branch rename, and refuse round-start on a successor. Public tests require no child execution and no journal rewrite for both stripped-journal forms. **E-CONT-2:** the historical-inventory loop omitted the two appended discovery identities from exact-reason corroboration. The checker now requires every manifest identity to remain present and checks each excluded reason, including appended rows; tests remove the appended identity and alter its reason.

The ancestry restriction deliberately follows this in-flight E history even after branch rename. Unrelated histories retain their existing behavior; future branches descending directly from this unsquashed E history would retain the restriction. Normal subsequent work starts from main after the required squash merge. This is not a claim that arbitrary descendant feature branches have an independent generic budget.

Root retains the initial REVISE findings and their corrections; no finding is waived or silently dropped. Focused/public checks and the final independent readback are recorded below before the successor is admitted.

The final runner suite passed **206/206** in 77.65 seconds, including all 15 new continuation cases and both stripped-journal witnesses (`/private/tmp/run-e-continuation-stripped-full.log`; focused 15/15 in 16.38 seconds). The checker passed **81/81** in 42.86 seconds, including all eight new continuation cases and appended-ID/reason witnesses (`/private/tmp/run-e-continuation-checker-full-anchor-fixed.log`; focused 8/8 in 14.12 seconds). Its preceding 80/81 run is retained: the original synthetic admission fixture lacked the newly introduced immutable original-admission anchor and emitted a missing-commit diagnostic. Binding that fixture anchor preserved the assertion and required no production correction.

The independent native Codex implementation review at `/private/tmp/run-e-continuation-implementation-review.md` retains initial REVISE and follow-up source verification of both accepted fixes. No remaining source blocker was identified. Root independently reproduced the compact digest and exact 292-ID equality, verified 290 historical skipped rows plus two omission deltas, and found zero overlap with the earlier 162 corrections or already measured identities. Both focused suites used disposable repository fixtures; the actual checkpoint remains 124 launches. The final literal manifest-pin synchronization and the complete candidate are covered by the subsequent full gate. No successor launch is permitted until that committed gate and the frozen-controller readback pass.


### Full-gate fixture corrections before admission

The first continuation gate at `6813a85421c34ef14318e668cd55c0d7b6658f98` failed typecheck on three intentionally malformed journal fixtures: their JSON writer accepted the narrower `Journal` type. Its serialization-only parameter now accepts `unknown`; production types and assertions are unchanged. Typecheck passed after that one-line annotation correction. Two disposable-history checker cases also exceeded the default five-second timeout under the complete concurrent suite; each now has a finite fifteen-second case timeout, retaining every assertion. Both affected cases passed together in 5.38 seconds. The actual adversarial process timeout, launch cap, checkpoint and pin rules are unchanged.

The failed run retained 16,197 passing database-lane tests and 11 skips, with those two timeouts; compilation's typecheck failure also prevented the production build and dependent E2E startup. All ten changed integration checks and all audits passed. This is not a green gate claim. The failed status and five relevant lane logs are preserved at `/private/tmp/run-e-continuation-admission-gate-failed-6813/`; focused correction evidence is `/private/tmp/run-e-continuation-fixture-typecheck.log` and `/private/tmp/run-e-checker-timeout-two-focused.log`. The complete corrected candidate must pass the next serialized full gate before launch 125. These supporting fixes occur before any successor pin and consume no real adversarial launches.

### Measurements retained at the checkpoint

The following 62 attempts retain their actual admission/controller and launch numbers. They establish 60 distinct assertion kills after retaining one equivalent attempt and one database-check interception before successful second mutations. These are checkpoint observations, not a final red-team report. All 39 measured guard identities used one mutation and require fresh successor measurements; a case's two-mutation limit spans both pins.

```json
[
  {
    "number": 1,
    "identity": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:122:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx",
      "from": ".map((row) => cards.updatedProposals[row.id] ?? row)",
      "to": ".map((row) => row)",
      "rationale": "Keep the stale pending timeline snapshot instead of adopting the rejected Apply response; the card incorrectly retains Apply and cannot present Refresh plan."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 0,
      "launchAfter": 1,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 1,
      "launchAfter": 2,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 2,
    "identity": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx:122:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx",
      "from": ".map((row) => cards.updatedProposals[row.id] ?? row)",
      "to": ".map((row) => row)",
      "rationale": "Keep the stale pending timeline snapshot instead of adopting the rejected Apply response; the card incorrectly retains Apply and cannot present Refresh plan."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 2,
      "launchAfter": 3,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 3,
      "launchAfter": 4,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 3,
    "identity": "src/lib/agents/operator/__tests__/refusal-completion.test.ts:28",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "const subjectId = randomUUID();",
      "to": "const subjectId = '00000000-0000-4000-8000-000000000001';",
      "rationale": "The accepted assertion fix removes incidental map-key order, while the test must still reject duplicate subject identities. Reuse the original meaningful round1 mutant under a fresh baseline at the final corrected HEAD."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 4,
      "launchAfter": 5,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 5,
      "launchAfter": 6,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 4,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:375",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "|| receipt.scope.locationId !== source.locationId",
      "to": "|| false",
      "rationale": "The test tampers a real source receipt to name a sibling location. Omitting provenance equality admits that foreign scope in preparation/readback/Apply."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 6,
      "launchAfter": 7,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 7,
      "launchAfter": 8,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 5,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:216",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "operation.restoreInputFromState(receipt.before)",
      "to": "operation.restoreInputFromState(receipt.after)",
      "rationale": "Use the applied after-tone instead of nullable pre-state, violating the asserted inverse."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 8,
      "launchAfter": 9,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 9,
      "launchAfter": 10,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 6,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:240",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "patch: operation.restoreInputFromState(receipt.before, receipt.after, target)",
      "to": "patch: operation.restoreInputFromState(receipt.after, receipt.before, target)",
      "rationale": "Reverse policy receipt chronology; loses the old cleared override or absent account default."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 10,
      "launchAfter": 11,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 11,
      "launchAfter": 12,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 7,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:264",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "patch: operation.restoreInputFromState(receipt.before, receipt.after, target)",
      "to": "patch: operation.restoreInputFromState(receipt.after, receipt.before, target)",
      "rationale": "Reverse policy receipt chronology; loses the old cleared override or absent account default."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 12,
      "launchAfter": 13,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 13,
      "launchAfter": 14,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 8,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:316",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore.ts",
      "from": "&& versionTokensEqual(existing.preparedVersionToken, fields.preparedVersionToken)",
      "to": "&& false",
      "rationale": "Disable reuse of a same-source/same-version preparation; concurrent requests produce distinct proposals instead of one identity."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 14,
      "launchAfter": 15,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 15,
      "launchAfter": 16,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 9,
    "identity": "src/lib/agents/operator/__tests__/restore.integration.test.ts:362",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore.ts",
      "from": "if (input.impersonated) return { kind: 'unauthorized' };",
      "to": "if (false) return { kind: 'unauthorized' };",
      "rationale": "The test explicitly submits an impersonated Restore; bypassing this guard admits it before the valid stored owner is checked."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 16,
      "launchAfter": 17,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 17,
      "launchAfter": 18,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 10,
    "identity": "src/lib/agents/operator/__tests__/refusal-completion.test.ts:47:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "businessId: input.turn.locationId",
      "to": "businessId: null",
      "rationale": "Swap the persisted refusal scope for this explicitly asserted content/policy lane."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 18,
      "launchAfter": 19,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 19,
      "launchAfter": 20,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 11,
    "identity": "src/lib/agents/operator/__tests__/refusal-completion.test.ts:47:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "businessId: input.turn.locationId",
      "to": "businessId: null",
      "rationale": "Swap the persisted refusal scope for this explicitly asserted content/policy lane."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 20,
      "launchAfter": 21,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 21,
      "launchAfter": 22,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 12,
    "identity": "src/lib/agents/operator/__tests__/refusal-completion.test.ts:47:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "businessId: null",
      "to": "businessId: input.turn.locationId",
      "rationale": "Swap the persisted refusal scope for this explicitly asserted content/policy lane."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 22,
      "launchAfter": 23,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 23,
      "launchAfter": 24,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 13,
    "identity": "src/lib/agents/operator/__tests__/refusal-completion.test.ts:47:6",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "businessId: null",
      "to": "businessId: input.turn.locationId",
      "rationale": "Swap the persisted refusal scope for this explicitly asserted content/policy lane."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 24,
      "launchAfter": 25,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 25,
      "launchAfter": 26,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 14,
    "identity": "src/lib/agents/operator/__tests__/restore-inputs.test.ts:97:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "operation.restoreInputFromState(receipt.before)",
      "to": "operation.restoreInputFromState(receipt.after)",
      "rationale": "Use the applied after-state instead of the tested owned-field inverse."
    },
    "provisionalOutcome": "equivalent",
    "baseline": {
      "launchBefore": 26,
      "launchAfter": 27,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 27,
      "launchAfter": 28,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    }
  },
  {
    "number": 15,
    "identity": "src/lib/agents/operator/__tests__/restore-inputs.test.ts:97:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "fields: operation.writerFields(restored)",
      "to": "fields: { ...receipt.before, ...operation.writerFields(restored) }",
      "rationale": "Restore must emit only the operation-owned field. Including other historical voice fields violates the exact fields object asserted by this case, even where the owned before/after value is equal."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 28,
      "launchAfter": 29,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 29,
      "launchAfter": 30,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 16,
    "identity": "src/lib/agents/operator/__tests__/restore-inputs.test.ts:97:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "fields: operation.writerFields(restored)",
      "to": "fields: { ...receipt.before, ...operation.writerFields(restored) }",
      "rationale": "Restore must emit only the operation-owned field. Including other historical voice fields violates the exact fields object asserted by this case, even where the owned before/after value is equal."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 30,
      "launchAfter": 31,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 31,
      "launchAfter": 32,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 17,
    "identity": "src/lib/agents/operator/__tests__/restore-inputs.test.ts:97:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/restore-inputs.ts",
      "from": "fields: operation.writerFields(restored)",
      "to": "fields: { ...receipt.before, ...operation.writerFields(restored) }",
      "rationale": "Restore must emit only the operation-owned field. Including other historical voice fields violates the exact fields object asserted by this case, even where the owned before/after value is equal."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 32,
      "launchAfter": 33,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 33,
      "launchAfter": 34,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 18,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:366",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/turns.ts",
      "from": "decidedAt: 'transaction_time'",
      "to": "decidedAt: turn.completed_at",
      "rationale": "Round-trip the fenced completion timestamp through JavaScript Date, discarding PostgreSQL microseconds; the real ledger assertion requires exact occurred_at=completed_at."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 34,
      "launchAfter": 35,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 35,
      "launchAfter": 36,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 19,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:415",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusal-completion.ts",
      "from": "businessId: input.turn.locationId",
      "to": "businessId: null",
      "rationale": "Persist the content refusal as account-wide instead of the claimed location, violating the asserted ledger lane and safe projection."
    },
    "provisionalOutcome": "inconclusive-oracle",
    "baseline": {
      "launchBefore": 36,
      "launchAfter": 37,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 37,
      "launchAfter": 38,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 20,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:415",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/refusals.ts",
      "from": "invented_business_fact: {\n    source: 'operator_content_refused', scope: 'location'",
      "to": "invented_business_fact: {\n    source: 'operator_policy_refused', scope: 'account'",
      "rationale": "Coherently misclassify the tested invented-business-fact refusal into the valid policy/account ledger lane. The case explicitly asserts content/location source and scope, so the mutant must fail its behavioral assertion rather than a database constraint."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 38,
      "launchAfter": 39,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 39,
      "launchAfter": 40,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 21,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:452",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/turns.ts",
      "from": "if (!completed) return { fenced: false };",
      "to": "if (!completed) return { fenced: true };",
      "rationale": "Report ownership of a lost completion fence, directly violating the tested false fence result."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 40,
      "launchAfter": 41,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 41,
      "launchAfter": 42,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 22,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:471",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/turns.ts",
      "from": "const restored = await materializeFencedReply(tx, input, completed);",
      "to": "const restored: ProposalReplacement[] = [];",
      "rationale": "Skip fenced Restore/refusal materialization so the injected ledger failure is never reached and the turn commits; the case must reject and preserve the running turn atomically."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 42,
      "launchAfter": 43,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 43,
      "launchAfter": 44,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 23,
    "identity": "src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:498",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": "src/lib/agents/operator/turns.ts",
      "from": "restoreUnavailable = true;",
      "to": "restoreUnavailable = false;",
      "rationale": "Suppress the server-owned missing-history notice while still finding no Restore source; the worker reply contract must detect its absence."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 44,
      "launchAfter": 45,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 45,
      "launchAfter": 46,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 24,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:397",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "grant: { id: authorization.id, maxRuns: 1600, sha256: sha256(JSON.stringify(authorization)), headSha }",
      "to": "grant: { id: authorization.id, maxRuns: 1599, sha256: sha256(JSON.stringify(authorization)), headSha }",
      "rationale": "Reduce the committed Run E grant cap by one; the first-child pin assertion or inclusive launch-1600 boundary must detect the incorrect granted limit."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 46,
      "launchAfter": 47,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 47,
      "launchAfter": 48,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 25,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 48,
      "launchAfter": 49,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 49,
      "launchAfter": 50,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 26,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 50,
      "launchAfter": 51,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 51,
      "launchAfter": 52,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 27,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 52,
      "launchAfter": 53,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 53,
      "launchAfter": 54,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 28,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:4",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 54,
      "launchAfter": 55,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 55,
      "launchAfter": 56,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 29,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 56,
      "launchAfter": 57,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 57,
      "launchAfter": 58,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 30,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:6",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 58,
      "launchAfter": 59,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 59,
      "launchAfter": 60,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 31,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:7",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 60,
      "launchAfter": 61,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 61,
      "launchAfter": 62,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 32,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:410:8",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 62,
      "launchAfter": 63,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 63,
      "launchAfter": 64,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 33,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 64,
      "launchAfter": 65,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 65,
      "launchAfter": 66,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 34,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 66,
      "launchAfter": 67,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 67,
      "launchAfter": 68,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 35,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 68,
      "launchAfter": 69,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 69,
      "launchAfter": 70,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 36,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:4",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 70,
      "launchAfter": 71,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 71,
      "launchAfter": 72,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 37,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 72,
      "launchAfter": 73,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 73,
      "launchAfter": 74,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 38,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:6",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 74,
      "launchAfter": 75,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 75,
      "launchAfter": 76,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 39,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:7",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 76,
      "launchAfter": 77,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 77,
      "launchAfter": 78,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 40,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:8",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 78,
      "launchAfter": 79,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 79,
      "launchAfter": 80,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 41,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:427:9",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 80,
      "launchAfter": 81,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 81,
      "launchAfter": 82,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 42,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 82,
      "launchAfter": 83,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 83,
      "launchAfter": 84,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 43,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 84,
      "launchAfter": 85,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 85,
      "launchAfter": 86,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 44,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 86,
      "launchAfter": 87,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 87,
      "launchAfter": 88,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 45,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:4",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 88,
      "launchAfter": 89,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 89,
      "launchAfter": 90,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 46,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 90,
      "launchAfter": 91,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 91,
      "launchAfter": 92,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 47,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:6",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 92,
      "launchAfter": 93,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 93,
      "launchAfter": 94,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 48,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:448:7",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 94,
      "launchAfter": 95,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 95,
      "launchAfter": 96,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 49,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:469:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 96,
      "launchAfter": 97,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 97,
      "launchAfter": 98,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 50,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:469:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 98,
      "launchAfter": 99,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 99,
      "launchAfter": 100,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 51,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:469:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 100,
      "launchAfter": 101,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 101,
      "launchAfter": 102,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 52,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:469:4",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 102,
      "launchAfter": 103,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 103,
      "launchAfter": 104,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 53,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:469:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 104,
      "launchAfter": 105,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 105,
      "launchAfter": 106,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 54,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:1",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 106,
      "launchAfter": 107,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 107,
      "launchAfter": 108,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 55,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:2",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 108,
      "launchAfter": 109,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 109,
      "launchAfter": 110,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 56,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:3",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 110,
      "launchAfter": 111,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 111,
      "launchAfter": 112,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 57,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:4",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 112,
      "launchAfter": 113,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 113,
      "launchAfter": 114,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 58,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:5",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 114,
      "launchAfter": 115,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 115,
      "launchAfter": 116,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 59,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:483:6",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 116,
      "launchAfter": 117,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 117,
      "launchAfter": 118,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 60,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:534",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 118,
      "launchAfter": 119,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 119,
      "launchAfter": 120,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 61,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:546",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "grant: { id: authorization.id, maxRuns: 1600, sha256: sha256(JSON.stringify(authorization)), headSha }",
      "to": "grant: { id: authorization.id, maxRuns: 1599, sha256: sha256(JSON.stringify(authorization)), headSha }",
      "rationale": "Reduce the committed Run E grant cap by one; the first-child pin assertion or inclusive launch-1600 boundary must detect the incorrect granted limit."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 120,
      "launchAfter": 121,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 121,
      "launchAfter": 122,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  },
  {
    "number": 62,
    "identity": "scripts/ci/__tests__/red-team-mutation-runner.test.ts:558",
    "head": "b6ee3973b3e0ad9f6749f02c5428e6b4980cf837",
    "controllerHash": "168aeb391f86cae8cc7e4d5706650a4dd0770d4bfa4095963bfd8345cf98bbae",
    "mutation": {
      "file": ".agents/skills/red-team/scripts/mutation-runner.mjs",
      "from": "if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "to": "if (false && ((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)",
      "rationale": "Disable the added Run E fail-closed startup rejection. This exact fixture supplies the named invalid admission/pin/input, which otherwise yields no valid authorization; absent this guard it falls back to the ordinary counter and executes an unauthorized child, which the test must reject."
    },
    "provisionalOutcome": "assertion-kill-awaiting-failure-review",
    "baseline": {
      "launchBefore": 122,
      "launchAfter": 123,
      "exit": 0,
      "exactlyOne": true,
      "status": "passed"
    },
    "mutant": {
      "launchBefore": 123,
      "launchAfter": 124,
      "exit": 1,
      "exactlyOne": true,
      "status": "failed"
    }
  }
]
```
