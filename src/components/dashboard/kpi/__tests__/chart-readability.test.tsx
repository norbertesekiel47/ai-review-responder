// @vitest-environment jsdom
//
// feat/1088 — the executable spec for chart readability (tracer T1).
//
// These five titles are the ticket's promised tests and are matched verbatim by
// the run's `promised-tests` gate row. Four of them are RED on purpose: they
// describe the six gaps the later tracers close. The fifth is the regression
// pin that must stay green throughout, because it is what makes a
// presentation-only ticket safe.
//
// Scope: PRESENTATION ONLY. Nothing here asserts bucketing, windowing
// arithmetic, or the Review-time anchor `LEAST(review_date, detected_at)` —
// `src/lib/kpi/fragments.ts` owns those and is outside this edit surface. A
// chart that BUCKETS wrongly is a separate RISK=high ticket, not this one.
//
// Why a new file rather than an existing one: `VelocityChart.test.tsx` is
// scoped to one component plus its pure math, and `ReputationTrendChart.test.tsx`
// to the D36 span label of one chart. Every title below spans five charts and
// two card wrappers, and title 4 is required to live under `kpi/__tests__/`,
// so neither existing file fits without breaking its single-component scope.

import { cleanup, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AggregateVelocityCard } from '@/components/dashboard/aggregate/AggregateVelocityCard';
import { RankingChart } from '@/components/dashboard/kpi/RankingChart';
import { buildRankingSeries } from '@/components/dashboard/kpi/RankingChart.helpers';
import { RecentRatingBreakdown } from '@/components/dashboard/kpi/RecentRatingBreakdown';
import { RecentSentimentMix } from '@/components/dashboard/kpi/RecentSentimentMix';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import type {
  AggregateDashboardData,
  DashboardDataActive,
  RatingBreakdown,
  ReputationSummary,
} from '@/lib/dashboard/types';

// ---------------------------------------------------------------------------
// Fixtures — fixed input, so "the values it plots" is a comparable constant.
// ---------------------------------------------------------------------------

/** Ascending weekly bucket keys in the `YYYY-MM-DD` shape the dashboard emits. */
function weekStarts(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 5, 1 + i * 7)).toISOString().slice(0, 10),
  );
}

const VELOCITY_WEEK_KEYS = weekStarts(3);

const VELOCITY_WEEKS: DashboardDataActive['reviewVelocity'] = [
  { weekStart: VELOCITY_WEEK_KEYS[0]!, count: 4 },
  { weekStart: VELOCITY_WEEK_KEYS[1]!, count: 9 },
  { weekStart: VELOCITY_WEEK_KEYS[2]!, count: 6 },
];

const PER_LOCATION_VELOCITY: AggregateDashboardData['perLocationVelocity'] = [
  {
    locationId: 'loc-downtown',
    displayName: 'Downtown',
    velocity: [
      { weekStart: VELOCITY_WEEK_KEYS[0]!, count: 3 },
      { weekStart: VELOCITY_WEEK_KEYS[1]!, count: 5 },
      { weekStart: VELOCITY_WEEK_KEYS[2]!, count: 2 },
    ],
  },
  {
    locationId: 'loc-airport',
    displayName: 'Airport',
    velocity: [
      { weekStart: VELOCITY_WEEK_KEYS[0]!, count: 1 },
      { weekStart: VELOCITY_WEEK_KEYS[1]!, count: 4 },
      { weekStart: VELOCITY_WEEK_KEYS[2]!, count: 4 },
    ],
  },
];

// Built through the real construction path so the fixture cannot drift from
// how the dashboard actually shapes a ranking series. The second keyword skips
// a date on purpose — a sparse series is the case that exposes a gap cell.
const RANKING_SERIES = buildRankingSeries([
  {
    keyword: 'best coffee downtown',
    snapshots: [
      { date: VELOCITY_WEEK_KEYS[0]!, position: 4 },
      { date: VELOCITY_WEEK_KEYS[1]!, position: 3 },
      { date: VELOCITY_WEEK_KEYS[2]!, position: 2 },
    ],
  },
  {
    keyword: 'espresso bar',
    snapshots: [
      { date: VELOCITY_WEEK_KEYS[0]!, position: 7 },
      { date: VELOCITY_WEEK_KEYS[2]!, position: 5 },
    ],
  },
]);

const TREND_STARS = [4.0, 4.2, 4.1, 4.3, 4.4, 4.2, 4.5, 4.4];

