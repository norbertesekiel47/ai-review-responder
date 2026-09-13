# Run C — independent standards and maintainability review

Candidate: `5f2c201769ba982f49b9ecbd82678b45e75b19b1`.
Fork/merge-base: `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`.

Verdict: **one low-severity finding; no high/medium maintainability defect established**. Root triage remains authoritative. This is the standards axis, not an independent assertion of browser, deployment, security or full test completion.

## Finding SM-1 — low: policy projection comment names the wrong owner of preview inheritance

- **Confidence:** 100%.
- **Immutable location:** `src/lib/agents/operator/context.ts:74–77` at the candidate SHA above.
- **Named standard:** accurate ownership and mechanism documentation; `docs/agents/context-layout.md` requires one owner per fact, and standards checklist lines 10, 17, 20 and 25 reject comments that misdirect the next maintainer or claim a mechanism the source does not implement.
- **Evidence:** The new docblock calls `projectPolicyStates` “THE single owner of the inheritance rule,” says “policy previews start from it,” and concludes “the next dial has one place to change.” Candidate `git grep -n projectPolicyStates … -- src worker` finds exactly one production caller, `projectOperatingRules` in the same file at line 139. Preparation instead calls `readPolicySnapshot` in `AgentTurnWorker.preparePolicyTargets`; `proposals.ts:158` passes `snapshot.state` to the catalog preview. Apply independently calls `readPolicySnapshot` at `apply.ts:324` and previews its state at line 340. `policy-state.ts:352–358` owns the separate snapshot inheritance mapping. Neither preview path consumes `projectPolicyStates`.
- **Concrete maintenance scenario:** An engineer follows the comment when adding a policy dial or changing inheritance, updates `projectPolicyStates`, and believes both the summary and proposal state now share the correction. Only the operating-rules summary changes; proposal preparation and Apply still use the independently mapped snapshot. The source currently agrees on the relevant values, so this is a misleading ownership claim rather than an observed runtime divergence.
- **Smallest maintainable correction:** Narrow the docblock to the settings-response projection used by the context snapshot and summary panel. Explicitly point policy proposal preparation/Apply to `policy-state.ts` and its one-statement coherent snapshot. Remove the claim that there is only one place to change. No runtime refactor is necessary to correct this finding.

## Architecture and test assessment

The domain split is meaningful: Apply retains parent-lock ordering and transaction ownership while voice and policy branches own their respective gates, writer adapters and receipt construction. The in-transaction settings export reuses the existing settings mutation/audit path. `consequence.ts` is a pure calculation seam with independent hand-counted fixtures, and `policy-state.ts` owns coherent database snapshots and provenance filtering. `operation-inputs.ts` has actual catalog/schema consumers and avoids making either consumer own the other. `PolicyStateDetail` has actual preview/receipt consumers. These are useful modules rather than speculative one-caller frameworks.

Policy writer refusal handling distinguishes named pre-mutation domain errors from unexpected failures that must roll back. Read/write boundaries validate persisted shapes and preserve opaque microsecond tokens. The provider changes remain in the established adapters and task executor; registered Zod schemas remain authoritative, provider-specific conversion is local, and refusal/truncation carries billed usage. The two ingestion paths use the existing run-spine writer, and their different completion behavior explains why they are not blindly unified.

Tests inspected include policy-domain input contracts, catalog previews and writer-field bounds, hand-counted consequences, snapshot inheritance, policy Apply integration assertions, strict schema/provider checks and UI card behavior. The integration cases inspect committed rows/receipts/audits and use existing abort/lock helpers; they are not solely mock-call traces. No production/test files were modified and no mutations or test reruns were performed by this reviewer. Full gate/fallow status was supplied by the root briefing and is not claimed as independently rerun here.

## Every checklist line checked

Checklist: `docs/reviews/finding-checklists/standards-maintainability.md` at the candidate SHA. Its 28 entries occupy lines 8–35. Entries sharing a historical root cause are still listed separately below.

