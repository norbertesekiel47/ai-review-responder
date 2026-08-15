import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────
//
// The route builds its UPDATEs with the Postgres.js dynamic helpers:
//   tx`UPDATE ${tx(table)} SET ${tx(updates)}, updated_at = NOW() WHERE id = ${id}`
// The mock tx mirrors the real sql() dispatch: a tagged-template call routes
// to mockTxQuery(strings, ...values); a helper call (identifier string or
// column-value object) returns a { __helper } marker that shows up among the
// bound values, so tests assert bound values + table identifiers instead of
// assembled SQL strings.

const {
  mockRequireRole,
  mockTxQuery,
  mockSqlQuery,
  mockSqlBegin,
  mockAssertWritableSubscriptionForAccount,
} = vi.hoisted(() => {
  const mockTxQuery = vi.fn();
  const mockSqlQuery = vi.fn();
  const tx = (...args: unknown[]) => {
    const [first] = args;
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      return mockTxQuery(first, ...args.slice(1));
    }
    return { __helper: first };
  };
  const mockSqlBegin = vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => {
    return callback(tx);
  });

  return {
    mockRequireRole: vi.fn(),
    mockTxQuery,
    mockSqlQuery,
    mockSqlBegin,
    mockAssertWritableSubscriptionForAccount: vi.fn(),
  };
});

type TxQueryCall = [TemplateStringsArray, ...unknown[]];

function txQueryCalls(): TxQueryCall[] {
  return mockTxQuery.mock.calls as TxQueryCall[];
}

function txQueryCall(index: number): TxQueryCall {
  const call = txQueryCalls()[index];
  if (!call) throw new Error(`expected a tx query call at index ${index}`);
  return call;
}

function queryText(call: TxQueryCall): string {
  return call[0].join(' ? ');
}

function tableOf(call: TxQueryCall): unknown {
  return (call[1] as { __helper: unknown }).__helper;
}

function updatesOf(call: TxQueryCall): unknown {
  return (call[2] as { __helper: unknown }).__helper;
}

