import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static guards for the /how-it-works stylesheet: the stacking hint is hidden
// exactly where the steps stop stacking (M16), and the supporting cards wear the
// Island card anatomy's thin top bar rather than a full-height side tab.
const css = readFileSync(
  resolve(process.cwd(), 'src/app/(public)/_styles/how-it-works.css'),
  'utf-8',
);

function rule(source: string, selector: string): string {
  const re = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const match = source.match(re);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

function mediaBlock(source: string, query: string): string {
  const start = source.indexOf(`@media ${query} {`);
  if (start === -1) throw new Error(`No media block for ${query}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated media block for ${query}`);
}

describe('how-it-works.css', () => {
  it('hides the "each step stacks" sentence in the same block that un-sticks the steps (M16)', () => {
    const narrow = mediaBlock(css, '(max-width: 1040px)');
    expect(rule(narrow, '  .hiw-step')).toMatch(/position:\s*static/);
    expect(rule(narrow, '  .hiw-stack-hint')).toMatch(/display:\s*none/);
    // And nowhere else: the sentence renders at ≥1041px.
    const outside = css.replace(narrow, '');
    expect(outside).not.toMatch(/\.hiw-stack-hint/);
  });

  it('gives the stat cards a 4px top bar, not a 10px full-height side tab', () => {
    const bar = rule(css, '.hiw-stat::before');
    expect(bar).toMatch(/height:\s*4px/);
    expect(bar).toMatch(/right:\s*0/);
    expect(bar).not.toMatch(/bottom:\s*0/);
    expect(bar).not.toMatch(/width:\s*10px/);
    // The card's padding no longer reserves room for a side tab.
    expect(rule(css, '.hiw-stat')).toMatch(/padding:\s*32px 28px 30px;/);
  });

  it('gives the pipeline panel cards the same 4px top bar', () => {
    const bar = rule(css, '.hiw-hood > div::before');
    expect(bar).toMatch(/height:\s*4px/);
    expect(bar).not.toMatch(/height:\s*6px/);
  });
});
