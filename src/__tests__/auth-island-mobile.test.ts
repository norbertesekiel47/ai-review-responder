import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch audit #22 / M5 + M9: the auth island must not exceed iPhone SE height
// (min-height override on mobile), and the signup name+phone row must stack on
// narrow phones instead of two ~150px inputs. File-scan guard mirrors
// island-overflow.test.ts.
const css = readFileSync(
  resolve(process.cwd(), 'src/components/auth/auth-island/auth-island.css'),
  'utf-8',
);

describe('auth-island mobile overrides (#22)', () => {
  it('M9: .rw-island drops its 680px floor to auto on mobile', () => {
    expect(css).toMatch(/\.rw-island\s*\{[^}]*min-height:\s*auto/);
  });

  it('M5: .rw-field-row .row stacks to a single column on narrow phones', () => {
    expect(css).toMatch(/\.rw-field-row\s+\.row\s*\{\s*grid-template-columns:\s*1fr\s*;?\s*\}/);
    expect(css).toMatch(/@media\s*\(max-width:\s*480px\)/);
  });
});
