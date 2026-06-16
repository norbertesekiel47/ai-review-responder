import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────
//
// The route builds its UPDATE with the Postgres.js dynamic-column helper:
//   sql`UPDATE businesses SET ${sql(updates)}, updated_at = NOW() WHERE ...`
// The mock sql mirrors the real dispatch: a tagged-template call routes to
// mockSqlQuery(strings, ...values); a helper call (the column-value object
// from sql(updates)) returns a { __helper } marker that shows up among the
// bound values — so tests assert bound values + the updates object instead of
// assembled SQL strings. (Same dialect as the settings route test.)

const {
  mockRequireRole,
  mockSqlQuery,
  mockGetLocationsForAccount,
  mockAssertWritableSubscriptionForAccount,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockGetLocationsForAccount: vi.fn(),
  mockAssertWritableSubscriptionForAccount: vi.fn(),
}));

function isTemplate(arg: unknown): arg is TemplateStringsArray {
  return Array.isArray(arg) && Object.prototype.hasOwnProperty.call(arg, 'raw');
}

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
  const sql = (...args: unknown[]) => {
    if (isTemplate(args[0])) {
      return mockSqlQuery(args[0], ...args.slice(1));
    }
    // sql(updates) dynamic-column helper → opaque marker
    return { __helper: args[0] };
  };
  return { sql };
});

// ── Mock locations repo ─────────────────────────────────────────────

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: (...args: unknown[]) => mockGetLocationsForAccount(...args),
  getActiveLocationCount: vi.fn().mockResolvedValue(2),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

// Import AFTER mocks
import { GET, PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID_1 = 'b1111111-0000-4000-8000-000000000001';
const LOCATION_ID_2 = 'b2222222-0000-4000-8000-000000000002';
const APP_URL = 'http://localhost:3000';

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
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

// Returns the UPDATE template call (and its bound args), or undefined.
function updateCall(): unknown[] | undefined {
  return mockSqlQuery.mock.calls.find(
    (c) => isTemplate(c[0]) && (c[0] as unknown as string[]).join(' ').includes('UPDATE businesses'),
  ) as unknown[] | undefined;
}

function updatesMarkerOf(call: unknown[] | undefined): Record<string, unknown> | undefined {
  const marker = call?.find(
    (a) => a !== null && typeof a === 'object' && '__helper' in (a as object),
  ) as { __helper: Record<string, unknown> } | undefined;
  return marker?.__helper;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns voice config for a specific location', async () => {
    mockSqlQuery.mockResolvedValueOnce([{
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

    mockSqlQuery.mockResolvedValueOnce([{
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
    mockSqlQuery.mockResolvedValueOnce([]);

    const res = await GET(makeGetRequest({ locationId: '99999999-0000-4000-8000-000000000001' }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns defaults for null voice fields', async () => {
    mockSqlQuery.mockResolvedValueOnce([{
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
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('updates tone for a specific location', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }]) // location-validation SELECT
      .mockResolvedValueOnce({ count: 1 });           // UPDATE

    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'warm, friendly',
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('returns 404 when location not found or not accessible', async () => {
    mockSqlQuery.mockResolvedValueOnce([]); // SELECT finds nothing

    const res = await PUT(makePutRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      tone: 'warm',
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when no voice fields provided', async () => {
    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user has no account', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser(), accountId: null });

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));
    expect(res.status).toBe(403);
  });

  it('returns 402 without updating when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockSqlQuery).not.toHaveBeenCalled();
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

  it('binds account_id as a parameterized value in the UPDATE WHERE clause (not interpolated)', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }])
      .mockResolvedValueOnce({ count: 1 });

    await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'professional' }));

    const call = updateCall();
    expect(call).toBeDefined();
    const templateText = (call![0] as unknown as string[]).join(' ');
    expect(templateText).toContain('account_id');     // column is referenced in SQL
    expect(templateText).not.toContain(ACCOUNT_ID);    // value is NOT interpolated into SQL text
    const boundValues = call!.slice(1).filter((a) => typeof a === 'string');
    expect(boundValues).toContain(ACCOUNT_ID);         // value IS passed as a bound parameter
  });

  it.each([
    ['tone', 'tone', 'casual'],
    ['productsServices', 'products_services', 'Coffee'],
    ['productsServices', 'products_services', null],
    ['avoidFacts', 'avoid_facts', ['no refunds']],
    ['sampleResponses', 'sample_responses', ['Thanks!']],
  ] as const)('maps schema field %s → column %s', async (field, column, value) => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }])
      .mockResolvedValueOnce({ count: 1 });

    await PUT(makePutRequest({ locationId: LOCATION_ID_1, [field]: value }));

    expect(updatesMarkerOf(updateCall())).toEqual({ [column]: value });
  });
});
