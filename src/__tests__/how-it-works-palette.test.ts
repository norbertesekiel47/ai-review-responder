import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Launch-audit part2 §A: How-it-works used green-600 (#16A34A) for success
// states — off the brand palette. Success states on marketing pages use the
// brand teal (#97B3AE / var(--rw-teal)). Functional greens elsewhere (chart
// deltas, password strength) are intentionally NOT covered by this guard.
describe('how-it-works palette', () => {
  it('contains no off-palette green (#16A34A) — success states use brand teal', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/sections/how-it-works/HowItWorksContent.tsx'),
      'utf8',
    );
    expect(src.toLowerCase()).not.toContain('#16a34a');
  });
});