const TREND_WEEKS: ReputationSummary['trend'] = weekStarts(TREND_STARS.length).map(
  (weekStart, i) => ({ weekStart, starEquivalent: TREND_STARS[i]!, reviewCount: 3 }),
);

/**
 * A real window with nothing plotted in it: eight weekly buckets, none carrying
 * a star-equivalent. `starTrendPoints` filters them all out, so the chart takes
 * its empty branch while still knowing the span it would have covered.
 */
const EMPTY_SERIES_WEEKS: ReputationSummary['trend'] = weekStarts(8).map((weekStart) => ({
  weekStart,
  starEquivalent: null,
  reviewCount: 0,
}));

const RATING_BREAKDOWN: RatingBreakdown = {
  counts: [
    { stars: 5, count: 7 },
    { stars: 4, count: 3 },
    { stars: 3, count: 1 },
    { stars: 2, count: 0 },
    { stars: 1, count: 1 },
  ],
  total: 12,
};

// 6 positive (5★), 2 neutral (3★), 2 negative (1★) under classifySentiment's
// >=4 / 3 / <=2 bands — 60 / 20 / 20 with no rounding ambiguity.
const RECENT_REVIEWS: ReadonlyArray<{ starRating: number | null }> = [
  ...Array.from({ length: 6 }, () => ({ starRating: 5 })),
  ...Array.from({ length: 2 }, () => ({ starRating: 3 })),
  ...Array.from({ length: 2 }, () => ({ starRating: 1 })),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The window vocabulary the charts already share. `ReputationTrendChart` is the
 * precedent ("last 8 weeks" via `trendSpanLabel`); the two `Recent*` sub-labels
 * supply the other two phrases in use today.
 */
const WINDOW_PATTERN = /last (?:week|\d+ weeks)|selected period|most recent/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The name the CHART carries, as distinct from the card around it and the rows
 * inside it. Two mechanisms count, and they are the two already in use: the
 * `<caption>` of an `sr-only` data table, or `aria-label` on a `role="img"`
 * graphic. A per-row `aria-label` names a row, not the chart, so it
 * deliberately does not count — that is exactly gap G6.
 */
function chartAccessibleName(container: HTMLElement): string {
  const caption = container.querySelector('table > caption')?.textContent?.trim();
  if (caption) return caption;
  return container.querySelector('[role="img"]')?.getAttribute('aria-label')?.trim() ?? '';
}

/** Row headers of a chart's `sr-only` data table — one per plotted bucket. */
function rowHeaderTexts(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('tbody th[scope="row"]'),
    (th) => th.textContent?.trim() ?? '',
  );
}

function firstNumber(text: string | null | undefined): number | null {
  const match = text?.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** The plotted values a chart exposes through its `sr-only` data table. */
function tableValues(container: HTMLElement): Array<number | null> {
  return Array.from(container.querySelectorAll('tbody td'), (td) => firstNumber(td.textContent));
}

/** The plotted values a `Recent*` chart exposes in its row-count column. */
function rowCountValues(container: HTMLElement): Array<number | null> {
  return Array.from(container.querySelectorAll('.rating-row-count'), (span) =>
    firstNumber(span.textContent),
  );
}

/** The trend chart's y-axis star gridlines — its x labels are prose, not values. */
function trendAxisStars(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('text.rep-trend-axis'),
    (node) => node.textContent?.trim() ?? '',
  ).filter((text) => /^\d+\.\d$/.test(text));
}

/** The one-line window statement under a `Recent*` chart's heading. */
function windowSubLabel(container: HTMLElement): string {
  return container.querySelector('.rating-breakdown-sub')?.textContent?.trim() ?? '';
}

