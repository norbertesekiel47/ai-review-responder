import { describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import Page from '../page';

// #1092. The Review QR surface moved under Requests. The old Settings path is
// kept as a redirect rather than deleted: an owner may have bookmarked it, and
// a 404 on a page that worked yesterday reads as data loss.
describe('the old settings Review QR path', () => {
  it('the old settings Review QR path redirects to the Requests one', () => {
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/dashboard/requests/qr');
  });
});

// Spec review, 2026-09-03: only the PARENT old path redirected. The printable
// view moved with it and 404'd, because Next.js has no catch-all under
// `settings/` for the parent redirect to cover.
describe('the old settings Review QR PRINT path', () => {
  it('redirects to the moved printable view, preserving the business id', async () => {
    const { default: PrintPage } = await import('../print/[businessId]/page');
    await PrintPage({ params: Promise.resolve({ businessId: 'abc-123' }) });
    expect(redirectMock).toHaveBeenCalledWith('/dashboard/requests/qr/print/abc-123');
  });
});

