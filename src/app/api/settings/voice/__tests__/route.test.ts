import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────
//
// GET still reads through the route's own `sql`: the mock mirrors the real
// dispatch — a tagged-template call routes to mockSqlQuery(strings, ...values);
// a helper call (a column-value object) returns a { __helper } marker among the
// bound values, so tests assert bound values instead of assembled SQL strings.
//
// PUT no longer builds SQL here. It opens one `sql.begin` and hands the work to
// `updateVoiceConfig` (src/lib/responses/voice-settings.ts), so the PUT cases
// assert at that seam: which collaborator is called, with what, and how each
// result maps to a status. The SQL-level guarantees those cases used to pin —
// the `FOR UPDATE` lock, the account-scoped WHERE, and `account_id` bound as a
// parameter rather than interpolated — are asserted against the real writer in
// src/lib/responses/__tests__/voice-settings.test.ts.

const {
  mockRequireRole,
  mockSqlQuery,
  mockSqlBegin,
  mockGetLocationsForAccount,
  mockAssertWritableSubscriptionForAccount,
  mockUpdateVoiceConfig,
} = vi.hoisted(() => {
  // The transaction handle the route forwards to the writer. The writer is
  // mocked here, so the double only has to be identifiable.
  const tx = { __tx: true };
  return {
    mockRequireRole: vi.fn(),
    mockSqlQuery: vi.fn(),
    mockSqlBegin: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
    mockGetLocationsForAccount: vi.fn(),
    mockAssertWritableSubscriptionForAccount: vi.fn(),
    mockUpdateVoiceConfig: vi.fn(),
  };
});

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
  // Tagged-template calls (the GET reads) route to mockSqlQuery; sql.begin
  // (the PUT transaction) stays on mockSqlBegin.
  const sql = Object.assign(
    (...args: unknown[]) => {
      if (isTemplate(args[0])) {
        return mockSqlQuery(args[0], ...args.slice(1));
      }
      // sql(updates) dynamic-column helper → opaque marker
      return { __helper: args[0] };
    },
    {
      begin: (...args: unknown[]) => mockSqlBegin(...(args as Parameters<typeof mockSqlBegin>)),
    },
  );
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

// ── Mock the shared voice writer ────────────────────────────────────
//
// Only `updateVoiceConfig` is replaced; VOICE_FIELD_TO_COLUMN stays real, so
// the field → column table below still asserts the one live map.
vi.mock('@/lib/responses/voice-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/responses/voice-settings')>()),
  updateVoiceConfig: (...args: unknown[]) => mockUpdateVoiceConfig(...args),
}));

// Import AFTER mocks
import { GET, PUT } from '../route';
import { AuthError } from '@/lib/db/auth';
import { VOICE_FIELD_TO_COLUMN } from '@/lib/responses/voice-settings';

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

// The single input the route hands the shared writer, or undefined when the
// request never reached it.
function writerInput(): { accountId: string; locationId: string; fields: Record<string, unknown> } | undefined {
  const call = mockUpdateVoiceConfig.mock.calls[0];
  return call?.[1] as { accountId: string; locationId: string; fields: Record<string, unknown> } | undefined;
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
    // TWO reads now, in this order: `readVoiceConfig` — the shared reader the
    // Owner Operator uses, which owns the account-scoped 404 — and then the
    // display-label read, which is a different concern.
    mockSqlQuery.mockResolvedValueOnce([{
      tone: 'professional',
      products_services: 'Coffee and pastries',
      avoid_facts: ['No discounts'],
      highlight_facts: null,
      sample_responses: ['Thanks for the review!'],
      updated_at: '2026-09-11 10:00:00.123456+00',
    }]);
    mockSqlQuery.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
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
      tone: null,
      products_services: null,
      avoid_facts: null,
      highlight_facts: null,
      sample_responses: null,
      updated_at: '2026-09-11 10:00:00.123456+00',
    }]);
    mockSqlQuery.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Test',
      display_label: null,
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
    mockUpdateVoiceConfig.mockResolvedValue({
      ok: true, updatedAt: '2026-09-11 10:00:00.123456+00',
    });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('updates tone for a specific location', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'warm, friendly',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The writer's **Version token** reaches the caller VERBATIM — the route
    // does not re-format it into an ISO string, which would truncate the
    // microseconds the token exists to carry.
    expect(body.updatedAt).toBe('2026-09-11 10:00:00.123456+00');

    // One transaction, one writer call, carrying the owner's account scope.
    expect(mockSqlBegin).toHaveBeenCalledTimes(1);
    expect(mockUpdateVoiceConfig).toHaveBeenCalledTimes(1);
    expect(writerInput()).toEqual({
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID_1,
      fields: { tone: 'warm, friendly' },
    });
    // The route itself issues no statements on the PUT path any more.
    expect(mockSqlQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when location not found or not accessible', async () => {
    // The ownership check is the writer's locking SELECT; a location outside
    // the account (or archived) comes back as location_not_found.
    mockUpdateVoiceConfig.mockResolvedValue({ ok: false, reason: 'location_not_found' });

    const res = await PUT(makePutRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      tone: 'warm',
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Location not found or not accessible' });
  });

  it('returns 400 when the writer reports no fields to update', async () => {
    mockUpdateVoiceConfig.mockResolvedValue({ ok: false, reason: 'no_fields' });

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No fields to update' });
  });

  it('returns 500 when the writer transaction throws', async () => {
    mockUpdateVoiceConfig.mockRejectedValue(new Error('deadlock detected'));

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update voice config' });
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
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
    expect(mockSqlQuery).not.toHaveBeenCalled();
    // The gate runs before the transaction opens, so nothing is written.
    expect(mockSqlBegin).not.toHaveBeenCalled();
    expect(mockUpdateVoiceConfig).not.toHaveBeenCalled();
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
    await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'professional' }));

    // The route hands the account scope to the writer as a structured value and
    // assembles no SQL of its own, so there is no text for it to interpolate
    // into. That the writer then binds it as a parameter — in the locking
    // SELECT and in the UPDATE WHERE — is asserted against the real
    // implementation in src/lib/responses/__tests__/voice-settings.test.ts.
    expect(writerInput()?.accountId).toBe(ACCOUNT_ID);
    expect(mockSqlQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['tone', 'tone', 'casual'],
    ['productsServices', 'products_services', 'Coffee'],
    ['productsServices', 'products_services', null],
    ['avoidFacts', 'avoid_facts', ['no refunds']],
    ['highlightFacts', 'highlight_facts', ['award-winning espresso']],
    ['sampleResponses', 'sample_responses', ['Thanks!']],
  ] as const)('maps schema field %s → column %s', async (field, column, value) => {
    await PUT(makePutRequest({ locationId: LOCATION_ID_1, [field]: value }));

    // Two halves of the same guarantee: the route forwards the camel field
    // untouched, and the writer's one live map turns it into this column.
    expect(writerInput()?.fields).toEqual({ [field]: value });
    expect(VOICE_FIELD_TO_COLUMN[field]).toBe(column);
  });
});
