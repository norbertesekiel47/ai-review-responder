import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source-text assertion, matching src/app/admin/autonomy/__tests__/page-source.test.ts.
// This repo has no executing server-page test precedent, and the invariant here
// is a source-level one: the page must not race two sql-backed reads.
//
// Comments are stripped before asserting. The house idiom for this very
// invariant — "do NOT re-introduce a Promise.all here", used verbatim in
// admin/costs/page.tsx and admin/overview/page.tsx — contains the banned
// string, so a naive `not.toContain` would forbid the page from explaining
// itself and would fail on the correct implementation.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('admin business detail page source', () => {
  it('keeps the admin business detail page free of Promise.all fan-out', async () => {
    const source = await readFile('src/app/admin/businesses/[id]/page.tsx', 'utf8');
    const code = stripComments(source);

    expect(code).not.toContain('Promise.all');
    expect(code).toContain('getBusinessDetail');
    expect(code).toContain('getBusinessChannelEnrollments');
    // The comment explaining the invariant must survive — it is why the next
    // reader does not "optimise" this back into a fan-out.
    expect(source).toContain('SEQUENTIAL');
  });
});
