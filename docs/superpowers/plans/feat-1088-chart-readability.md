# feat/1088 — chart readability

Decision ticket [#1088](https://github.com/RepWorth/ai-review-responder/issues/1088) ·
build ticket [#1095](https://github.com/RepWorth/ai-review-responder/issues/1095) ·
map [#1084](https://github.com/RepWorth/ai-review-responder/issues/1084).

Owner's words, item 4: *"Improve the Graphs and Charts for observability and
understanding."*

## A measured starting point

"Improve" is a goal, not a change. One measurement turns it into a list:

| Chart | Lines | Accessible name? |
|---|---|---|
| `charts/VelocityChart.tsx` | 232 | **no** |
| `kpi/ReputationTrendChart.tsx` | 149 | yes |
| `kpi/RankingChart.tsx` | 160 | **no** |
| `kpi/RecentRatingBreakdown.tsx` | 61 | **no** |
| `kpi/RecentSentimentMix.tsx` | 74 | **no** |

**Four of five charts carry no `aria-label`, no `<title>` and no `role="img"`.**
To a screen reader they are nothing at all. That is the most defensible reading
of "observability and understanding", and it is measurable rather than a matter
of taste.

`ReputationTrendChart` already does it, so the precedent is in-tree.

## The line this ticket must not cross

**Presentation only.** ADR 0019 / #688 / #757 fix the **Review-time anchor**
`LEAST(review_date, detected_at)` for reputation metrics and `detected_at` for
workflow metrics, with `src/lib/kpi/fragments.ts` as single owner.

If a chart looks wrong because it BUCKETS wrongly, that is a separate
`RISK=high` data ticket. Do not quietly fix it here. `fragments.ts` is outside
the edit surface on purpose.

## Assumptions recorded, not asked

Reversible. Override on resume.

1. **Accessibility first** — an accessible name and a one-line description on
   every chart. Cheapest, most measurable, and it is the actual gap.
2. **Then units and windows.** A number with no unit and a chart with no stated
   window are the two "what am I looking at" failures a label fixes.
3. **A label beats a tooltip.** Where #1086 might have added a tip, prefer
   fixing the label here. That boundary is stated in both plans.
4. **Aggregate peers move with their per-location twin**, or they start
   disagreeing about what they show.
5. **No visual redesign** until the owner has seen one reworked chart.

## Do not duplicate the shared machinery

`chart-tokens.ts`, `ChartTooltip.tsx`, `useMeasuredSvg.ts`, `useNearestDatum.ts`
and `motion-presets.ts` are shared across charts. Changing one changes them all
— say which, deliberately.

## Suggested tracers

| # | Slice |
|---|---|
| T1 | Eval tests: accessible name, stated window, empty series, aggregate parity |
| T2 | The four silent charts get names and descriptions |
| T3 | Units and windows on screen |
| T4 | One reworked chart, screenshotted at 390px and 1440px, for the owner to react to |
| T5 | Aggregate peers brought into line |
| T6 | Docs + merge ledger |
