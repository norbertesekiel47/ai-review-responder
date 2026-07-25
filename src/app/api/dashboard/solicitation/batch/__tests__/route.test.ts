import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockRequireWritableOwner,
  mockGetLocationById,
  mockMultiLocationEnabled,
  mockReadLatestBatch,
  mockMarkBatchReviewed,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockRequireWritableOwner: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMultiLocationEnabled: vi.fn(() => false),
  mockReadLatestBatch: vi.fn(),
  mockMarkBatchReviewed: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    // Identity same-origin wrapper: these tests exercise the flag gate and the
    // scope policy, not the origin check.
    withSameOrigin: () =>
      <TArgs extends unknown[]>(handler: (...args: TArgs) => unknown) => handler,
    requireOwnerWithAccount: (...args: unknown[]) => mockRequireOwnerWithAccount(...args),
    requireWritableOwner: (...args: unknown[]) => mockRequireWritableOwner(...args),
  };
});

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: (...args: unknown[]) => mockGetLocationById(...args),
}));

vi.mock('@/lib/locations/flags', () => ({
  multiLocationEnabled: () => mockMultiLocationEnabled(),
}));

vi.mock('@/lib/solicitation/batch-view', () => ({
  readLatestBatch: (...args: unknown[]) => mockReadLatestBatch(...args),
  markBatchReviewed: (...args: unknown[]) => mockMarkBatchReviewed(...args),
}));

import {
  SOLICITATION_SCOPE_PARAM,
  withSolicitationScope,
} from '@/app/api/dashboard/solicitation/scope-param';
import { GET } from '../route';
import { POST } from '../reviewed/route';

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const DEFAULT_LOCATION_ID = '01900000-0000-7000-8000-0000000000d1';
const OTHER_LOCATION_ID = '01900000-0000-7000-8000-0000000000d2';
const FOREIGN_LOCATION_ID = '01900000-0000-7000-8000-0000000000d3';
const BATCH_ID = '01900000-0000-7000-8000-000000000001';

const BASE_URL = 'http://localhost:3000/api/dashboard/solicitation/batch';

function getRequest(query = ''): NextRequest {
  return new NextRequest(`${BASE_URL}${query}`);
}

function reviewedRequest(query = '', body: unknown = { batchId: BATCH_ID }): NextRequest {
  return new NextRequest(`${BASE_URL}/reviewed${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function ownerContext() {
  return {
    ok: true,
    accountId: ACCOUNT_ID,
    user: { id: 'u-1', locationId: DEFAULT_LOCATION_ID },
  };
}

beforeEach(() => {
  vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
  mockRequireOwnerWithAccount.mockResolvedValue(ownerContext());
  mockRequireWritableOwner.mockResolvedValue(ownerContext());
  mockMultiLocationEnabled.mockReturnValue(false);
  mockGetLocationById.mockImplementation((_sql: unknown, locationId: string) => {
    if (locationId === FOREIGN_LOCATION_ID) {
      return Promise.resolve({ id: locationId, account_id: 'someone-else', archived_at: null });
    }
    return Promise.resolve({ id: locationId, account_id: ACCOUNT_ID, archived_at: null });
  });
  mockReadLatestBatch.mockResolvedValue({ state: 'no_batch', contactsOnFile: 0 });
  mockMarkBatchReviewed.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('GET/POST /api/dashboard/solicitation/batch', () => {
  it('returns 404 before auth when SOLICITATION_WATCH_ENABLED is off', async () => {
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', undefined);

    const get = await GET(getRequest());
    const post = await POST(reviewedRequest());

    expect(get.status).toBe(404);
    expect(post.status).toBe(404);
    // A 404 status alone does not prove gate order — the surface must not
    // exist, so no auth work may have happened (invariant #13).
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockReadLatestBatch).not.toHaveBeenCalled();
    expect(mockMarkBatchReviewed).not.toHaveBeenCalled();
  });

  it('rejects aggregate location scope with 400', async () => {
    mockMultiLocationEnabled.mockReturnValue(true);

    const get = await GET(getRequest(`?${SOLICITATION_SCOPE_PARAM}=all`));
    const post = await POST(reviewedRequest(`?${SOLICITATION_SCOPE_PARAM}=all`));

    expect(get.status).toBe(400);
    expect(post.status).toBe(400);
    expect(mockReadLatestBatch).not.toHaveBeenCalled();
    expect(mockMarkBatchReviewed).not.toHaveBeenCalled();
  });

  it('returns uniform 404 for a location owned by another account', async () => {
    const response = await GET(getRequest(withSolicitationScope('', FOREIGN_LOCATION_ID)));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Business not found' });
    expect(mockReadLatestBatch).not.toHaveBeenCalled();
  });

  it('reads the location named by the scope param, not the owner default', async () => {
    mockReadLatestBatch.mockResolvedValue({
      state: 'built',
      batchId: BATCH_ID,
      builtAt: '2026-07-20 11:00:00+00',
      contactsOnFile: 3,
      evaluated: 3,
      queued: 1,
      held: 2,
      groups: [],
    });

    const response = await GET(getRequest(withSolicitationScope('', OTHER_LOCATION_ID)));

    expect(response.status).toBe(200);
    expect(mockReadLatestBatch).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      OTHER_LOCATION_ID,
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ state: 'built', batchId: BATCH_ID }),
    );
  });

  it('does not write reviewed_at on the read path', async () => {
    await GET(getRequest());

    expect(mockMarkBatchReviewed).not.toHaveBeenCalled();
  });

  it('records reviewed_at against the scoped location and answers 204', async () => {
    const response = await POST(
      reviewedRequest(withSolicitationScope('', OTHER_LOCATION_ID)),
    );

    expect(response.status).toBe(204);
    expect(mockMarkBatchReviewed).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      OTHER_LOCATION_ID,
      BATCH_ID,
    );
  });

  it('maps a malformed batchId onto the uniform 404', async () => {
    const response = await POST(reviewedRequest('', { batchId: 'not-a-uuid' }));

    expect(response.status).toBe(404);
    expect(mockMarkBatchReviewed).not.toHaveBeenCalled();
  });
});
