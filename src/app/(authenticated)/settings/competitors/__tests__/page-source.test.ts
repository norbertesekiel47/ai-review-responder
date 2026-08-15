import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Comments are stripped before asserting, for the same reason as the sibling
// test at src/app/admin/businesses/[id]/__tests__/page-source.test.ts: the house
// idiom for this invariant contains the banned string, so a naive
// `not.toContain` would forbid the page from ever explaining itself.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('competitors settings page source', () => {
  it('keeps the competitors settings page free of Promise.all fan-out', async () => {
    const source = await readFile(
      'src/app/(authenticated)/settings/competitors/page.tsx',
      'utf8',
    );
    const code = stripComments(source);

    expect(code).not.toContain('Promise.all');
    expect(code).toContain('loadRivalPickerViews');
  });
});