| Checklist line | Defect class | Assessment for Run C |
| --- | --- | --- |
| 8 | Random totality proof misses singleton witness | No new randomized totality assertion found in inspected tests; policy domains and consequences use deterministic witnesses. |
| 9 | Load-bearing citation points to untracked evidence | Review briefing is an explicitly supplied untracked staging artifact. Production/context evidence for this review is committed at the candidate SHA; no untracked citation is used to support SM-1. |
| 10 | Diagnostic signpost misroutes the maintainer | SM-1: the new inheritance-owner signpost points away from the actual preview path. |
| 11 | Unsupported false-green arithmetic | No new probabilistic detector percentage relied upon; no mutation-measured claims made by this review. |
| 12 | Same-commit line references drift | Checked representative settings lock/gate references against the candidate. `apply.ts`'s settings lock reference still lands on `lockAccount` at 392–406. Historical plan references are not treated as current source proof. |
| 13 | Duplicated test asserts less than its comment | Input/catalog/schema tests have distinct boundary, transport and adapter roles. No additional high-confidence defect established. |
| 14 | Stale implementation/test counts | Catalog count remains seven proposables, four voice and three policy. Supplied gate counts remain attributed to the briefing; no new count claim substituted. |
| 15 | Departure from precedent is not explained | Shared writer, run spine, threshold/cap helper, transaction and provider-adapter precedents are named and used. |
| 16 | Evidence does not support suppression conclusion | No suppression removal or new bypass conclusion is justified from the supplied green fallow result. |
| 17 | Comment describes a false safety mechanism | SM-1's claimed preview dependency is disproved by immutable callers. |
| 18 | Test compares an array with its own derivation | Hand-counted consequence expected values and explicitly spelled writer field sets provide independent oracles; no new self-comparison found in inspected tests. |
| 19 | Wider set of fork-relative citations | Source conclusions use candidate symbols/lines. Historical plan line citations are not upgraded into current verification evidence. |
| 20 | Type-level guarantee attributed to wrong syntax | No new `as const`-versus-`satisfies` finding. General guarantee/ownership attribution issue is SM-1. |
| 21 | Hover panel is unreachable from trigger | No hover panel introduced; not applicable to changed interactions. |
| 22 | Duplicated media-query capability hook | No media-query hook introduced; not applicable. |
| 23 | Focus ring fails contrast on inverted surface | Inspected new confirmation style uses Console tokens. Numerical/browser contrast is not asserted by this source-only axis. No measured contrast finding. |
| 24 | Outside dismissal uses mouse-only event | No outside-dismissal listener introduced; native input/button interaction remains. |
| 25 | Documentation misstates actual rendered/source structure | New directory module descriptions match their broad responsibilities. SM-1 is the inaccurate source ownership statement. |
| 26 | Dead opacity transition/reduced-motion override | New CSS adds layout, focus and grouping rules; no transition or reduced-motion branch introduced. |
| 27 | Behavioral test coupled to sibling adjacency | Existing receipt definition-list adjacency assertions predate Run C. No new announcement/layout adjacency test defect established. |
| 28 | Negative assertion coupled to private screen-reader text | Inspected policy tests exercise affirmative scope/confirmation behavior; no new private-label-only safety oracle found. |
| 29 | Arithmetic/copy drift test hardcodes production arithmetic | Consequence expected counts deliberately use independent fixtures; shared predicate calls are separately pinned. No arithmetic-derived copy guarantee falsely claimed. |
| 30 | CSS comment explains the wrong positioning mechanism | No new absolute-positioning mechanism/comment introduced. |
| 31 | Host class separated from related rules | New policy/confirmation/expansion classes remain in the operator stylesheet beside related card rules. |
| 32 | Several structural mechanisms with no selection rule | Voice/policy use explicit domain distinctions; shared policy rendering has two consumers. No new competing UI mechanism established. |
| 33 | Verifier inventory count fails to bind identities | Mutation runner is unchanged in this candidate diff; root/finalizer owns the concurrent campaign. |
| 34 | Duplicate object renderers diverge on dictionaries | Provider walkers are deliberately provider-specific and captured-request tests check property maps. No current-schema dictionary divergence established. |
| 35 | Normalization witnesses ignore generated bounds | Voice input tests read `VOICE_FIELD_LIMITS`; strict provider tests inspect generated structures. No current bound inconsistency established. |

## Uncertain/non-blocking observations

None promoted. In particular, duplicated preview seed semantics and finite domain probes may deserve attention when those contracts change, but present tests and explicit references do not establish a current additional defect. This review does not request speculative abstractions or a broader refactor.

## Review method

Repository source/tests/docs were read with immutable `git show`, `git diff` and `git grep` against the candidate/fork. The supplied untracked `.feature/review-staging/review-brief.md` was read directly solely as the review contract after `git show` confirmed it is not tracked. Entry context and relevant agentic-platform, Next-app, worker-layout, reviews-import and live-DB rules were read. `pnpm agent:rules .feature/review-staging/standards-maintainability.md` returned `none`. Only this staging report was written.
