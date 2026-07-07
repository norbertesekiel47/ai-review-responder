import { describe, expect, it } from 'vitest';
import { clampNegativeCounts } from '../normalize-v8-coverage';

// Exercises the PURE clamp contract only — the filesystem CLI wrapper (`main`)
// is deliberately out of scope (it never runs on import; guarded by the ESM
// main-module check). The JSON text is the whole contract.
describe('clampNegativeCounts', () => {
  it('clamps a top-level negative to 0 and counts it', () => {
    const { text, clamped } = clampNegativeCounts(JSON.stringify({ hits: -1 }));
    expect(JSON.parse(text)).toEqual({ hits: 0 });
    expect(clamped).toBe(1);
  });

  it('clamps a NESTED negative inside a `b` branch-hit array', () => {
    // The real-world shape: istanbul branch map `b` holds arrays of per-path
    // hit counts; vitest-v8 emits `-1` for an unmappable branch path.
    const { text, clamped } = clampNegativeCounts(JSON.stringify({ b: { '6': [1, -1] } }));
    expect(JSON.parse(text)).toEqual({ b: { '6': [1, 0] } });
    expect(clamped).toBe(1);
  });

  it('leaves clean input (all >= 0) unchanged with count 0', () => {
    const input = JSON.stringify({ s: { '0': 3 }, b: { '6': [1, 2] } });
    const { text, clamped } = clampNegativeCounts(input);
    expect(text).toBe(input);
    expect(clamped).toBe(0);
  });

  it('counts every negative across multiple fields', () => {
    const { text, clamped } = clampNegativeCounts(
      JSON.stringify({ s: { '0': -1, '1': -2 }, b: { '6': [-1, 1] }, f: { '0': 4 } }),
    );
    expect(JSON.parse(text)).toEqual({ s: { '0': 0, '1': 0 }, b: { '6': [0, 1] }, f: { '0': 4 } });
    expect(clamped).toBe(3);
  });

  it('never alters a value >= 0 (0 stays 0, large counts survive)', () => {
    const input = JSON.stringify({ s: { '0': 0, '1': 1_000_000 }, b: { '6': [0, 42] } });
    const { text, clamped } = clampNegativeCounts(input);
    expect(JSON.parse(text)).toEqual({ s: { '0': 0, '1': 1_000_000 }, b: { '6': [0, 42] } });
    expect(clamped).toBe(0);
  });
});
