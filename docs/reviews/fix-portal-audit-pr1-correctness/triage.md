# Review triage — round 1

Both agents returned. Verdicts: **spec & correctness = PASS**,
**standards & maintainability = APPROVE with findings**. No blockers.

Full reports: `spec-correctness.md`, `standards.md`. Blast radius:
`blast-radius.md`.

## Accepted and fixed in this branch

| Finding | Source | Fix |
|---|---|---|
| `AUTO_APPROVAL_THRESHOLD_LABELS` exported with zero production consumers | standards | Made module-private as `THRESHOLD_LABELS`; `autoApprovalThresholdLabel` is now the whole interface. Test drops the storage-shape `toEqual` — the `Record<AutoApprovalThreshold, string>` annotation already fails to compile if the union widens without a label. |
| `autoApprovalThresholdLabel` typed `: string` but returns `undefined` out-of-domain | standards | Throws `unknown_auto_approval_threshold:<n>` instead. Unreachable today (migration 074 CHECK), but the sole producer is an unvalidated row cast, so schema drift would otherwise render the literal string "undefined". New test pins it. Follows "assert impossible states, don't branch around them". |
| JSDoc mis-cites `loadLocationsSettingsView` as precedent for looping | standards | Corrected. That module deliberately does one `ANY(...)` read *instead of* per-location queries. The comment now states the real accepted trade-off (N-wide concurrency → 3N sequential round trips, latency O(N)) and names batching as the better long-term shape, explicitly out of scope for a fan-out fix. |
| Competitors page-source test pins nothing, unlike its admin sibling | standards | Added an assertion that the page has not regrown its own `locations.map(... loadRivalPickerView)` loop. |
| `edge_cases[0]` names unset/`''`/`'   '`; unset unexercised | spec | Added the unset case, mirroring the owner suite. Helper widened to `string \| undefined` and uses `delete process.env.X` — assigning `undefined` would store the literal string `"undefined"` and test the wrong thing. |

Verified after fixes: 6 files / 63 tests green.

## Accepted, deliberately deferred

| Finding | Source | Disposition |
|---|---|---|
| `src/lib/config/server.ts:224` comment still documents the `??` vs `\|\|` divergence this PR closed | **both agents** | Real and worth fixing. `src/lib/config/server.ts` is outside `allowed_edit_surface`, and adding it is a second amendment, which the workflow treats as a stop-and-tear-down trigger, and is not auto-approvable (not inside a tree the surface already covers). Deferred to PR 2, which removes the divergence structurally and is therefore where the comment gets rewritten with accurate content rather than edited twice. Escalated to the owner. |

## Accepted as note, no action

| Finding | Source | Note |
|---|---|---|
| `types.ts` now carries schemas + branded types + constants + DTOs + UI copy (209 lines) | standards | Fine under "default is no new file", but this should be the last display label added there. If a fourth concern arrives, split. |

## Reviewer corrections to my own records

- **D4 overstated its justification.** I wrote that a shared `stripComments`
  helper "would need a home outside both `__tests__` directories" — but
  `src/__tests__/helpers/` exists. The conclusion still holds (not worth a file
  for 4 lines × 2 call sites), but the stated reason was wrong. Corrected in the
  deviations file.
- The spec agent empirically probed `stripComments` rather than reading it:
  it detects a reintroduced fan-out in both real pages, and misses only
  contrived cases where a string literal contains `//` or `/*`. Neither page
  contains such a literal. Accepted as adequate for a source-text guard.

## Not carried forward

No findings were rejected. Nothing appeared in either agent's low-confidence
appendix that changes the change.
