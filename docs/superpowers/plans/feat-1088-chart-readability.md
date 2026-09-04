# feat/1088 — chart readability

Decision ticket [#1088](https://github.com/RepWorth/ai-review-responder/issues/1088) ·
build ticket [#1095](https://github.com/RepWorth/ai-review-responder/issues/1095) ·
map [#1084](https://github.com/RepWorth/ai-review-responder/issues/1084).

Owner's words, item 4: *"Improve the Graphs and Charts for observability and
understanding."*

## A measured starting point — CORRECTED 2026-09-04

> **The measurement this section originally carried was wrong, and it was the
> ticket's whole justification.** It claimed four of five charts were "nothing at
> all" to a screen reader. The grep behind it searched `aria-label`, `role="img"`
> and `<title>`, and missed the `sr-only` table pattern two charts use. Corrected
> table below; full record in the deviations file. Tracer T2 as originally
> written had no work in it and is replaced.

"Improve" is a goal, not a change. The corrected measurement:

| Chart | Lines | Reachable by a screen reader? | Mechanism |
|---|---|---|---|
| `charts/VelocityChart.tsx` | 232 | **yes** | `sr-only` `<table>` + `<caption>`, SVG `aria-hidden` (L76) |
| `kpi/RankingChart.tsx` | 160 | **yes** | same pattern (L72) |
| `kpi/ReputationTrendChart.tsx` | 149 | yes | `role="img"` + `aria-label` (L91) |
| `kpi/RecentRatingBreakdown.tsx` | 61 | yes | per-row `aria-label`, visuals `aria-hidden` (L40) |
| `kpi/RecentSentimentMix.tsx` | 74 | yes | same per-row pattern (L55) |

**Every chart already speaks.** `.sr-only` is Tailwind v4's built-in
visually-hidden utility (`globals.css:1`), so those two tables are hidden from
sight and present in the accessibility tree — and they expose the FULL data
series, which is a stronger affordance than the `aria-label` summary this plan
first proposed to copy onto them.

So the gap is not silence. It is that **what the charts say is incomplete**: they
give numbers without a unit and without a period. That is still measurable, and
it is still the most defensible reading of "observability and understanding".

## The six gaps this ticket closes

Each one verified in the file, each one presentation-only.

| # | Gap | Where | Intake line |
|---|---|---|---|
| G1 | No `sr-only` caption states a window. The reader gets every number and no period; "last N weeks" sits in the card header, outside the table. | `VelocityChart.tsx:77`, `RankingChart.tsx:73`, `AggregateVelocityCard.tsx:119` | behavior 3 |
| G2 | `VelocityChart`'s y-axis ticks are unitless — bare `0`, `max/2`, `max`. The sr-only cells say "N reviews"; the sighted reader gets a bare number. | `VelocityChart.tsx:111`, `AggregateVelocityCard.tsx:147` | behavior 2 |
| G3 | The aggregate and per-location velocity charts disagree on week labels — `weekShortLabel` vs raw ISO `weekStart`, and the stacked chart draws no x labels at all. | `VelocityChart.tsx:179` vs `AggregateVelocityCard.tsx:129` | behavior 4, invariant 2 |
| G4 | `RecentRatingBreakdown` and `RecentSentimentMix` state different windows while sitting side by side — "in the selected period" (windowed aggregate, #405) vs "your N most recent reviews" (sample). | `RecentRatingBreakdown.tsx:31`, `RecentSentimentMix.tsx:48` | behavior 4 |
| G5 | `RankingChart` states no window anywhere, on screen or in its caption. | `RankingChart.tsx:73` | behavior 3 |
| G6 | Neither `Recent*` chart carries a chart-level name — the rows speak, the chart does not. Adding one must not make the rows speak twice. | `RecentRatingBreakdown.tsx:25`, `RecentSentimentMix.tsx:42` | behavior 1 |

`ReputationTrendChart` is the precedent for stating a window inline
(`spanLabel`, L58/L78/L92) and it is the only chart that already does it in all
three places: heading, sub-label and accessible name.

## The line this ticket must not cross

**Presentation only.** ADR 0019 / #688 / #757 fix the **Review-time anchor**
`LEAST(review_date, detected_at)` for reputation metrics and `detected_at` for
workflow metrics, with `src/lib/kpi/fragments.ts` as single owner.

If a chart looks wrong because it BUCKETS wrongly, that is a separate
`RISK=high` data ticket. Do not quietly fix it here. `fragments.ts` is outside
the edit surface on purpose.

## Assumptions recorded, not asked

Reversible. Override on resume.

1. ~~**Accessibility first** — an accessible name and a one-line description on
   every chart.~~ **Void, 2026-09-04.** Every chart already carries one. What is
   missing is not the name but the unit and the window inside it.
2. **Units and windows first, then.** A number with no unit and a chart with no
   stated window are the two "what am I looking at" failures a label fixes, and
   with assumption 1 void they are the whole ticket.
   **2b. An empty chart that renders nothing stays rendering nothing.** Both
   `Recent*` charts `return null` at `total === 0` so the caller can drop the
   slot cleanly, and that is deliberate (owner, 2026-09-04). The intake's
   empty-series edge case re-points at `ReputationTrendChart`, whose empty state
   exists but names neither its unit nor its window.
3. **A label beats a tooltip.** Where #1086 might have added a tip, prefer
   fixing the label here. That boundary is stated in both plans.
4. **Aggregate peers move with their per-location twin**, or they start
   disagreeing about what they show.
5. **No visual redesign** until the owner has seen one reworked chart.

## Do not duplicate the shared machinery

`chart-tokens.ts`, `ChartTooltip.tsx`, `useMeasuredSvg.ts`, `useNearestDatum.ts`
and `motion-presets.ts` are shared across charts. Changing one changes them all
— say which, deliberately.

## Tracers — re-cut 2026-09-04 against the six gaps

T2 originally read "the four silent charts get names and descriptions". No chart
is silent, so it is replaced. The count and the ordering hold: T1 is still the
eval task, T4 is still the owner's first look before the rest are touched.

| # | Slice | Closes |
|---|---|---|
| T1 | Eval tests: stated window, unit on the axis, empty-state naming, aggregate parity, values unchanged | — |
| T2 | Every chart states its window where it speaks — `sr-only` captions and `RankingChart`'s missing window | G1, G5 |
| T3 | Units on screen: `VelocityChart`'s y-axis stops being bare numbers | G2 |
| T4 | **One reworked chart, screenshotted at 390px and 1440px, for the owner to react to** | — |
| T5 | Aggregate peers brought into line: week labels agree, and the two `Recent*` charts stop disagreeing about their window; chart-level names added without double-labelling the rows | G3, G4, G6 |
| T6 | Docs + merge ledger |

**T4 still gates T5.** Five charts redesigned before the owner has reacted is the
failure mode the ordering exists to prevent, and the corrected measurement does
not change that.
