import { beforeEach, describe, expect, it, vi } from 'vitest';

// The suppressions console is the only admin surface that reads a recipient's
// Normalized handle across every tenant and can remove their revocation, so its
// page gate is the same unconditional admin + AAL2 check the two routes behind
// it use. A page that rendered first and gated later would have already told an
// unauthorized viewer the shape of the screen.

const { mockRequireAdminPage, mockSql, mockSuppressionsClient } = vi.hoisted(() => ({
  mockRequireAdminPage: vi.fn(),
  mockSql: { marker: 'sql-singleton' },
  mockSuppressionsClient: vi.fn(() => null),
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/auth/page-gate', () => ({ requireAdminPage: mockRequireAdminPage }));
vi.mock('../SuppressionsClient', () => ({ SuppressionsClient: mockSuppressionsClient }));

describe('admin suppressions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an admin AAL2 page gate before rendering the suppressions console', async () => {
    mockRequireAdminPage.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    const { default: AdminSuppressionsPage } = await import('../page');

    const element = await AdminSuppressionsPage();

    expect(mockRequireAdminPage).toHaveBeenCalledWith(mockSql, {
      from: '/admin/suppressions',
      aal2: true,
    });
    expect(element.type).toBe(mockSuppressionsClient);

    // Gate first: a rejected gate redirects and the console is never returned.
    // Nothing else runs on this page — it is lookup-first and fetches no data,
    // so there is no service call to leak either.
    vi.clearAllMocks();
    mockRequireAdminPage.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(AdminSuppressionsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockSuppressionsClient).not.toHaveBeenCalled();
  });
});
