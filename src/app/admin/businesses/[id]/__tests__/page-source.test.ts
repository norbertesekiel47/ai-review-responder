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

  it('the business detail page reads the admin batch summary sequentially without Promise.all', async () => {
    const source = await readFile('src/app/admin/businesses/[id]/page.tsx', 'utf8');
    const code = stripComments(source);

    // The admin Halt latch surface (#865) adds a THIRD sql-backed read to this
    // page. It is the read most likely to be "optimised" into a race, because
    // it is independent of the other two — and that is exactly the #773 pool
    // fan-out this page carries a standing comment forbidding.
    expect(code).toContain('readAdminBatchSummary');
    expect(code).not.toContain('Promise.all');
    // Ordering asserted on the SOURCE, not just presence: three separate
    // statements in a fixed order is the shape a fan-out would destroy, and
    // "contains the call" alone is satisfied by a Promise.all member.
    const detailAt = code.indexOf('getBusinessDetail');
    const channelsAt = code.indexOf('getBusinessChannelEnrollments');
    const summaryAt = code.indexOf('readAdminBatchSummary');
    expect(detailAt).toBeGreaterThanOrEqual(0);
    expect(channelsAt).toBeGreaterThan(detailAt);
    expect(summaryAt).toBeGreaterThan(channelsAt);
  });

  // X28: the list is one breadcrumb away, on the server-rendered chrome.
  it('passes the parent crumb to AdminPage instead of a back link in the client', async () => {
    const page = await readFile('src/app/admin/businesses/[id]/page.tsx', 'utf8');
    const client = await readFile('src/app/admin/businesses/[id]/BusinessDetailClient.tsx', 'utf8');

    expect(page).toContain(`parent={{ href: '/admin/businesses', label: 'All businesses' }}`);
    expect(client).not.toContain('Back to Businesses');
  });

  // X11: the post-invite success strip is a URL flag read by the server page —
  // the owner's address comes from the detail read, never from the URL.
  it('flashes the invite-sent strip from the invited flag using the detail read’s owner email', async () => {
    const page = await readFile('src/app/admin/businesses/[id]/page.tsx', 'utf8');
    const code = stripComments(page);

    expect(code).toContain("(await searchParams).invited === INVITED_FLAG");
    expect(code).toContain('Invite email sent to');
    expect(code).toContain('{detail.business.ownerEmail}');
    expect(code).toContain('role="status"');
    // The flag is a constant, not the address.
    expect(code).toContain("const INVITED_FLAG = '1'");
    expect(code).not.toMatch(/searchParams\)\.email|invitedEmail/);
  });
});
