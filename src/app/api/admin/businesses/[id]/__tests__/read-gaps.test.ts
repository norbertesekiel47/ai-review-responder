import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockDetail, mockSql, mockReport } = vi.hoisted(() => ({
  mockDetail: vi.fn(),
  mockSql: vi.fn(),
  mockReport: vi.fn(),
}));
vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: vi.fn(async () => ({ ok: true, admin: { role: 'admin' } })),
}));
vi.mock('@/lib/admin/business-detail-service', () => ({
  getBusinessDetail: mockDetail,
  updateBusiness: vi.fn(),
  FIELD_TO_COLUMN: {},
  AdminBusinessNotFoundError: class extends Error {},
}));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: mockReport }));

// The batch reader is real: the SQL seam below supplies only its scoped row.
import { GET } from '../route';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const BUSINESS = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const DETAIL = {
  business: { id: BUSINESS, name: 'Test business' },
  account: { id: ACCOUNT },
  reviews: [],
  reviewsTotal: 7,
};
const BATCH_ROW = {
  id: '00000000-0000-4000-8000-000000000004',
  built_at: null, approved_at: null, veto_deadline_at: null,
  sending_started_at: null, send_closed_at: null, halted_at: '2026-09-01T00:00:00Z',
  builtAtText: null, approvedAtText: null, haltedAtText: '2026-09-01T00:00:00Z',
  haltReason: 'admin_halt', cancellableCount: 0, sendingCount: 1, sentCount: 2,
};
const SUMMARY = {
  batchId: BATCH_ROW.id, batchState: 'halted', builtAt: null, approvedAt: null,
  haltedAt: BATCH_ROW.haltedAtText, haltReason: 'admin_halt',
  cancellableCount: 0, sendingCount: 1, sentCount: 2,
};

function request(id = BUSINESS) {
  return GET(new NextRequest(`http://localhost/api/admin/businesses/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('Admin business read gaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetail.mockResolvedValue(DETAIL);
    // The real query binds account/business at each correlated scope. Matching
    // every pair also makes a route that swaps or drops either id observable.
    mockSql.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const matches = values.length > 0 && values.every((value, index) => (
        value === (index % 2 === 0 ? ACCOUNT : BUSINESS)
      ));
      return matches ? [BATCH_ROW] : [];
    });
  });

  it('waits for business detail before reading and returning the scoped batch summary', async () => {
    const detail = Promise.withResolvers<typeof DETAIL>();
    const started = Promise.withResolvers<void>();
    mockDetail.mockImplementationOnce(() => {
      started.resolve();
      return detail.promise;
    });
    const pending = request();
    await started.promise;
    expect(mockSql).not.toHaveBeenCalled();
    detail.resolve(DETAIL);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith(mockSql, BUSINESS);
    expect(mockSql).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ...DETAIL, batchSummary: SUMMARY });
  });

  it('returns a null batch summary for the wrong account', async () => {
    const detail = { ...DETAIL, account: { id: OTHER } };
    mockDetail.mockResolvedValue(detail);
    const response = await request();
    expect(response.status).toBe(200);
    expect(mockSql).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ...detail, batchSummary: null });
  });

  it('returns a null batch summary for the wrong business', async () => {
    const detail = { ...DETAIL, business: { ...DETAIL.business, id: OTHER } };
    mockDetail.mockResolvedValue(detail);
    const response = await request(OTHER);
    expect(response.status).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith(mockSql, OTHER);
    expect(mockSql).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ...detail, batchSummary: null });
  });

  it('returns 404 without reading batches when the business is missing', async () => {
    mockDetail.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Business not found' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns the existing generic failure when the batch read fails', async () => {
    const error = new Error('controlled database failure');
    mockSql.mockRejectedValueOnce(error);
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch business' });
    expect(mockReport).toHaveBeenCalledWith('api/admin/businesses/[id] GET', error, { businessId: BUSINESS });
  });
});
