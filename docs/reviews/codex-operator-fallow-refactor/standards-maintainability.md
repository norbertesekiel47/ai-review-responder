# Standards and maintainability review

## Verdict

**PASS — no actionable findings at or above 80% confidence.**

Reviewed fixed base `87591310acb2a0a6edddd2bc8b5ff0cd24c9e301` against fixed HEAD `2ac6ff871b4496f996c37aaaaade9bdc7eee9a62`. All application source inspection used `git show` at those commits or their fixed diff; no mutable application source was reviewed. This is an independent static review, not a claim of runtime or Computer Use verification.

## Authority and scope

Read committed `AGENTS.md`, `.claude/CLAUDE.md`, `docs/agents/context-layout.md`, the Owner Operator glossary, the locked intake and plan, spec sections 5.2, 6.4 and 6.6, the applicable Next app and agentic-platform rules, and the entire standards-maintainability finding checklist. Also checked the CI/tooling rule and changed directory/evidence documentation. `pnpm agent:rules .feature/review-staging/standards-maintainability.md` returned `none` before this report edit.

The review covers all changed application files and the structured eval utility, plus the single evidence-runner exclusion and supporting documentation. It specifically evaluates extraction quality, locality, coupling, public surfaces, duplicated ownership, error behavior, and static UI/accessibility implications. The supplied full-gate and React Doctor results are background evidence, not checks rerun by this reviewer.

## Assessment

| Area | Assessment and fixed-source evidence |
| --- | --- |
| Apply seams | `apply.ts` keeps the voice and policy orchestrators explicit. `currentVoiceContract` narrows operation and token together; `resolveVoiceWriterFields`, `writeVoice`, and `recordVoiceApplied` separate input derivation, writer execution, and Receipt work. The policy equivalents preserve the existing `PolicyPlan` vocabulary. All new helpers are private, receive the existing transaction, and preserve the visible lock/revalidation/freshness sequence. No generalized execution framework or duplicate transaction owner appears. |
| Restore seams | `restore.ts` separates selection, source validation, pending-proposal reuse, and policy preparation. `createRestoreProposalInTransaction` still visibly owns scope locks and actor checks before source resolution. `restore-inputs.ts` separates source-operation validation, Receipt validation, and inverse derivation without exposing the helper types/functions. These names describe actual domain stages. |
| Shared projections | `proposals.ts` introduces `policyCardFacts` with two real callers: ordinary policy proposals and Restore policy proposals. This removes a genuine repeated projection while retaining separate descriptions and validation paths. Voice Restore wording has a narrow local helper. |
| Snapshot projection | `policy-state.ts` extracts the location-specific snapshot fields with an explicit `Pick<PolicySnapshot, ...>` return type. The helper preserves parent and location Version-token ownership and suspension handling. It does not become another settings reader or writer. |
| Hydration | `reads.ts` retains tenant-scoped loading, insertion order, missing-reference behavior, and duplicate replacement semantics. The local reference list trades bounded temporary arrays for simpler traversal over the same transcript. No second repository or injected-client bypass appears. |
| Fenced completion | `turns.ts` moves the complete Restore request/turn consistency predicate into a private assertion with the same exception and call position. Request ordering and mutation ownership stay in the original function. |
| Route gates | `gate.ts` is the existing shared gate owner, and the new read helper has both GET consumers. Read/write semantics remain visibly separate. The Apply and Restore response mappers remain local, exhaustive transport adapters; they add no business-policy decision or exported handler contract. |
| UI hook ownership | `useOperatorConversation.ts` now owns the explicitly planned screen/scope state and timeline refresh callbacks. Its two added exports are consumed by `OperatorClient`; existing exports are preserved. The callbacks retain stable state setters and relevant dependencies. The named hooks are narrow screen composition helpers rather than speculative reusable APIs. |
| Write lifecycle | `useProposalWrites.ts` separates request construction from response interpretation while retaining the in-flight guard and `finally` cleanup in the hook. The callback adapter keeps server-row repaint, refusal errors, disabled handling, and successful transcript refresh in their original order. No swallowed exception or new retry policy is introduced. |
| Static UI/accessibility | The extracted `PreparedProposal` and `RestoreProposalAction` render the same DOM, buttons, labels, disabled conditions, error descriptions, and callbacks. `TurnBody` retains its exhaustive segment switch, placement tracking, and expansion ordering. No CSS, focus-ring, pointer-event, motion, or ARIA relationship change appears. |
| Tests and utility | Existing test assertions are untouched. `structured-runner.ts` shares the same proposal-zero reference check between its two actual callers and preserves the other checks and failure ordering. No new test directly couples to the private helper names or structure. |
| Scope and tooling | No new production file, dependency, schema, model schema, flag, threshold, or production suppression appears in the fixed diff. The single new ignore pattern is the authorized evidence-runner pattern. Directory rows accurately describe the moved owners; candidate documentation does not claim a merge or completed verification. |

