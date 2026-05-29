import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M6: the sticky save-bar's `left` offset must equal the sidebar width. That
// equality was previously enforced by two independent literal `240px` values
// (console.css `.sidebar`, settings.css `.save-bar`). This guard locks them to a
// single `--rw-sidebar-width` token so they can never drift.
const TOKENS = resolve(process.cwd(), 'src/app/(authenticated)/_styles/tokens.css');
const CONSOLE = resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css');
const SETTINGS = resolve(process.cwd(), 'src/app/(authenticated)/_styles/settings.css');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

// Return the body of the FIRST `<selector> { ... }` rule (non-greedy to the first
// closing brace — these blocks have no nested braces). The negative lookahead
// stops `.sidebar` from matching `.sidebar-spacer` and `.save-bar` from matching
// `.save-bar-text`, and keeps us on the base rule rather than an @media override.
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}(?![\\w-])\\s*\\{([\\s\\S]*?)\\}`));
  if (!match || match[1] === undefined) {
    throw new Error(`${selector} rule block not found`);
  }
  return match[1];
}

describe('save-bar / sidebar share one --rw-sidebar-width token (M6)', () => {
  it('tokens.css defines --rw-sidebar-width', () => {
    expect(read(TOKENS)).toMatch(/--rw-sidebar-width\s*:/);
  });

  it('.save-bar offsets left by the token, not a hardcoded 240px', () => {
    const block = ruleBlock(read(SETTINGS), '.save-bar');
    expect(block).toMatch(/left\s*:\s*var\(--rw-sidebar-width\)/);
    expect(block).not.toMatch(/left\s*:\s*240px/);
  });

  it('.sidebar derives its width and flex-basis from the token', () => {
    const block = ruleBlock(read(CONSOLE), '.sidebar');
    expect(block).toMatch(/width\s*:\s*var\(--rw-sidebar-width\)/);
    expect(block).toMatch(/flex\s*:\s*0\s+0\s+var\(--rw-sidebar-width\)/);
    expect(block).not.toMatch(/240px/);
  });
});