function idOf(call: TxQueryCall): unknown {
  return call[3];
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
  // Tagged-template calls (the GET handler's single read) route to
  // mockSqlQuery; sql.begin (the PUT handler's transaction) stays on
  // mockSqlBegin.
  const sqlProxy = Object.assign(
    (...args: unknown[]) => mockSqlQuery(...args),
    {
      begin: (...args: unknown[]) => mockSqlBegin(...(args as Parameters<typeof mockSqlBegin>)),
    },
  );
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

// Import AFTER mocks
import { GET, PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const BUSINESS_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function makeRequest(body: unknown, opts: { origin?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new NextRequest('http://localhost:3000/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides?: { locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId:
      overrides && 'locationId' in overrides
        ? overrides.locationId
        : BUSINESS_ID,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PUT /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tx updates return count=1 (success)
    mockTxQuery.mockResolvedValue({ count: 1 });
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when Origin header is absent', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }, { origin: null }));
    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }, { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 403 when user has no locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('No business associated with this account');
  });

  it('returns 402 when the account is past-due read-only', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
    expect(mockSqlBegin).not.toHaveBeenCalled();
  });

  it('returns 400 for empty body {}', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('At least one field must be provided');
  });

  it('returns 200 for updating tone (business-only, issues only the businesses UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'professional' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);

    // One sql.begin call; one UPDATE (businesses only)
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledOnce();
    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('businesses');
    expect(updatesOf(call)).toEqual({ tone: 'professional' });
    expect(idOf(call)).toBe(BUSINESS_ID);
    expect(queryText(call)).toContain('updated_at = NOW()');
  });

  it('scopes the businesses UPDATE by account_id (defense-in-depth)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'professional' }));
    expect(res.status).toBe(200);

    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('businesses');
    expect(queryText(call)).toContain('account_id');
    // accountId is bound as a value alongside the locationId
    expect(call).toContain(ACCOUNT_ID);
    expect(idOf(call)).toBe(BUSINESS_ID);
  });

  it('returns 200 for toggling weeklySummaryEnabled to false (account-only, issues only the accounts UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ weeklySummaryEnabled: false }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledOnce();
    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('accounts');
    expect(updatesOf(call)).toEqual({ weekly_summary_enabled: false });
    expect(idOf(call)).toBe(ACCOUNT_ID);
  });

  it('returns 200 for toggling monthlyImpactEnabled to false (account-only, issues only the accounts UPDATE)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ monthlyImpactEnabled: false }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledOnce();
    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('accounts');
    expect(updatesOf(call)).toEqual({ monthly_impact_enabled: false });
    expect(idOf(call)).toBe(ACCOUNT_ID);
  });

  it('ignores business_id in body and uses user.locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(
      makeRequest({ tone: 'warm', business_id: 'attacker-id-999' }),
    );
    expect(res.status).toBe(200);

    expect(mockTxQuery).toHaveBeenCalledOnce();
    const call = txQueryCall(0);
    expect(idOf(call)).toBe(BUSINESS_ID);
    // business_id from body never appears in the bound updates or values
    expect(updatesOf(call)).toEqual({ tone: 'warm' });
    expect(call.slice(1)).not.toContain('attacker-id-999');
  });

  it('returns 404 when business not found (count=0)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // businesses update returns count=0 → not found
    mockTxQuery.mockResolvedValue({ count: 0 });

    const res = await PUT(makeRequest({ tone: 'casual' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  it('returns no-store Cache-Control header on success', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'friendly' }));
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 401 when requireRole throws AuthError(401)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await PUT(makeRequest({ tone: 'test' }));
    expect(res.status).toBe(401);
  });

  // ── New E2 tests ─────────────────────────────────────────────────

  it('both scopes in one tx: PUT { weeklySummaryEnabled, tone } issues accounts UPDATE AND businesses UPDATE inside one sql.begin', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ weeklySummaryEnabled: false, tone: 'warm' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Exactly one transaction with exactly two UPDATEs (businesses + accounts)
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledTimes(2);

    const businessesCall = txQueryCalls().find((call) => tableOf(call) === 'businesses');
    const accountsCall = txQueryCalls().find((call) => tableOf(call) === 'accounts');
    expect(businessesCall).toBeDefined();
    expect(accountsCall).toBeDefined();

    // accounts update binds accountId and the toggle column
    expect(updatesOf(accountsCall!)).toEqual({ weekly_summary_enabled: false });
    expect(idOf(accountsCall!)).toBe(ACCOUNT_ID);

    // businesses update binds locationId and tone
    expect(updatesOf(businessesCall!)).toEqual({ tone: 'warm' });
    expect(idOf(businessesCall!)).toBe(BUSINESS_ID);
  });

  it('account-only: PUT { monthlyImpactEnabled } issues ONLY the accounts UPDATE, no businesses UPDATE', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ monthlyImpactEnabled: true }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledOnce();

    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('accounts');
    expect(updatesOf(call)).toEqual({ monthly_impact_enabled: true });
    expect(idOf(call)).toBe(ACCOUNT_ID);
  });

  it('business-only: PUT { tone } issues ONLY the businesses UPDATE, no accounts UPDATE', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'casual' }));
    expect(res.status).toBe(200);

    expect(mockSqlBegin).toHaveBeenCalledOnce();
    expect(mockTxQuery).toHaveBeenCalledOnce();

    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('businesses');
    expect(updatesOf(call)).toEqual({ tone: 'casual' });
    expect(idOf(call)).toBe(BUSINESS_ID);
  });

  it('business-not-found rolls back: businesses count=0 returns 404 and rolls back the tx', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // Route runs businesses UPDATE first, then accounts UPDATE.
    // Simulate businesses returning count=0 (not found); accounts would be
    // skipped because the sentinel throw rolls back the tx.
    mockTxQuery.mockResolvedValueOnce({ count: 0 }); // businesses call → not found

    // Send both scopes so both updates would be attempted if tx continued
    const res = await PUT(makeRequest({ weeklySummaryEnabled: true, tone: 'warm' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Business not found');

    // The sql.begin was called; sentinel throw caused rollback before accounts UPDATE
    expect(mockSqlBegin).toHaveBeenCalledOnce();
    // Only one UPDATE — businesses; accounts never reached
    expect(mockTxQuery).toHaveBeenCalledOnce();
  });

  it('nullable business field: PUT { ownerPhone: null } binds NULL, not undefined', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ ownerPhone: null }));
    expect(res.status).toBe(200);

    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('businesses');
    expect(updatesOf(call)).toEqual({ owner_phone: null });
    expect(idOf(call)).toBe(BUSINESS_ID);
  });
});

