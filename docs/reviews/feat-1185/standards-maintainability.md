# #1185 — Standards and maintainability review

VERDICT: APPROVED

- BASE: `07aef7a73c80f4d28d091316270325d5a584dbb9`
- HEAD: `0b374b6a9b76ac4eee3222d84b47eae3e359bf4d`
- Production churn: **131 added + deleted lines**, **25 production files**: 23 mechanical route-wrapper swaps, the existing auth helper, and the proxy. This uses the coordinator's correction to the brief's file count.
- Supplied full green gate: `8ab55944`. No tests were rerun by this reviewer; green-tool-enforced issues were excluded absent evidence of circumvention.
- Sources: supplied pinned review brief and full diff; additional production reads used only `git show HEAD:path` with the full pinned SHA above. Live production files were not reviewed. Path-rule lookup for this report returned `none`.

## Findings

None meeting the required 80% confidence and actionable-defect threshold.

## Standards assessment

The codebase-design deletion test supports the new wrapper: deleting it would spread the same transport/CSRF decision across 23 route exports. Its existing variadic handler interface carries real route context without extra configuration or new caller obligations beyond the documented admin gate requirement. The cookie arm delegates to the unchanged owner wrapper, preserving one owner of same-origin failure handling. The transport parser remains the existing shared owner; the proxy does not acquire a second token grammar or identity verifier.

The proxy's added branch is a small orchestration step after CORS and before cookie-client construction. Under repository invariant 12, it does not justify a new module for a short refusal/forwarding branch. Repeating the response envelope at the proxy and wrapper does not duplicate the token policy: both use the shared parser and cache constant, while each owns its response seam. No new file, dependency, configurable abstraction, database import, or writer is introduced. This follows repository working rules and the approved ADR 0025 D6–D8 / ADR 0026 D7 scope.

Tests exercise the same public interfaces used by callers: `proxy`, the exported wrappers, and channel mutation exports. Header forwarding, cookie-client avoidance, no-store refusal, handler arguments/results, and propagation of handler errors have independent observable assertions. The channel test uses the canonical gate mock as an interaction seam and verifies that its refusal prevents all mutation helpers; its success result does not establish live identity or AAL2 enforcement. Existing binding tests retain ownership of individual channel configuration. The new tests add deterministic cases rather than probabilistic witnesses or source-text assertions.

## Supplied checklist coverage

Every line in `docs/reviews/finding-checklists/standards-maintainability.md` was checked, in its supplied order. “Not present” means the defect class has no instance introduced by this diff.

| # | Checklist defect class | Assessment |
|---|---|---|
| 1 | Probabilistic totality witness misses a seeded hole | Not present; added cases are deterministic. |
| 2 | Load-bearing citation targets untracked evidence | No such new citation identified in the supplied plan, deviations, or architecture entry. |
| 3 | Diagnostic signpost directs readers to the wrong error | Not present; no compiler-diagnostic signposts added. |
| 4 | Unsupported or conflicting false-green arithmetic | Not present; no detection probabilities claimed. |
| 5 | Architecture-log line citation shifts in the same commit | Not present in the added entry; it cites ADR decisions and named helpers. |
| 6 | Duplicate test claims two error names but checks one | Not present; new refusal assertions explicitly check status/body and downstream non-execution where relevant. |
| 7 | Incorrect counting claims | Corrected review metadata to 25 files and 131 churn lines; committed production documentation adds no comparable executable-line claim. |
| 8 | Unnamed precedent or unjustified departure | Plan names the transport helper, existing variadic wrapper, downstream-header builder, and route-binding tests. |
| 9 | Deviation overstates what its evidence establishes | D1 describes a ledger-only initial gate failure; D2 describes approved report-path bookkeeping, without claiming runtime verification. |
| 10 | Anti-vacuity comment names the wrong type mechanism | Not present; no new compile-time assertion mechanism. |
| 11 | Test derives both sides from the same filtered value | Not present; expected HTTP outcomes, header values, and helper-call effects are independently asserted. |
| 12 | Plan citations resolve only at the fork point | No new numeric source-line citations in the plan. |
| 13 | Type-level guarantee credited to the wrong clause | Not present. |
| 14 | Hover panel cannot be reached across trigger gap | Not applicable; no UI change. |
| 15 | Existing capability helper is reimplemented | Transport presence/shape helpers and the cookie CSRF wrapper are reused. |
| 16 | Focus ring contrast fails on an inverted surface | Not applicable; no UI or styling change. |
| 17 | Mouse-only outside dismissal misses touch | Not applicable; no event-listener change. |
| 18 | Directory documentation claims a nonexistent structure | Updated auth rows match the new wrapper and shared-parser callers. |
| 19 | Dead transition and misleading reduced-motion handling | Not applicable; no animation change. |
| 20 | Test couples behavior to incidental sibling adjacency | Not present; no DOM assertions. |
| 21 | Negative assertion depends on a private display string | Not present; HTTP response strings are public contracts, and denial tests check non-execution. |
| 22 | Copy/arithmetic test hardcodes the same computation | Not present; no derived-copy assertion or arithmetic change. |
| 23 | Comment explains a false layout mechanism or magic offset | Not applicable; no layout change. New transport comments distinguish parsing from canonical verification. |
| 24 | Host definition placed remotely or named as unrelated child | Not present; wrapper is beside its existing counterpart and route exports remain local. |
| 25 | Multiple structural mechanisms lack a selection rule | Explicit selection rule: admin mutations use the bearer-aware wrapper; owner and impersonation mutations retain the existing wrapper. |

## Uncertainty appendix

- This is a bounded static maintainability review. Runtime authentication, deployed header behavior, and desktop/mobile journeys remain the owning verification lanes' responsibility; no browser or live-auth result is claimed here.
- The supplied green gate is treated as evidence supplied by the coordinator, not independently reproduced. No live-tree mutations, tests, commits, or external actions were performed by this reviewer.
- Existing generic route comments saying same-origin is enforced at the export remain shorthand for cookie CSRF. The adjacent explicit wrapper name and its documented transport contract make this insufficient for an actionable finding; the review does not interpret those comments as a promise that bearer requests require same-origin.
# Approved verifier continuation review — 2026-09-09

Independent fresh reviewer `verifier_change_review` inspected only the new budget mechanism, tests and D3. P2 V1185-1: candidate count alone did not prove original inventory identity. Root verdict: ACCEPT; pin the SHA-256 of ordered `{id,file,test}` identities and reject a same-length replacement. Fixed, focused budget suite 20/20 green; reviewer re-read and returned APPROVED with no remaining correctness or security findings. Initial full runner safety suite was 52/52 green before adding the replacement regression. Existing auth implementation conclusions below are unchanged.
