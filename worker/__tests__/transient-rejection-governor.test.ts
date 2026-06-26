// worker/__tests__/transient-rejection-governor.test.ts

import { describe, it, expect } from 'vitest';
import { createTransientRejectionGovernor } from '../transient-rejection-governor';

describe('createTransientRejectionGovernor', () => {
  it('does not escalate while at or below the threshold within the window', () => {
    const g = createTransientRejectionGovernor({ windowMs: 1000, maxInWindow: 3 });
    expect(g.record(0)).toBe(false);
    expect(g.record(100)).toBe(false);
    expect(g.record(200)).toBe(false); // 3rd hit == threshold, still ok
  });

  it('escalates once the count EXCEEDS the threshold within the window', () => {
    const g = createTransientRejectionGovernor({ windowMs: 1000, maxInWindow: 3 });
    g.record(0);
    g.record(100);
    g.record(200);
    expect(g.record(300)).toBe(true); // 4th hit in-window → escalate
  });

  it('prunes hits older than the window so isolated blips never escalate', () => {
    const g = createTransientRejectionGovernor({ windowMs: 1000, maxInWindow: 2 });
    // One blip every window-and-a-bit: each prunes the previous, count stays at 1.
    expect(g.record(0)).toBe(false);
    expect(g.record(1_500)).toBe(false);
    expect(g.record(3_000)).toBe(false);
    expect(g.record(4_500)).toBe(false);
  });

  it('treats a hit exactly at the window edge as expired (cutoff is inclusive)', () => {
    const g = createTransientRejectionGovernor({ windowMs: 1000, maxInWindow: 1 });
    expect(g.record(0)).toBe(false); // hits: [0]
    // now=1000 → cutoff=0 → the hit at 0 is pruned (<= cutoff); count back to 1.
    expect(g.record(1000)).toBe(false);
  });

  it('counts a tight burst at the same timestamp', () => {
    const g = createTransientRejectionGovernor({ windowMs: 1000, maxInWindow: 2 });
    expect(g.record(500)).toBe(false);
    expect(g.record(500)).toBe(false);
    expect(g.record(500)).toBe(true); // 3 at once > 2 → escalate
  });
});
