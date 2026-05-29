import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P0 #7 / repworth-brand-design rubric: island ROOTS must never set
// `overflow: hidden`. On iOS Safari, `overflow:hidden` + `border-radius` + a
// retained `transform` (both roots have all three) triggers a repaint bug that
// drops the rounded clip and flickers fixed siblings during momentum scroll.
// The canonical PageShell.tsx island already omits it; this guard locks the
// same contract for the two CSS-class island roots.
const ISLAND_ROOTS = [
  {
    label: 'marketing .rw-island (globals.css)',
    path: resolve(process.cwd(), 'src/app/globals.css'),
  },
  {
    label: 'auth .rw-island (auth-island.css)',
    path: resolve(
      process.cwd(),
      'src/components/auth/auth-island/auth-island.css',
    ),
  },
];

// Extract every `.rw-island { ... }` rule block, including responsive `@media`
// overrides — a regression could re-add overflow:hidden to any of them. The
// negative lookahead keeps this from matching `.rw-island-wrap` or the
// `rw-island-in` keyframe; the non-greedy body stops at the first closing brace
// (these blocks have no nested braces).
function extractIslandRules(css: string): string[] {
  const blocks = [...css.matchAll(/\.rw-island(?![\w-])\s*\{([\s\S]*?)\}/g)]
    .map((match) => match[1])
    .filter((block): block is string => block !== undefined);
  if (blocks.length === 0) {
    throw new Error('.rw-island rule block not found');
  }
  return blocks;
}

describe('island roots never set overflow:hidden (P0 #7, iOS Safari)', () => {
  it.each(ISLAND_ROOTS)(
    '$label never declares overflow: hidden (incl. @media overrides)',
    ({ path }) => {
      const islandRules = extractIslandRules(readFileSync(path, 'utf-8'));
      for (const rule of islandRules) {
        expect(rule).not.toMatch(/overflow\s*:\s*hidden/);
      }
    },
  );
});
