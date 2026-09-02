import { describe, expect, it } from 'vitest';
import { formatDay, parseTimestamp } from '../timestamps';

describe('parseTimestamp', () => {
  it('reads a Postgres ::text timestamptz, normalizing the short offset', () => {
    expect(parseTimestamp('2026-07-22 12:00:00+00')?.toISOString()).toBe('2026-07-22T12:00:00.000Z');
    expect(parseTimestamp('2026-07-22 12:00:00-05')?.toISOString()).toBe('2026-07-22T17:00:00.000Z');
  });

  it('reads a bare evidence day as UTC midnight', () => {
    expect(parseTimestamp('2026-07-22')?.toISOString()).toBe('2026-07-22T00:00:00.000Z');
  });

  it('passes an ISO string through', () => {
    expect(parseTimestamp('2026-07-22T09:30:00.000Z')?.toISOString()).toBe('2026-07-22T09:30:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parseTimestamp('not a date')).toBeNull();
  });
});

describe('formatDay', () => {
  it('renders the UTC calendar day', () => {
    // 23:30 UTC stays the 22nd regardless of the viewer's zone.
    expect(formatDay('2026-07-22 23:30:00+00')).toMatch(/22/);
    expect(formatDay('2026-07-22 23:30:00+00')).toMatch(/Jul/);
    expect(formatDay('2026-07-22 23:30:00+00')).toMatch(/2026/);
  });

  it('renders a value that does not parse raw, never as "Invalid Date"', () => {
    expect(formatDay('garbage')).toBe('garbage');
  });
});
