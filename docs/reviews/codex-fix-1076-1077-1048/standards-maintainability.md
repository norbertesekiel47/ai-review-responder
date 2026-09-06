# Standards and maintainability review

Base: `249389c7e16aa9b2efb0646f0f1b6b88410b017a`  
Reviewed HEAD: `27069fef26fb001ec5133fa41ec893521a2722f2`  
Axis: standards/maintainability, independently of correctness and database review.

## Verdict

**APPROVED.** No actionable finding reaches the required 80% confidence threshold.

The supplied contract and production diff were the scope authority. Source,
tests, standards, and documentation were read from the pinned commit, not the
concurrently mutable checkout. No tests, source edits, commits, remote actions,
delegation, or other reviewer conclusions were used. The supplied green gate
result was accepted; tooling-enforced issues were not re-audited. This is a
static maintainability approval, not browser verification or shipping approval.

## Standards and design assessment

- **Module depth and seam placement:** `loadCandidateWindow` remains the owner
  of bounded candidate hydration. The new private row type and map supply the
  existing `AskCandidate.matchedReview` contract; `evaluateAsk` retains policy
  precedence, and existing persistence owns the ask/run/refusal outcome. No
  second decision engine, writer, or public abstraction was introduced.
- **Locality and duplication:** the nearest precedent is the adjacent bulk
  prior-send read and map in `batch-builder.ts`. `attribution.ts` provides the
  scoped retained-review join and `REVIEW_STATUS.DELETED` precedent. Its public
  display reader has a different time window and return contract, so keeping
  this bounded eligibility query local avoids coupling it to presentation.
- **Generality and dependency growth:** no production file, manifest, runtime
  dependency, flag, migration, or configurable framework was added. The private
  fixture helper's options each support concrete deletion/date/tenant/history
  cases. The plan explains the integration-test volume and names precedents,
  satisfying the feature working rules' precedent and small-diff requirements.
- **Error handling:** database errors continue through the existing transaction
  failure path; no catch, silent fallback, or partial-write path was added.
  Missing evidence is an explicitly permitted domain state, represented by
  `matchedReview: null`. The new payload field is required and type-validated,
  using the existing incomplete-response error path rather than guessing false.
- **Naming and owner projection:** `archivedPeriodsTruncated` identifies a
  separate fact from entry truncation and refusal totals. It follows
  `RefusalLog.truncated`, the existing payload guard, and the report's note
  builders. ADR 0023's category-only projection remains intact; the additional
  response fact carries neither raw refusal codes nor contact details.
- **Tests and documentation:** live-DB tests inspect stored evidence, child
  runs, refusal joins, and replay stability; rendering tests assert visible
  disclosures, with positive counterparts to negative assertions. The existing
  unit SQL-result queues were minimally extended, while the new behavior is
  covered through the database seam. CONTEXT, currents, progress, plan, and the
  pre-merge architecture entry agree with the narrowed evidence rule and do
  not claim deployment. The architecture merge counter is untouched.

Authorities inspected: committed `AGENTS.md`, `.claude/CLAUDE.md`,
`.agents/skills/feature/references/working-rules.md`, relevant CONTEXT entries
(Withhold reason, Attribution match, Refusal, Restraint tab, Coverage start),
ADR 0023, and the nearest production/test precedents listed above.

## Accepted-finding checklist coverage

Every bullet of committed
`docs/reviews/finding-checklists/standards-maintainability.md` was checked.
Numbers below identify its bullets in their committed order; historical defect
classes are checks, not reasons to invent a new finding.

| # | Historical defect class | Assessment for this diff |
|---|---|---|
| 1 | Probabilistic totality witness misses singleton hole | No new property generator; new boundary and negative cases are deterministic. |
| 2 | Load-bearing citation targets untracked file | New plan and architecture claims use committed files/symbols; no equivalent untracked dependency found. |
| 3 | Misleading compiler-error signpost | No compiler diagnostic guidance or type-level assertion added. |
| 4 | Unsupported false-green probability arithmetic | No probability or mutation-success arithmetic added. |
| 5 | Architecture citation shifted by same commit | New architecture entry uses no source line-number citation. |
| 6 | Duplicate test claims two failures but asserts one | New cases cover distinct outcomes and assert the claimed persisted/rendered facts; no equivalent duplicate found. |
| 7 | Stale counting claims | The archival cap remains 200; no new executable-line or assertion-count claim is used. |
| 8 | Unnamed precedent or unexplained departure | Plan names existing note builders, truncation DTO, bulk query, attribution joins, and persistence tests. |
| 9 | Gate result cited as proof of removing suppression | No suppression is added/removed or defended by that inference; D1 concerns the pre-merge architecture entry only. |
| 10 | False anti-vacuity mechanism | No type-widening or anti-vacuity mechanism is introduced. New comments explain observable query/coverage behavior. |
| 11 | Test derives both sides from same array | Database fixtures and persisted outcomes are independent; expected boundary arithmetic uses the public cap, not production-derived periods. |
| 12 | Fork-relative stale plan citations | New plan cites symbols and paths rather than moved source line numbers. |
| 13 | Literal preservation attributed to wrong clause | No `satisfies`/literal-preservation explanation added. |
| 14 | Hover panel inaccessible across pointer gap | No hover panel, pointer region, or interaction geometry changed. |
| 15 | Duplicate media-query hook | No hook or capability predicate added. |
| 16 | Focus ring fails contrast on inverted surface | No focus styling, colors, or surface tokens changed. |
| 17 | Mouse-only outside dismissal misses taps | No dismissal or pointer event handling changed. |
| 18 | Documentation claims absent heading/ARIA structure | Documentation additions describe behavior and module ownership, not a new heading/ARIA structure. |
| 19 | Impossible opacity transition and redundant motion override | No CSS, transitions, or reduced-motion code changed. |
| 20 | Announcement test couples to sibling adjacency | New assertions do not depend on DOM sibling adjacency; existing note count is updated for an additional real note. |
| 21 | Negative test depends on private screen-reader string | New negative copy assertions have positive rendered-copy counterparts; no private screen-reader contract added. |
| 22 | Arithmetic-copy test hardcodes underlying constant | Archival boundary tests import `ARCHIVAL_EVENT_LIMIT`; new copy assertions contain no duplicated business arithmetic. |
| 23 | False absolute-position mechanism and magic offset | No positioning or dimension calculations changed. |
| 24 | Host CSS placed far from siblings with misleading BEM name | No stylesheet or class naming added. |
| 25 | Multiple structural mechanisms without selection rule | New disclosure uses the existing note-builder/notes-array mechanism consistently. |

APPROVED

