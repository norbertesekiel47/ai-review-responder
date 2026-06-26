// worker/__tests__/transient-rejection-governor.test.ts

import { describe, it, expect } from 'vitest';
import { createTransientRejectionGovernor } from '../transient-rejection-governor';

const MIN = 60_000;
// A continuous storm = rejections spaced closer than idleResetMs so the clock
// never resets. 1-min spacing under a 5-min idle reset stays continuous.

describe('createTransientRejectionGovernor', () => {
  it('never escalates on the first rejection (zero duration)', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    expect(g.record(0)).toBe(false);
  });

  it('survives a large, brief boot fan-out (dozens of rejections within seconds)', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    // 50 recovered rejections all inside the first ~5s — one transient event.
    let escalated = false;
    for (let i = 0; i < 50; i++) escalated = g.record(i * 100) || escalated; // 0..4900ms
    expect(escalated).toBe(false);
  });

  it('escalates once a continuous storm persists past sustainedMs', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    // One rejection every 10s — never an idle gap — for just over 10 minutes.
    let escalated = false;
    for (let t = 0; t <= 10 * MIN; t += 10_000) escalated = g.record(t);
    expect(escalated).toBe(true);
  });

  it('does not escalate while a continuous storm is still younger than sustainedMs', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    expect(g.record(0)).toBe(false);
    expect(g.record(4 * MIN)).toBe(false); // gap 4<5 → continuous
    expect(g.record(8 * MIN)).toBe(false); // 8 min into the storm < 10 min
  });

  it('escalates exactly at the sustainedMs boundary of a continuous storm', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    expect(g.record(0)).toBe(false);
    expect(g.record(4 * MIN)).toBe(false); // continuous
    expect(g.record(8 * MIN)).toBe(false); // continuous
    expect(g.record(10 * MIN)).toBe(true); // duration == sustainedMs, no gap > idle → escalate
  });

  it('a quiet gap longer than idleResetMs ends the storm and restarts the clock', () => {
    const g = createTransientRejectionGovernor({ sustainedMs: 10 * MIN, idleResetMs: 5 * MIN });
    expect(g.record(0)).toBe(false);
    expect(g.record(4 * MIN)).toBe(false); // continuous, 4 min into the storm
    // ...then 6 min of quiet (> 5 min idle reset) — the storm is over.
    expect(g.record(10 * MIN)).toBe(false); // fresh storm starts here (duration 0)
    expect(g.record(13 * MIN)).toBe(false); // continuous: 3 min into the NEW storm
    expect(g.record(16 * MIN)).toBe(false); // continuous: 6 min in — still under, despite t=16min
  });
});
