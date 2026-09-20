Codex resumable thread id: 01a0c109-d448-7491-8281-33b1e34ec64c (model gpt-6-astra, read-only; round 2 resumed this thread)

I’ll read the plan, intake, and deviations in that order, then check the promised tests and citations against the current code. I’ll keep this read-only and tie each behavioral finding to an exact missing test title.
The checkout is at `650f625e7`; only the three review documents are untracked. I’m applying the repository’s `verify-spec` skill for the evidence audit, while following your read-only constraint and requested verdict format. One discrepancy is already clear: the intake promises 16 titles, but the plan assigns only 14—the two default-off/override titles have no test task.
The main risk is now concrete: T5 updates `listPendingProposals`, but the conversation renders cards from `listProposalsForTurns`, which also returns pending proposals. I’m tracing that route and checking whether the snapshot contains enough information to support the promised suspension and off-by-default behavior.
D2’s premise is contradicted by the code: pending cards reach `TurnBody` through the transcript path that the plan explicitly leaves unchanged. I also found that the snapshot contains rules for only the selected location, so it cannot distinguish “all overrides off” from “another location has an armed override.” T2’s proposed entitlement change looks sound; the missing proof is that the remaining gates still reject real writes after purchasability is removed.
VERDICT: REVISE

## Failability

**Yes. All 16 promised titles can pass while #1352 remains visible to the owner.** The strongest counterexample follows most of the plan faithfully; it does not need skipped tests or fabricated assertions.

Construct this implementation:

1. Extract the copy correctly, make T2’s exact entitlement change, and correctly project `posting` into the snapshot.
2. Add T4’s English rules and version bump. Test the returned system string, following the existing `prompt.test.ts` pattern.
3. Pass current posting status through `listPendingProposals`. Give the other proposal readers an empty `postingBlockSentences` field, consistent with T5/D2’s instruction to leave the transcript path unchanged.
4. Test the proposal projection directly, and render `ProposalCard` with correctly populated fixture props. Add the two otherwise-unassigned default-off titles as prompt-contract tests.

The result passes those seams, but **the actual conversation still displays pending cards without the warning**:

- [`getConversationForOwner`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/reads.ts:341) obtains transcript proposals through `listProposalsForTurns`.
- [That query](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/proposals.ts:575) includes **every status, including pending**.
- [`TurnBody`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/app/(authenticated)/dashboard/operator/TurnBody.tsx:42) renders `turn.proposals`, not `summary.pendingProposals`.

Thus D2 excludes the very pending cards T5 is supposed to fix. Tests can exercise all the newly added mapping and rendering lines without testing this unchanged routing, so 80% changed-line coverage does not close the gap.

The conversational reply also remains insufficiently verified. The two promised prompt tests establish that instructions exist, not that the model follows them. A response such as “Your automatic replies post on their own” contains neither an invented count nor a forbidden completion claim and is not rejected by the existing [text validation](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/render.ts:191). T4 supplies no behavioral evaluation or explicit acknowledgement of that remaining uncertainty.

There is also a deterministic information gap: with the account default and selected location off, changing **another location’s** override from off to armed does not change the planned snapshot. Only the selected location’s rules are projected; the other locations carry names and IDs. The model cannot reliably distinguish the intake’s two account-wide default-off cases from identical inputs.

