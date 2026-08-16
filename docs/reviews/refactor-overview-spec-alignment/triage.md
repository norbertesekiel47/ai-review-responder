# Review triage — round 1

Orchestrator verdicts on both axes. Full reports: `spec-correctness.md`,
`standards-maintainability.md`. Spec agent's overall verdict: **faithful
implementation of the intake contract and §5** — no behavioural defect, no surface
drift, all 13 `tests_to_add` present, all 8 `edge_cases` and 8 `invariants` satisfied.
Every finding below is test-strength or docs.

| # | Source | Sev | Finding | Verdict |
|---|---|---|---|---|
| A1 | Std F1 | High | `pool-fanout-sequential.test.ts:116-124` — the new #773 guard never dispatches the metrics query: `makeConcurrencyTrackingSql()` defaults to zero rows, so `businessIds` is empty and the CTE is skipped. Peak is measured over 2 queries, not the "rows → COUNT → metrics" its comment claims; a `Promise.all([count, metrics])` regression would pass. | **ACCEPT** — a guard that doesn't guard is worse than none, because it reads as coverage. Seed the queue. |
| A2 | Spec | Med | `overview-service.test.ts:406-455` — the comparator's `pendingApprovalCount desc` tier lost its only test pin in the T4 split. `origin/main`'s sort test discriminated it (pending 5 vs 2 at equal score 6); both replacements use all-zero or all-equal pending, so deleting tier 2 from the production comparator now fails nothing. | **ACCEPT** — directly violates `invariants[7]`, which was written to preserve exactly this tier. The strongest finding of the round: the split improved tie-tier precision and silently lost a different tier. |
| A3 | Std F2 | Med | `overview-service.ts:71-72,185` — `OverviewData.responseMetricsWindowDays` is dead payload; §5.3 deleted its only consumers (Overview's two window-labelled columns). | **ACCEPT** — §5 is explicitly a payload fix; shipping a field with no reader contradicts it. Composes with A4. |
| A4 | Std F3 + Spec | Med | `overview-service.test.ts:523-562` — orchestrator Finding A confirmed, and **wider than I recorded**: beyond the trailing-window `FILTER`s, the `awaiting_owner_connect` literal, `pending_reconnect_count` and `last_activity` are also pinned only via `sqlCalls[5]` reached through `getAdminOverview`. `business-summary.test.ts:252-257` did not carry them. | **ACCEPT** — coverage intact, ownership inverted. Editing `business-summary.ts` must not break the *Overview* suite; single ownership is the point of this PR. |
| A5 | Spec | Low | `overview-service.test.ts:434-455` — the tie test cannot separate the **name** tier from the **id** tier: ids `biz-z`/`biz-a` order identically to `Zulu Co`/`Alpha Co`, so dropping `a.name.localeCompare(b.name)` still passes. Score and pending are correctly equal; the id correlation is the residual. | **ACCEPT** — cheap to fix (anti-correlate the ids) and prod ids are UUIDv7, uncorrelated with name. |
| A6 | Std F4 | Low | `overview-service.ts:82` "as `buildBusinessSummary` above" and `business-summary.ts:106` "the overview characterization tests" — both name things this branch moved. | **ACCEPT** — this repo's comments are load-bearing; a stale pointer is worse than none. |
| A7 | Std F5 | Low | `overview-service.ts:136,142` vs `:160` — the 6th sequential await carries the `react-doctor-disable` idiom with a #773 reason; awaits 2 and 3 in the same function, same rule, same justification, warn unsuppressed. | **ACCEPT** — trap 2 of the locked brief says to suppress this rule deliberately. Half-suppressing reads as an oversight. |
| A8 | Spec | Low | `docs/directory.md:161,340` still document `getAdminBusinessesList`, deleted by this PR. T5 fixed the `src/lib/admin/` rows only. | **ACCEPT** — repo rule: grep the filename, clean every cross-reference in the same change. |
| A9 | Std F6 | Low | `BusinessesClient.tsx:32-42` — `formatRelative` relocated into a page client rather than `src/components/admin/ui/format.ts`, which declares itself the admin console's single formatter. | **REJECT** — see below. |

## A9 rejection reasoning

The finding is right about the ideal home, and wrong about the cost here.

1. **There is no live duplication.** T3 copied `formatRelative` into `BusinessesClient.tsx` and T4 deleted the original from `OverviewClient.tsx` in the same PR. Exactly **one** copy exists on this branch. The finding describes placement, not redundancy.
2. **The fix needs a second `allowed_edit_surface` amendment.** `src/components/admin/ui/format.ts` is not in the surface (only `HealthBadge.tsx` and its test were added, under owner approval). The workflow's abort criteria make a 2nd amendment a branch-teardown trigger — a cost wildly out of proportion to a 10-line formatter's file location.
3. **It is not a regression.** `formatRelative` lived in a page client on `origin/main` too. This PR moved it between page clients; it did not create the placement.

Recorded as a follow-up: fold `formatRelative` into `src/components/admin/ui/format.ts`
the next time that file is legitimately open. Noted so it is not lost.

## Disposition

8 accepted, 1 rejected. All 8 fixes land inside the existing surface. No finding
touched behaviour — the shipped code does what §5 specifies; the round bought
test strength (A1, A2, A5), correct test ownership (A4), a smaller payload (A3),
and comment/doc accuracy (A6, A7, A8).
