import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockRequireRole, mockSql, mockSqlUnsafe, mockGetLocationsForAccount } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockSqlUnsafe: vi.fn(),
  mockGetLocationsForAccount: vi.fn(),
}));

// ── Mock Auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...args: unknown[]) => mockSql(...args), {
    unsafe: (...args: unknown[]) => mockSqlUnsafe(...args),
  });
  return { sql: sqlProxy };
});

// ── Mock locations repo ─────────────────────────────────────────────

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: (...args: unknown[]) => mockGetLocationsForAccount(...args),
  getActiveLocationCount: vi.fn().mockResolvedValue(2),
}));

// Import AFTER mocks
import { GET, PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID_1 = 'b1111111-0000-4000-8000-000000000001';
const LOCATION_ID_2 = 'b2222222-0000-4000-8000-000000000002';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID_1,
  };
}

function makeGetRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/settings/voice');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url.toString());
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/voice', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('returns voice config for a specific location', async () => {
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
      tone: 'professional',
      products_services: 'Coffee and pastries',
      avoid_facts: ['No discounts'],
      sample_responses: ['Thanks for the review!'],
    }]);

    const res = await GET(makeGetRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.locationId).toBe(LOCATION_ID_1);
    expect(body.tone).toBe('professional');
    expect(body.productsServices).toBe('Coffee and pastries');
    expect(body.avoidFacts).toEqual(['No discounts']);
    expect(body.sampleResponses).toEqual(['Thanks for the review!']);
    expect(body.displayName).toBe('Downtown Cafe');
  });

  it('returns voice config for all locations', async () => {
    mockGetLocationsForAccount.mockResolvedValue([
      { id: LOCATION_ID_1, name: 'Downtown Cafe', display_label: 'Downtown Cafe', is_primary: true, archived_at: null, google_place_id: null, created_at: new Date(), account_id: ACCOUNT_ID },
      { id: LOCATION_ID_2, name: 'Westside Bakery', display_label: 'Westside Bakery', is_primary: false, archived_at: null, google_place_id: null, created_at: new Date(), account_id: ACCOUNT_ID },
    ]);

    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
      tone: 'professional',
      products_services: 'Coffee',
      avoid_facts: null,
      sample_responses: null,
      is_primary: true,
    }, {
      id: LOCATION_ID_2,
      name: 'Westside Bakery',
      display_label: 'Westside Bakery',
      tone: 'warm, friendly',
      products_services: 'Baked goods',
      avoid_facts: ['No delivery'],
      sample_responses: null,
      is_primary: false,
    }]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.locations).toHaveLength(2);
    expect(body.locations[0].locationId).toBe(LOCATION_ID_1);
    expect(body.locations[0].isPrimary).toBe(true);
    expect(body.locations[1].locationId).toBe(LOCATION_ID_2);
  });

  it('returns 404 when location not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(makeGetRequest({ locationId: '99999999-0000-4000-8000-000000000001' }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns defaults for null voice fields', async () => {
    mockSql.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Test',
      display_label: null,
      tone: null,
      products_services: null,
      avoid_facts: null,
      sample_responses: null,
    }]);

    const res = await GET(makeGetRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tone).toBe('');
    expect(body.productsServices).toBe('');
    expect(body.avoidFacts).toEqual([]);
    expect(body.sampleResponses).toEqual([]);
    expect(body.displayName).toBe('Test');
  });
});

describe('PUT /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('updates tone for a specific location', async () => {
    // Mock location validation
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID_1 }]);
    mockSqlUnsafe.mockResolvedValue({ count: 1 });

    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'warm, friendly',
    }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when location not found or not accessible', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await PUT(makePutRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      tone: 'warm',
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when no voice fields provided', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
    }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user has no account', async () => {
    mockRequireRole.mockResolvedValue({
      ...ownerUser(),
      accountId: null,
    });

    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'warm',
    }));
    expect(res.status).toBe(403);
  });

  it('validates avoidFacts max length (500 chars)', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      avoidFacts: ['a'.repeat(501)],
    }));
    expect(res.status).toBe(400);
  });

  it('validates sampleResponses max count (10)', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      sampleResponses: Array(11).fill('test'),
    }));
    expect(res.status).toBe(400);
  });

  it('includes account_id in WHERE clause for security', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID_1 }]);
    mockSqlUnsafe.mockResolvedValue({ count: 1 });

    await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'professional',
    }));

    const [query, values] = mockSqlUnsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('account_id');
    expect(values).toContain(ACCOUNT_ID);
  });
});
