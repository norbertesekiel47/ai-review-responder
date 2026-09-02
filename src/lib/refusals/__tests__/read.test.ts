// The Refusal ledger's READ path — pure-helper eval (#1014 T4).
//
// This file holds NO promised title. All 22 read titles need a live database
// and live in `read.integration.test.ts`; the intake's `tests_to_add` places
// them there and the `promised-tests` gate row matches them there.
//
// What lands here is the one helper Task 4 extracted from `getRefusalLog` so it
// can be proven without a database: the archive/reactivate pairing, and the
// window-intersection filter that decides which periods the tab shows. Both are
// total functions over dates. A live-DB round trip would add nothing but
// serialization, and the four cases below include two the audit log CANNOT be
// made to produce on demand — an unmatched reactivation and a period that
// closed before the window opened.

import { describe, expect, it } from 'vitest';
import { ARCHIVAL_EVENT_LIMIT, ENTRY_LIMIT, pairArchivedPeriods } from '@/lib/refusals/read';

const WINDOW_START = new Date('2026-06-03T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-01T00:00:00.000Z');

describe('read caps', () => {
  // THE MAGNITUDE, which neither live-DB cap probe can pin. Each seeds its own
  // fixture FROM the constant (`ENTRY_LIMIT + extra`,
  // `generate_series(0, ARCHIVAL_EVENT_LIMIT)`), so shrinking the constant
  // shrinks the fixture in lockstep and the arithmetic holds at any value —
  // setting either to 5 left every case green (red team F30). Those probes
  // prove the cap equals whatever the constant says; this proves what it says.
  it('pins both cap magnitudes, which the self-referential fixtures cannot', () => {
    expect(ENTRY_LIMIT).toBe(200);
    expect(ARCHIVAL_EVENT_LIMIT).toBe(200);
  });
});

describe('pairArchivedPeriods', () => {
  it('pairs an archive with its reactivation', () => {
    expect(pairArchivedPeriods([
      { eventType: 'location_archived', at: new Date('2026-07-01T00:00:00.000Z') },
      { eventType: 'location_reactivated', at: new Date('2026-08-01T00:00:00.000Z') },
    ], WINDOW_START, WINDOW_END)).toEqual([
      { archivedAt: '2026-07-01T00:00:00.000Z', reactivatedAt: '2026-08-01T00:00:00.000Z' },
    ]);
  });

  it('leaves a still-archived period open', () => {
    expect(pairArchivedPeriods([
      { eventType: 'location_archived', at: new Date('2026-07-01T00:00:00.000Z') },
    ], WINDOW_START, WINDOW_END)).toEqual([
      { archivedAt: '2026-07-01T00:00:00.000Z', reactivatedAt: null },
    ]);
  });

  it('ignores a reactivation with no preceding archive', () => {
    // It describes a period that began before this log did. Inventing a start
    // date for it would be the same lie the Coverage start exists to prevent.
    expect(pairArchivedPeriods([
      { eventType: 'location_reactivated', at: new Date('2026-07-01T00:00:00.000Z') },
    ], WINDOW_START, WINDOW_END)).toEqual([]);
  });

  it('drops a period that closed before the window opened', () => {
    expect(pairArchivedPeriods([
      { eventType: 'location_archived', at: new Date('2026-01-01T00:00:00.000Z') },
      { eventType: 'location_reactivated', at: new Date('2026-02-01T00:00:00.000Z') },
    ], WINDOW_START, WINDOW_END)).toEqual([]);
  });
});