The extractions do increase helper count and call depth, but the boundaries correspond to preparation, validation, projection, execution, or transport stages already present in the code. Under the locked extraction-only plan, that is not evidence of metrics laundering. No actionable correction is warranted merely to reverse those authorized extractions.

## Every-line checklist disposition

Each row corresponds to one accepted-finding bullet, in the committed checklist's order. “Absent” means this change does not introduce that defect class; it does not certify unrelated existing code.

| # | Checklist defect class | Disposition |
| --- | --- | --- |
| 1 | Probabilistic totality witness and incomplete comment | Absent: no property generator or totality assertion changed. |
| 2 | Load-bearing citation to an untracked audit | Absent in added review claims: no such audit citation added. |
| 3 | Diagnostic signpost naming the wrong compiler error | Absent: no diagnostic signpost added. |
| 4 | Unsupported false-green arithmetic | Absent: no probability claim added. |
| 5 | Newly stale architecture-log line citations | Absent: the added architecture row uses descriptions, not moved line numbers. |
| 6 | Duplicate test with a stronger promise than its oracle | Absent: existing assertions unchanged; the eval extraction preserves its actual oracle. |
| 7 | Incorrect executable-line or assertion counts | No new source comment contains such counts; supplied gate/churn counts are not independently re-certified here. |
| 8 | Unnamed precedent or undocumented departure | Existing owners and the locked plan identify the extraction seams; `gate.ts` retains its named route-adjacent precedent. |
| 9 | Suppression-present result misrepresented as removal evidence | Absent: no production suppression removed or added, and the plan distinguishes runner archival from the new exclusion. |
| 10 | False anti-vacuity mechanism | Absent: no type-level anti-vacuity claim changed. |
| 11 | Test derives both sides from the same input | Absent: no assertion rewrite; the eval helper retains an independent fixed index-zero requirement. |
| 12 | Fork-relative stale plan citations | No new source-line citations in the locked plan's extraction instructions. Historical audit bases are explicitly labeled fallbacks. |
| 13 | Incorrect attribution of literal preservation | Absent: no new claim about `as const` versus `satisfies`. |
| 14 | Hover panel unreachable by pointer | Absent: no hover target, panel, or pointer handler changed. |
| 15 | Duplicate capability hook with divergent predicates | Absent: extracted hooks relocate the original screen logic; no parallel location/capability predicate owner is added. |
| 16 | Inadequate focus-ring contrast | Absent from this diff: no styling or focus ring changed. |
| 17 | Mouse-only dismissal on touch | Absent: no dismissal listener changed. |
| 18 | Documentation falsely claims heading/ARIA structure | Absent: directory changes describe state and transport ownership, not invented DOM semantics. |
| 19 | Transition cannot run despite reduced-motion override | Absent: no animation or CSS changed. |
| 20 | Test asserts DOM adjacency instead of announcement | Absent: tests unchanged. |
| 21 | Negative tests depend on a private screen-reader string | Absent: tests unchanged; moved controls retain their accessible text. |
| 22 | Copy test hardcodes arithmetic or uses weak text matching | Absent: no copy assertion changed. |
| 23 | False flex-position explanation and coupled magic offset | Absent: no layout explanation or offset changed. |
| 24 | Host style distant from siblings with misleading ownership | Absent: no styles moved or added. |
| 25 | Multiple structural mechanisms without a selection rule | New components/hooks have specific owners and the plan names their seams; no competing mechanisms for the same UI behavior appear. |
| 26 | Verifier count not bound to inventory identities | Absent: no verifier implementation changed in this diff. Adversarial runtime evidence is outside this review. |
| 27 | Duplicate object renderers diverge on dictionary signatures | Absent: `policyCardFacts` consolidates the actual repeated projection; no second schema/object renderer is introduced. |
| 28 | Normalization witness ignores generated constraints | Absent: no normalization witness or constraint assertion changed. |
| 29 | Policy projection comment names wrong inheritance owner | Absent: added projection comments describe their actual local fields; no claim reassigns preview/read ownership. |
| 30 | Catalog test description omits prepare operations | Absent: catalog/test descriptions unchanged; new Restore comments describe preparation rather than execution. |

## Limitations and non-findings

- No tests, build, browser session, or external writes were run for this review. The only edit is this report.
- Computer Use evidence at 390 and 1440 pixels remains unavailable as stated in the review brief. Static markup preservation is not a substitute for that verification.
- No speculative concern is promoted to a finding. The broader conversation-module responsibility is an explicit locked-plan choice, and the fixed diff supplies no concrete maintenance failure that would justify requiring another architecture change.
- The branch's pending adversarial and release work is not certified by this axis's PASS.