// ── GET /api/settings (light settings payload) ──────────────────────

function settingsDbRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Biz',
    created_at: new Date('2026-01-01T00:00:00Z'),
    initial_review_count: 10,
    initial_responded_count: 3,
    baseline_captured_at: null,
    tone: 'warm',
    products_services: 'coffee',
    avoid_facts: ['no discounts'],
    sample_responses: [],
    owner_phone: '+15550001111',
    owner_email: 'owner@test.com',
    weekly_summary_enabled: true,
    monthly_impact_enabled: false,
    category: 'Cafe',
    google_place_id: 'gp-1',
    subscription_status: 'active',
    place_id_verified: true,
    google_maps_url: 'https://maps.google.com/x',
    onboarding_wizard_completed_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings', { method: 'GET' });
}

describe('GET /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlQuery.mockResolvedValue([settingsDbRow()]);
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns the light business + settings payload for an active owner', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.business).toEqual({ name: 'Test Biz', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(body.settings).toMatchObject({
      tone: 'warm',
      productsServices: 'coffee',
      avoidFacts: ['no discounts'],
      ownerPhone: '+15550001111',
      ownerEmail: 'owner@test.com',
      weeklySummaryEnabled: true,
      monthlyImpactEnabled: false,
      category: 'Cafe',
      googlePlaceId: 'gp-1',
    });
    // No heavy dashboard payload fields leak into the light endpoint.
    expect(body.recentReviews).toBeUndefined();
    expect(body.ranking).toBeUndefined();
  });

  it('past_due keeps read access (grace window mirrors the dashboard)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([settingsDbRow({ subscription_status: 'past_due' })]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toBeDefined();
  });

  it('settings pending_payment response returns the server-computed funnelUrl', async () => {
    // Mirrors /api/dashboard: `funnelUrl` replaced the hardcoded absolute
    // `paymentUrl`, and the destination comes from `resolveFunnelEntry` so the
    // pre-pay demo lane is honoured.
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([settingsDbRow({ subscription_status: 'pending_payment' })]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.funnelUrl).toBe('/onboarding/pay');
    expect(body.paymentUrl).toBeUndefined();
    expect(body.settings).toBeUndefined();

    // Demo on + a captured place → the demo return point, not the paywall.
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    expect((await (await GET(makeGetRequest())).json()).funnelUrl).toBe('/onboarding/demo');

    // Demo on + nothing captured → the location picker.
    mockSqlQuery.mockResolvedValue([
      settingsDbRow({
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ]);
    expect((await (await GET(makeGetRequest())).json()).funnelUrl).toBe('/onboarding/start');
    delete process.env.ONBOARDING_DEMO_ENABLED;
  });

  it('admin-onboarded pending_payment gets the ordinary pending_payment response', async () => {
    // The `onboarded_by !== null` handoff branch is deleted — the column is not
    // even selected any more. An admin-invited owner is redirected into the
    // same funnel as a self-serve one.
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([
      settingsDbRow({ subscription_status: 'pending_payment', onboarded_by: 'admin-1' }),
    ]);

    const res = await GET(makeGetRequest());
    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.funnelUrl).toBe('/onboarding/pay');
  });

  it('active owner who never finished the business wizard → active_pending_business', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([
      settingsDbRow({ place_id_verified: false, google_maps_url: null }),
    ]);

    const res = await GET(makeGetRequest());
    const body = await res.json();
    expect(body.subscriptionStatus).toBe('active_pending_business');
    expect(body.settings).toBeUndefined();
  });

  it('cancelled account → 403 subscription_inactive', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([settingsDbRow({ subscription_status: 'cancelled' })]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('subscription_inactive');
  });

  it('returns 404 when the business row is missing', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockSqlQuery.mockResolvedValue([]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(404);
  });

  it('returns 403 when user has no locationId', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: null }));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(mockSqlQuery).not.toHaveBeenCalled();
  });
});
