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
