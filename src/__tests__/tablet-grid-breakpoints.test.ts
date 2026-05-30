import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// launch-ready-part2 M7 / P2 #25: KPI + Past-Replies stat grids stayed 3/4-col
// from 769–900px (cramped on iPad portrait). A ~900px breakpoint must drop them
// to 2 columns above the existing 768px rule.
const CASES = [
  {
    label: 'console.css .kpi-grid',
    path: resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css'),
    selector: 'kpi-grid',
  },
  {
    label: 'past-replies.css .pr-stats',
    path: resolve(process.cwd(), 'src/app/(authenticated)/_styles/past-replies.css'),
    selector: 'pr-stats',
  },
];

describe('tablet grid breakpoints (P2 #25 / M7)', () => {
  it.each(CASES)('$label has a max-width:900px → 2-col rule', ({ path, selector }) => {
    const css = readFileSync(path, 'utf-8');
    const block = css.match(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\}\s*\}/);
    expect(block, 'no @media (max-width: 900px) block found').not.toBeNull();
    const text = block![0];
    expect(text).toMatch(new RegExp(`\\.${selector}`));
    expect(text).toMatch(/grid-template-columns:\s*repeat\(2,\s*1fr\)|grid-template-columns:\s*1fr 1fr/);
  });
});