These counterexamples match the source problem, which I verified against [GitHub issue #1352](https://github.com/RepWorth/ai-review-responder/issues/1352).

## Missing failing tests

Rows 3 and 4 are already promised by the intake but are **missing from the plan’s task assignments**. The other rows are additional titles.

| # | exact test title to add | task | failure mode it catches |
|---|---|---|---|
| 1 | `a pending armed proposal in the conversation transcript renders the current Posting block sentences` | **T5** — conversation read integration and actual card rendering | D2 leaves pending transcript cards unpopulated. Exercise the returned `turns[].proposals`; a component test supplied with manufactured props is insufficient. Cover the initial turn-result read and conversation reload. |
| 2 | `rereading the same pending proposal adds and removes Posting block sentences as current settings change` | **T5** — read integration | Preparation-time storage, caching, or incorrect caller wiring can pass every one-shot card test. Read the same stored proposal with blocked → clear → blocked settings, without rewriting its stored `after`. Assert preparation-time readiness metadata remains unchanged. |
| 3 | `an account that is off by default with no armed override states off, not a Posting block correction` | **T4** — assign this existing intake title | The plan’s self-review claims this is assigned, but it is absent. Assert the owner-visible reply, not merely that the constant prompt contains an “Off” instruction. |
| 4 | `an off-by-default account with an armed location override states the Posting block` | **T4**, dependent on **T3** — assign this existing intake title | Also absent. Use an armed override on a location **other than the selected location**; otherwise the test misses the unavailable-data problem. |
| 5 | `the snapshot distinguishes all locations being off from an armed override outside the selected location` | **T3** — snapshot integration | The proposed snapshot shape loses the account-wide armed-override fact required by row 4. Compare otherwise-identical settings fixtures that differ only in the other location’s threshold. |
| 6 | `a suspended armed account states suspension first and each Posting block sentence exactly once` | **T4** — reply behavior evaluation | The intake explicitly promises suspension precedence, but T4 specifies no suspension rule and promises no test for it. This also prevents treating suspension as ordinary “Off” and suppressing all block information. |
| 7 | `a blocked armed account's generated reply states every Posting block sentence without claiming replies post` | **T4** — actual-model evaluation, or a deterministic server-enforced output contract | Both current titles can pass while generated prose still ships the original false claim. Exercise `judge_disabled`, `publisher_subscription_denied`, and multiple simultaneous reasons; assert no omitted or invented reasons. A mocked compliant completion does not prove prompt effectiveness. |
| 8 | `buildOperatorPrompt receives every Posting block sentence in builder order and none when unblocked` | **T3** — `buildSnapshot` through prompt-envelope serialization | The three snapshot titles name `blocked`, reason ordering, and readiness independence. They do not require complete `sentences`. An empty or first-reason-only sentence projection leaves the model unable to follow the verbatim-copy rule while those assertions pass. |
| 9 | `a Posting block does not prevent the Operator from proposing a supported contraction` | **T4** — reply behavior evaluation | “Apply remains enabled” only tests an already-existing card. The model can still withhold the proposal entirely. Use an armed account and request a narrower but still armed policy under `judge_disabled`; assert both the proposal reference and warning. |
| 10 | `a paused-sale Autopilot account cannot expand settings when AUTO_APPROVAL_ENABLED is false` | **T2** — settings writer test | The promised runtime-off test calls the pure readiness builder. It cannot catch incorrect runtime wiring in `buildReadiness` after the composed purchase/runtime conjunct is removed. Invoke a confirmed expansion through the real settings writer and assert `auto_approval_disabled` plus no mutation. |
| 11 | `all five Posting block sentences remain byte-for-byte unchanged after the shared-copy extraction` | **T1** — copy contract | The prescribed map test checks keys, and the cross-surface test compares only `judge_disabled` against the new map. Both can pass after accidentally changing the other four sentences, violating the explicit no-copy-change contract. |

For rows involving generated replies, actual-model evaluations provide empirical evidence, not a universal guarantee. The plan should say that plainly. If the acceptance requirement is deterministic, the plan needs a server-owned rendering or validation mechanism and an explicit surface amendment.

## Cited-artifact check

Checked against HEAD `650f625e788d1a87a770c77d40ae8a2d41730982`. The three review documents are untracked; tracked source is clean. Small line offsets are included as requested.

| citation | resolves? | what is actually there |
|---|---|---|
| T1: [`schema.ts:517`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/schema.ts:517), `READINESS_BLOCK_REASONS` mapped type | **No** | Line 517 begins the stored-policy-state docblock. The mapped type declaration is at **467**. |
| T1: `schema.ts:512–521`, mapped-type precedent and enforcement comment | **No** | This spans a consequence-schema refinement and the stored-policy-state docblock. The relevant precedent is **461–477**. |
| T1: [`AutoApprovalClient.tsx:108–118`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:106), docblock to move | **Partial** | The full docblock starts at **106**. Line 108 starts mid-sentence. The specific Copilot rationale is at 114–117. |
| T2: [`readiness.ts:8`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/readiness.ts:8), quoted entitlement comment | **No** | Line 8 is `providerModerationValidated: boolean`. The quoted comment is at **5**. |
| T3: [`context.ts:397`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/context.ts:397), field-by-field `facts` precedent | **No** | Line 397 projects `operatingRules`. The rationale is at **398–399** and `facts` starts at **400**. |
| T5: [`reads.ts:436`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/reads.ts:436), pending-proposals call | **Partial** | Line 436 starts the conditional declaration; the invocation is at **438**. |
| Intake: [`context.ts:96`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/context.ts:95), `projectPolicyStates` declaration | **Partial** | Declaration starts at **95**; 96 is its first parameter. |
| Intake: [`proposals.ts:370–397`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/proposals.ts:368), `CardFacts` / `policyCardFacts` | **Partial** | `CardFacts` starts at **368**; `policyCardFacts` spans **384–400**. The cited range starts and ends inside those constructs. |
| T2: [`settings.ts:1196`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/settings.ts:1196) | **Yes** | Exact composed `autopilotAvailable` expression. |
| T2: [`solicitation-settings.ts:174–194`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/auto-approval/solicitation-settings.ts:174) | **Yes** | Tier-only rationale and tier-only builder input. |
| T3/T5: [`context.ts:365`, `:369`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/context.ts:365) | **Yes, sequencing caveat** | Proposals are currently read **before** settings. Passing `settings.posting` requires moving the settings read earlier while preserving sequential execution. |
| T3: [`context.test.ts:117`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/__tests__/context.test.ts:117) | **Yes** | Existing `posting` fixture. |
| T4: [`prompt.ts:11`, “Output rules”, `expansionBlockedBy` rule](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/prompt.ts:11) | **Yes** | Version at 11, section at 52, readiness rule at 69. The existing test pins version `2026-09-14.2`. |
| T4: [`AutoApprovalClient.tsx:726`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:726) | **Yes** | Blocked-and-armed predicate, including armed location overrides. |
| T5/D2: [`reads.ts:341`, transcript path](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/reads.ts:341) | **Symbol yes; claimed scope no** | The path includes pending proposals. “Transcript” does not mean “historical proposal status.” |
| T5: [`reads.ts:428`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/reads.ts:428) | **Yes** | Settings read inside `readSummary`. |
| T5: [`ProposalCard.tsx:195`, `:253`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/app/(authenticated)/dashboard/operator/ProposalCard.tsx:195) | **Yes** | Readiness list and confirmation/readiness disable condition. |
| Vocabulary/T6: [`core-reviews-responses.md:10`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/docs/context/core-reviews-responses.md:10); [`owner-operator.md:13`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/docs/context/owner-operator.md:13) | **Yes** | Exact Posting block and Context snapshot entries. |
| T3: cited `ci:pool-fanout` protection | **Not for this directory** | [`SCAN_DIRS`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/scripts/ci/pool-fanout-audit.ts:142) contains only `admin`, `dashboard`, and `locations`. Sequential operator reads are a valid constraint, but this audit does not enforce them. |
| All remaining existing paths, unnumbered symbols, directory rows, and invariant references | **Yes** | Resolved. All `Modify` targets exist. |
| Three `Create` targets and newly proposed symbols | **Absent as expected** | Copy module, copy test, and ADR 0034 are new work, not broken citations. Intake and deviations paths resolve on disk, although untracked. |

## Other findings

| # | severity | plan section | finding |
|---|---|---|---|
| 1 | **High** | T5 / D2 | **Re-plan the read-path wiring.** Pending-only warning behavior is sensible; implementing it only in a function named `listPendingProposals` is not sufficient. Apply the status predicate to the proposal views the owner actually receives. Missing failing test: **#1**. |
| 2 | **High** | T3 / T4 / self-review | The account-wide off/override contract requires information absent from the proposed snapshot. This concerns configured policy state, so fixing it does **not** re-admit excluded per-location runtime gates. Missing failing tests: **#3–5**. |
| 3 | **High** | T4 / definition of done | Prompt-text assertions are presented without a separate proof or limitation for owner-visible language. The two intake default-off titles are also unassigned, despite the self-review claiming all 16 are assigned. Missing failing tests: **#3, #4, #6, #7, #9**. |
| 4 | **Medium** | D1 / T5 freshness rationale | Read-time derivation is the right choice, but “a stale one would only ever be a false warning” is false: a block that appears after preparation produces a **missing warning**. Also, Apply rechecks current readiness in [`apply.ts`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/apply.ts:480); frozen card readiness is not its only enforcement. Missing failing test: **#2**. |
| 5 | **Medium** | T5 negative cases | “Apply stays enabled in every blocked case” is too broad. Several Posting blocks overlap legitimate readiness refusals. The correct invariant is that **Posting block information adds no new disable condition**; existing readiness and confirmation requirements still apply. The promised Apply test must use an otherwise-applicable proposal. |
| 6 | **Low** | T4 “Bump the version” | The bump is specified correctly, but its explanation is wrong. [`operatorSystemPromptHash`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/prompt.ts:89) hashes prompt contents independently of the version; [`model-call.ts`](/Users/norbertesekiel/orca/workspaces/RepWorth/fix-1352-operator-posting-block-context/src/lib/agents/operator/model-call.ts:62) records both. An omitted bump leaves a misleading version label, not an invisible prompt change. |
| 7 | **Low** | T3 docblock / T6 | T3 introduces a comment saying readiness folds in `autopilotPurchasable()` immediately after T2 removes that behavior. T6 corrects glossary and directory wording but also leaves that claim in existing `posting-status.ts` and `settings.ts` comments. Describe it as the pre-fix defect where historical explanation is needed. |

**T2’s proposed code change itself is sound.** The seven remaining readiness reasons are correctly enumerated. `runtimeEnabled` is independently supplied to the builder, and missing or Copilot tiers fail `tierGrantsAutopilot`. Removing purchasability intentionally removes the final refusal when a paused sale is the **only** refusal; it does not remove the runtime-off gate. Test #10 proves that distinction through a write rather than only through a pure helper.

The words/data/rule ownership split is coherent, and I found no task that adds Judge health or per-draft checks. The blocking problems are the omitted production card path, insufficient snapshot information, and tests that establish prompt instructions without establishing reply behavior.

Read-only audit completed; no files were changed. I did not run builds or test suites, and the passing-but-wrong implementation above is a source-backed counterexample, not a claimed executed mutation.
The stop hook is requesting gate evidence. I’ll inspect `verified-gate.sh --review` to see whether it can run within this read-only audit.
The script writes gate logs, status, and a fingerprint, so it is not read-only. I’ll attempt the hook’s exact command under the existing read-only sandbox; I won’t escalate filesystem access for this audit.
VERDICT: REVISE

I attempted the hook’s exact command:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
```

It exited **1** because the read-only sandbox denied writes to `.feature/gate-heartbeat.json`, the gate logs, and `.feature/gate-status.json`. The reported check failures are **execution failures caused by those denied writes**, not evidence of lint, type, or test defects. No valid gate evidence or fingerprint was produced.

The gate also classified this checkout as **docs-only** and skipped tests, build, promised-test matching, and changed-line coverage. It therefore would not establish the proposed feature’s correctness at this plan-review stage.

Git status remains unchanged: only the three supplied review documents are untracked. The audit’s **REVISE** verdict stands, principally because T5 excludes the transcript read path that renders pending cards, and T3 omits the other-location policy information needed for the promised default-off distinction.
