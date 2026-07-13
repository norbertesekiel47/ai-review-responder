import { describe, expect, it } from 'vitest';
import { formatScheduledPostTime } from '../scheduled-post-time';

describe('formatScheduledPostTime', () => {
  const now = new Date('2026-07-09T14:00:00.000Z');

  it('renders the absolute time as zero-padded HH:MM UTC', () => {
    const { absoluteUtc } = formatScheduledPostTime(new Date('2026-07-09T09:05:00.000Z'), now);
    expect(absoluteUtc).toBe('09:05 UTC');
  });

  it('renders the relative time as "in about N minutes" rounded to the nearest minute', () => {
    const { relative } = formatScheduledPostTime(new Date('2026-07-09T14:30:20.000Z'), now);
    expect(relative).toBe('in about 30 minutes');
  });

  it('uses singular "minute" when exactly one minute remains', () => {
    const { relative } = formatScheduledPostTime(new Date('2026-07-09T14:01:00.000Z'), now);
    expect(relative).toBe('in about 1 minute');
  });

  it('clamps an already-passed deadline to 1 minute (defensive — dispatcher skips stale notices)', () => {
    const { relative } = formatScheduledPostTime(new Date('2026-07-09T13:50:00.000Z'), now);
    expect(relative).toBe('in about 1 minute');
  });

  it('composes the combined phrase as "HH:MM UTC (in about N minutes)"', () => {
    const { phrase } = formatScheduledPostTime(new Date('2026-07-09T14:30:00.000Z'), now);
    expect(phrase).toBe('14:30 UTC (in about 30 minutes)');
  });
});
