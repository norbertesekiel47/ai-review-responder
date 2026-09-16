# Run E branch review — standards and maintainability, round 1

Native Codex independent review of candidate `890eea76c8c04b8d2acfcc73a895ec3112560e38` against base `30896acbcb2ee127131504e531f230fcfc7e4409`. All implementation reads used `git show` or `git diff` at these immutable revisions. The supplied production churn is 1,648 lines. The root supplied full-gate GREEN fingerprint `032ea19aff8d9915e94c6c16fbab2cc037c2551bf344a67aa00c07baead3f9bd`; this reviewer did not rerun or independently certify that gate.

**Verdict: APPROVE WITH ONE LOW-SEVERITY NIT.** No blocking standards or maintainability defect found. No source edits, tests, external mutations, or delegation were performed. This verdict does not certify staging, browser journeys, migration promotion, postmerge documentation, or the human pilot; those remain pending as stated in the review brief.

## Actionable finding

| ID | Severity / confidence | Candidate file and line | Named standard | Concrete scenario and evidence | Smallest correction |
| --- | --- | --- | --- | --- | --- |
| E-M1 | Low (P3), 100% | `src/lib/agents/operator/__tests__/catalog.test.ts:172` (related title at 171 and comment at 183) | Accepted standards checklist, line 14: counting claims must match the changed contract; comments must describe the asserted mechanism accurately. | Run E adds `prepare` as a fourth catalog kind and line 176 explicitly asserts four kinds. The adjacent explanation still says “Three kinds,” the title enumerates only read/proposable/capture, and the narrowing comment omits prepare. A maintainer reading this discriminator test is therefore given the old taxonomy at the very test documenting the new one. This is a documentation defect, not a failing behavior or broken assertion. | Replace the counted opening with “The kind discriminant separates proposables from reads, captures and preparation requests,” and include preparation in the title and narrowing comment. Avoid a redundant numeric count. |

## Scope and findings rationale

- Restore preparation has a cohesive shared entry point used by the route and fenced worker completion. It reuses proposal persistence, account-scoped readback, catalog inverse derivation and the existing Apply protocol. No second settings writer or parallel proposal engine was introduced.
- `restore-inputs.ts` separates untrusted ordinary operation inputs from historical receipt derivation. Invalid envelopes and receipts become an explicit unavailable inverse; these catches do not hide infrastructure failures. The new route catch reports unexpected failures, and ledger/writer failures propagate through the caller transaction.
- Policy restore enters the existing transaction writer with a narrow server-only operation. Ordinary request/form schemas stay separate. No new provider integration, dependency, framework or top-level directory appeared.
- Refusal reason/lane/category/wording decisions have one exhaustive map. Stored refusal identities are materialized after the turn fence through the sole ledger writer. Rendering consumes the closed reason mapping; the Restraint presentation remains category based.
- UI history reuses `ProposalCard`, existing request helpers and the shared write guard. Per-instance `useId` prevents duplicate accessible IDs for a persisted proposal shown in multiple places. Timeline loading/error/retry and aborted stale-scope reads have observable component assertions. No new hover surface, pointer-dismiss mechanism, animation or CSS contrast change is implicated by this diff.
- Tests exercise public preparation/Apply/readback and actual persisted state in addition to isolated mapping tests. The integration tests check unrelated-field preservation, exact custom dials, rollback after a post-write error, distinct refusal identities, lost fences, durable cross-turn references and pagination with sub-millisecond timestamps. Lock-order tests include database-observed blocking and before/after state assertions; they do not claim transaction correctness from mock invocation order alone. No new self-comparison or random-only totality oracle was identified.

## Complete accepted-checklist pass

Read every entry of pinned `docs/reviews/finding-checklists/standards-maintainability.md` (lines 8–36). The line numbers below cover every entry exactly once; “not introduced” means no corresponding changed mechanism was found, not a claim to have rerun the historical experiment.

| Checklist line(s) | Defect classes checked | Result |
| --- | --- | --- |
| 8, 11 | Random totality holes and unsupported probability arithmetic | No added random totality test or probabilistic success claim. |
| 9, 12, 19 | Untracked authority, fork-relative or moving citations | No implementation authority depends on an unavailable review report. The plan explicitly labels staged review reports and later evidence as pending; its precedent references describe the planning baseline. |
| 10, 17, 20 | Incorrect diagnostic/type-system mechanisms | No new compile-time assertion or diagnostic explanation of this kind. |
| 13, 18 | Duplicate weak tests and expected/actual derived from the same value | New unit checks have independently supplied expected values; integration checks assert actual persisted behavior. No same-array ordering oracle found. |
| 14 | Incorrect counting statements | E-M1 above. |
| 15 | Unnamed precedent or unexplained departure | Plan names existing catalog, Apply, settings-writer, proposals and refusal-writer seams. Restore separation has an explicit shared-caller justification. |
| 16 | Deviation claims exceeding their evidence | D-E2 expressly supersedes the earlier observation-window history and avoids claiming a completed full-day observation. Migration121 and staging evidence remain pending. |
| 21, 23, 24, 26, 30, 31 | Hover reachability, focus contrast, pointer dismissal, ineffective motion, CSS mechanism/locality | No corresponding new interaction/CSS mechanism; no concrete implicated defect found. |
| 22, 32, 34 | Duplicate capability hooks, inconsistent host mechanisms, divergent object renderers | Existing card/request/writer seams are reused. No divergent duplicate renderer or helper behavior found. |
| 25 | Claimed accessibility structure absent from markup | New cards retain named regions/groups; per-instance accessible IDs are explicitly tested. No new unsupported all-host claim found. |
| 27, 28, 29 | DOM adjacency coupling, ineffective private-string negatives, arithmetic disconnected from copy | UI tests chiefly use roles, headings and observable requests. Refusal/Restore negative checks have positive rendering oracles. No arithmetic-copy assertion was added. |
| 33 | Mutation inventory identities not bound | Verifier implementation is outside this candidate diff; no mutation verifier was run or claimed by this reviewer. |
| 35 | Boundary witnesses ignoring generated constraints | Empty operation-input objects receive schema acceptance/rejection tests; ordinary model schemas remain strict. No new generated-boundary witness with hand-copied length limits found. |
| 36 | Policy projection comment names wrong owner | Run E preparation/Apply use `readPolicySnapshot`; no new claim that the summary projection owns preparation inheritance. |

## Speculative notes

None promoted. The duplicated-looking clear preview expression is small, co-located in the catalog, and currently agrees with the shared writer; a possible future divergence alone does not justify an actionable finding or a new abstraction. Actual browser layout and accessibility results remain the root's pending deployment verification, not inferred from component tests.
