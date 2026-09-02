import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static guards for the two mobile rules the auth island documents elsewhere
// (field-styles.ts, console.css) but had drifted from in its own stylesheet.
const css = readFileSync(
  resolve(process.cwd(), 'src/components/auth/auth-island/auth-island.css'),
  'utf-8',
);

function rule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(re);
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

describe('auth-island.css mobile rules', () => {
  it('.rw-input is 16px so iOS Safari does not zoom on focus (A5)', () => {
    expect(rule('.rw-input')).toMatch(/font:\s*400\s+16px/);
  });

  it('.rw-check spans a 44px tap target with a 22–24px box (A15)', () => {
    expect(rule('.rw-check')).toMatch(/min-height:\s*44px/);
    const box = rule('.rw-check .box');
    const [, w] = box.match(/width:\s*(\d+)px/) ?? [];
    const [, h] = box.match(/height:\s*(\d+)px/) ?? [];
    expect(Number(w)).toBeGreaterThanOrEqual(22);
    expect(Number(w)).toBeLessThanOrEqual(24);
    expect(h).toBe(w);
  });

  it('a checked box carries its white check on rw-teal-strong, never rw-teal (ADR 0004)', () => {
    expect(rule('.rw-check input:checked ~ .box')).toContain('var(--rw-teal-strong)');
    expect(rule('.rw-check input:checked ~ .box')).not.toMatch(/var\(--rw-teal\)/);
  });
});