function windowPhrase(text: string): string {
  return text.match(WINDOW_PATTERN)?.[0].toLowerCase() ?? '';
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

interface ChartSubject {
  name: string;
  render: () => Promise<HTMLElement>;
}

/**
 * The stacked aggregate chart lives behind the "By Location" tab of
 * `AggregateVelocityCard`, so reaching it means clicking. Queries are scoped to
 * this render's own container so a preceding render in the same test cannot
 * make the tab lookup ambiguous.
 */
async function renderStackedVelocityChart(): Promise<HTMLElement> {
  const user = userEvent.setup();
  const { container } = render(
    <AggregateVelocityCard
      reviewVelocity={VELOCITY_WEEKS}
      perLocationVelocity={PER_LOCATION_VELOCITY}
    />,
  );
  await user.click(within(container).getByRole('tab', { name: 'By Location' }));
  return container;
}

/** The five charts the corrected measurement enumerates. */
const CHART_SUBJECTS: ReadonlyArray<ChartSubject> = [
  {
    name: 'VelocityChart',
    render: async () => render(<VelocityCard reviewVelocity={VELOCITY_WEEKS} />).container,
  },
  {
    name: 'RankingChart',
    render: async () => render(<RankingChart series={RANKING_SERIES} />).container,
  },
  {
    name: 'ReputationTrendChart',
    render: async () => render(<ReputationTrendChart trend={TREND_WEEKS} />).container,
  },
  {
    name: 'RecentRatingBreakdown',
    render: async () => render(<RecentRatingBreakdown breakdown={RATING_BREAKDOWN} />).container,
  },
  {
    name: 'RecentSentimentMix',
    render: async () => render(<RecentSentimentMix reviews={RECENT_REVIEWS} />).container,
  },
];

/**
 * The charts whose accessible name is the ONLY place they speak — an SVG plot
 * with an `sr-only` table or a `role="img"` label behind it. The two `Recent*`
 * charts are excluded here and not forgotten: their window disagreement is a
 * different gap (G4) and is pinned by the aggregate-parity title below.
 */
const PLOTTED_CHART_SUBJECTS: ReadonlyArray<ChartSubject> = [
  CHART_SUBJECTS[0]!,
  CHART_SUBJECTS[1]!,
  CHART_SUBJECTS[2]!,
  { name: 'StackedVelocityChart', render: renderStackedVelocityChart },
];

async function nameEachChart(
  subjects: ReadonlyArray<ChartSubject>,
): Promise<Array<{ chart: string; name: string }>> {
  const named: Array<{ chart: string; name: string }> = [];
  for (const subject of subjects) {
    named.push({ chart: subject.name, name: chartAccessibleName(await subject.render()) });
    cleanup();
  }
  return named;
}

// ---------------------------------------------------------------------------
// The five promised tests
// ---------------------------------------------------------------------------

// `it.fails` marks a test that MUST fail today — the eval-first contract from
// the /feature workflow ("slices not yet buildable may use .todo/.fails"). It
// keeps the verify gate honest and green while the spec is still red, and it is
// a forcing function in both directions: the moment a tracer closes its gap the
// `.fails` itself starts failing, so the tracer cannot land without flipping it
// back to a plain `it`. Each one names the tracer that owns it.
describe('chart readability (feat/1088)', () => {
  // G6. Every chart is already reachable by a screen reader — the corrected
  // measurement settled that — but reachable is not named. The two `Recent*`
  // charts label each row and leave the chart itself anonymous.
  // RED until T5 adds chart-level names to the two `Recent*` charts.
  it.fails('every dashboard chart exposes an accessible name', async () => {
    const named = await nameEachChart(CHART_SUBJECTS);

    expect(named.filter((entry) => entry.name === '').map((entry) => entry.chart)).toEqual([]);
  });

  // G1 + G5. The window must be stated where the CHART speaks, not only in the
  // card header beside it — a screen-reader user reading the `sr-only` table
  // gets every number and no period. `VelocityCard` is rendered whole here on
  // purpose: its "last 3 weeks" header is present in the DOM and still must not
  // count.
  // GREEN since T2 put the window into each chart's own caption / label:
  // `trendSpanLabel` for the two velocity charts, the dated snapshot span for
  // `RankingChart`. `ReputationTrendChart` already carried it.
  it('every dashboard chart states the window it covers', async () => {
    const named = await nameEachChart(PLOTTED_CHART_SUBJECTS);

    expect(
      named.filter((entry) => !WINDOW_PATTERN.test(entry.name)).map((entry) => entry.chart),
    ).toEqual([]);
  });

  // Owner decision, 2026-09-04: this targets `ReputationTrendChart` only. The
  // two `Recent*` charts return null at total === 0 so the caller can drop the
  // slot, and that is the contract — asserted below so this title cannot be
  // satisfied by giving them an empty state they are not supposed to have.
  // GREEN since T2 named the unit and the window in the trend chart's empty
  // state. The two `Recent*` assertions below were green throughout and stay
  // as the guard on their deliberate `return null`.
  it('a chart with an empty series still says what it would plot', () => {
    const { container: trend } = render(<ReputationTrendChart trend={EMPTY_SERIES_WEEKS} />);
    const empty = within(trend).getByText(/not enough reviews/i);

    expect(empty).toHaveTextContent(/star-equivalent/i);
    expect(empty.textContent ?? '').toMatch(WINDOW_PATTERN);

    cleanup();

    expect(
      render(<RecentRatingBreakdown breakdown={{ counts: [], total: 0 }} />).container,
    ).toBeEmptyDOMElement();
    cleanup();
    expect(render(<RecentSentimentMix reviews={[]} />).container).toBeEmptyDOMElement();
  });

  // G3 + G4. Two pairs that sit next to each other, each pinned to the thing
  // that is actually wrong with it.
  // RED until T5 gives the stacked aggregate the same week labels as its
  // per-location twin. The G4 arm below already passes and is a regression pin.
  it.fails('a per-location chart and its aggregate peer describe the same measure identically', async () => {
    // G3: the TRUE per-location/aggregate pair. Both plot review velocity by
    // week, so their week labels must read the same way. Today the per-location
    // chart uses `weekShortLabel` and the stacked aggregate puts the raw ISO
    // bucket key in its row headers.
    const perLocation = render(<VelocityCard reviewVelocity={VELOCITY_WEEKS} />).container;
    const perLocationWeeks = rowHeaderTexts(perLocation);
    expect(perLocationWeeks).not.toHaveLength(0);
    expect(perLocationWeeks.filter((label) => ISO_DATE.test(label))).toEqual([]);
    cleanup();

    const aggregateWeeks = rowHeaderTexts(await renderStackedVelocityChart());
    expect(aggregateWeeks).not.toHaveLength(0);
    expect(aggregateWeeks.filter((label) => ISO_DATE.test(label))).toEqual([]);
    cleanup();

    // G4: the two `Recent*` charts are NOT a per-location/aggregate pair. They
    // cover genuinely different periods — `RecentRatingBreakdown` reads the
    // windowed `RatingBreakdown` aggregate (#405), `RecentSentimentMix` derives
    // from the recent-review sample. Forcing one phrase onto both would mean
    // changing what one of them computes, which invariant 1 forbids and which
    // this ticket is not allowed to do.
    //
    // So the requirement is the honest one: each states its window explicitly,
    // and the two stay VISIBLY DISTINCT, because a reader who cannot tell them
    // apart will assume one period covers both. That is gap G4.
    const rating = render(<RecentRatingBreakdown breakdown={RATING_BREAKDOWN} />).container;
    const ratingWindow = windowPhrase(windowSubLabel(rating));
    cleanup();

    const sentiment = render(<RecentSentimentMix reviews={RECENT_REVIEWS} />).container;
    const sentimentWindow = windowPhrase(windowSubLabel(sentiment));

    expect(ratingWindow).not.toBe('');
    expect(sentimentWindow).not.toBe('');
    expect(sentimentWindow).not.toBe(ratingWindow);
  });

  // The invariant that makes the whole ticket safe: this is a LABEL change, so
  // given fixed input every chart must plot the same numbers before and after.
  // Values only — captions, units and axis prose are what the other tracers
  // move, and pinning those here would fight them.
  it('no chart changes the values it plots', async () => {
    const velocity = render(<VelocityCard reviewVelocity={VELOCITY_WEEKS} />).container;
    expect(tableValues(velocity)).toEqual([4, 9, 6]);
    cleanup();

    const ranking = render(<RankingChart series={RANKING_SERIES} />).container;
    expect(tableValues(ranking)).toEqual([4, 7, 3, null, 2, 5]);
    cleanup();

    const trend = render(<ReputationTrendChart trend={TREND_WEEKS} />).container;
    expect(trendAxisStars(trend)).toEqual(['4.7', '4.3', '3.8']);
    cleanup();

    const breakdown = render(<RecentRatingBreakdown breakdown={RATING_BREAKDOWN} />).container;
    expect(rowCountValues(breakdown)).toEqual([7, 3, 1, 0, 1]);
    cleanup();

    const mix = render(<RecentSentimentMix reviews={RECENT_REVIEWS} />).container;
    expect(rowCountValues(mix)).toEqual([60, 20, 20]);
    cleanup();

    const stacked = await renderStackedVelocityChart();
    expect(tableValues(stacked)).toEqual([3, 1, 5, 4, 2, 4]);
  });
});
