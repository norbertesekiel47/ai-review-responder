// src/lib/kpi/__tests__/types.test.ts
//
// Pins the window vocabulary's human labels to the integers they describe
// (#991). `DASHBOARD_WINDOW_LABELS` is the ONE owner of "30 days" / "12 weeks":
// the period toolbar renders it and the rating breakdown composes it into
// "in the last 30 days". A label that drifted from `windowDays` would put a
// false span on screen with every test on the components still green, so the
// check lives with the table, not the renderers.

import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_WINDOWS,
  DASHBOARD_WINDOW_LABELS,
  dashboardWindowParams,
} from '@/lib/kpi/types';

/** "7 days" → 7, "12 weeks" → 84; anything else is a label the test rejects. */
function labelDays(label: string): number {
  const match = /^(\d+) (days?|weeks?)$/.exec(label);
  if (!match) throw new Error(`unrecognised window label: ${JSON.stringify(label)}`);
  const n = Number(match[1]);
  return match[2]!.startsWith('week') ? n * 7 : n;
}

describe('DASHBOARD_WINDOW_LABELS', () => {
  it.each(DASHBOARD_WINDOWS)('%s labels exactly its windowDays', (window) => {
    expect(labelDays(DASHBOARD_WINDOW_LABELS[window])).toBe(
      dashboardWindowParams(window).windowDays,
    );
  });

  it('labels the rolling window in days, never the weekly trend span', () => {
    // The default: 30 days of ratings beside an 8-week trend (#991). The label
    // must say 30, not 56 — the trend charts state their own weeks.
    const { windowDays, trendWeeks } = dashboardWindowParams('30d');
    expect(trendWeeks * 7).not.toBe(windowDays);
    expect(DASHBOARD_WINDOW_LABELS['30d']).toBe('30 days');
  });
});
