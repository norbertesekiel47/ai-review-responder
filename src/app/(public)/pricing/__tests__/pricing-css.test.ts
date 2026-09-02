import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static guards for the /pricing stylesheet rules that carry accessibility
// findings: the 44px tap-target floor on the pill family (M22) and the table
// layout that keeps the comparison matrix's headers in the accessibility tree
// on phones (M8). Same pattern as auth-island.css.test.ts.
const pricingCss = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/pricing.css'),
  'utf-8',
);
const islandCss = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/island.css'),
  'utf-8',
);

function rule(css: string, selector: string): string {
  const re = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const match = css.match(re);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start === -1) throw new Error(`No media block for ${query}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated media block for ${query}`);
}

describe('Daylight pills meet the 44px tap target (M22)', () => {
  it('.rw-pill keeps its 12px/22px padding and gains a 44px floor', () => {
    const pill = rule(islandCss, '.rw-pill');
    expect(pill).toMatch(/min-height:\s*44px/);
    expect(pill).toMatch(/padding:\s*12px 22px/);
  });

  it('.pr-plan-cta and the plan-picker radio chips carry the same floor', () => {
    expect(rule(pricingCss, '.pr-plan-cta')).toMatch(/min-height:\s*44px/);
    expect(rule(pricingCss, '.pr-plan-pick-opt')).toMatch(/min-height:\s*44px/);
  });
});

describe('the comparison matrix lays out as a table (M8)', () => {
  it('resets <th> weight and alignment so the ledger stays one weight, left-aligned', () => {
    const cell = rule(pricingCss, '.pr-matrix-cell');
    expect(cell).toMatch(/font-weight:\s*400/);
    expect(cell).toMatch(/text-align:\s*left/);
  });

  it('clips the header row on phones instead of removing it, so column headers still label cells', () => {
    const phone = mediaBlock(pricingCss, '(max-width: 720px)');
    const hdr = rule(phone, '  .pr-matrix-row.hdr-row');
    expect(hdr).not.toMatch(/display:\s*none/);
    expect(hdr).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hdr).toMatch(/position:\s*absolute/);
  });
});
