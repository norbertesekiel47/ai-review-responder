import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  accountQueue,
  topLevelQueue,
  sqlProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();

  const accountQueue: unknown[][] = [];
  const topLevelQueue: unknown[][] = [];
  const topLevelMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) {
      const nextAccount = accountQueue.shift();
      if (nextAccount) return nextAccount;
      return [{ subscription_status: 'active' }];
    }
    return topLevelQueue.shift() ?? [];
  });

  const sqlProxy = new Proxy(topLevelMock, {
    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    accountQueue,
    topLevelQueue,
    topLevelMock,
    sqlProxy,
  };
});

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: sqlProxy,
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
// A second location on the same account — used for non-primary scoping tests.
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
const OTHER_LOCATION_ID = '01234567-0000-7000-8000-000000000099';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const RESPONSE_ID = '01234567-0000-7000-8000-0000000000bb';
const OUTBOX_ID = '01234567-0000-7000-8000-0000000000cc';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ accountId: string | null }>) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
  };
}

function makeRequest(opts?: {
  outboxId?: string | null;
  locationScopeCookie?: string;
}): NextRequest {
  const params = new URLSearchParams();
  if (opts?.outboxId !== undefined && opts.outboxId !== null) {
    params.set('outbox_id', opts.outboxId);
  }
  const qs = params.toString();
  const url = `${APP_URL}/api/dashboard/past-replies/draft-status${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {};
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  return new NextRequest(url, { method: 'GET', headers });
}

function seedTopLevel(...rowsets: unknown[][]) {
  topLevelQueue.push(...rowsets);
}

function seedAccountRows(rows: unknown[]) {
  accountQueue.push(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  accountQueue.length = 0;
  topLevelQueue.length = 0;
  process.env.PAST_REPLIES_VIEW_ENABLED = 'true';
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: requireRole succeeds; getRequestScope resolves to primary location.
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
  delete process.env.PAST_REPLIES_VIEW_ENABLED;
});

async function importGET() {
  const mod = await import('../draft-status/route');
  return mod.GET as (req: NextRequest) => Promise<Response>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/dashboard/past-replies/draft-status', () => {
  it('returns 503 feature_disabled when flag is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(401);
  });

  it('returns 403 no_business when accountId is missing', async () => {
    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null }));
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'no_business' });
  });

  it('returns 400 missing_outbox_id when query param is absent', async () => {
    const GET = await importGET();
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_outbox_id' });
  });

  it('returns 404 outbox_not_found when outbox row is missing', async () => {
    seedTopLevel([]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'outbox_not_found' });
  });

  it('returns 403 forbidden when payload.business_id mismatches resolved locationId (TENANT LEAK GUARD)', async () => {
    // Outbox payload belongs to a DIFFERENT location — must NOT leak status.
    seedTopLevel([
      {
        status: 'completed',
        payload: { business_id: OTHER_LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it("returns { status: 'generating' } for pending status", async () => {
    seedTopLevel([
      {
        status: 'pending',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
  });

  it('allows read-only past_due accounts to poll existing draft status', async () => {
    seedAccountRows([{
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 8 * 86_400_000),
      flags: {},
    }]);
    seedTopLevel([
      {
        status: 'pending',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);

    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
  });

  it("returns { status: 'generating' } for dispatching status", async () => {
    seedTopLevel([
      {
        status: 'dispatching',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
  });

  it("returns { status: 'generating' } for dispatched status", async () => {
    seedTopLevel([
      {
        status: 'dispatched',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
  });

  it("returns { status: 'failed', error } for failed outbox", async () => {
    seedTopLevel([
      {
        status: 'failed',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: 'LLM call exceeded budget',
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'failed', error: 'LLM call exceeded budget' });
  });

  it('returns { response_id, status, response_text } for completed outbox with matching response row', async () => {
    seedTopLevel(
      // 1. outbox lookup
      [
        {
          status: 'completed',
          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
          last_error: null,
          aggregate_id: REVIEW_ID,
        },
      ],
      // 2. response lookup
      [
        {
          id: RESPONSE_ID,
          status: 'pending_approval',
          response_text: 'Generated draft text',
          business_id: LOCATION_ID,
        },
      ],
    );
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_id: RESPONSE_ID,
      status: 'pending_approval',
      response_text: 'Generated draft text',
    });
  });

  it('returns 404 response_not_found when completed but no response row matches', async () => {
    seedTopLevel(
      // 1. outbox lookup — completed
      [
        {
          status: 'completed',
          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
          last_error: null,
          aggregate_id: REVIEW_ID,
        },
      ],
      // 2. response lookup — empty (worker may have failed to insert; race window)
      [],
    );
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'response_not_found' });
  });

  it('returns 403 if completed response row belongs to another location (defense in depth)', async () => {
    seedTopLevel(
      // 1. outbox payload passes tenant check (business_id matches caller's location)
      [
        {
          status: 'completed',
          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
          last_error: null,
          aggregate_id: REVIEW_ID,
        },
      ],
      // 2. response row belongs to a DIFFERENT location — defense-in-depth must block.
      [
        {
          id: RESPONSE_ID,
          status: 'pending_approval',
          response_text: 'Should not leak',
          business_id: OTHER_LOCATION_ID,
        },
      ],
    );
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('parses JSONB payload that comes back as a string (Postgres.js + PgBouncer guard)', async () => {
    // Payload arrives as a JSON-encoded string — handler must JSON.parse it.
    seedTopLevel([
      {
        status: 'pending',
        payload: JSON.stringify({ business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 }),
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
  });

  it('scopes to ALT_LOCATION_ID when rw_location_scope cookie is set (non-primary regression)', async () => {
    // Simulate owner switching to a non-primary location via the cookie.
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    // Outbox belongs to ALT location — should succeed.
    seedTopLevel(
      [
        {
          status: 'pending',
          payload: { business_id: ALT_LOCATION_ID, review_id: REVIEW_ID, version: 1 },
          last_error: null,
          aggregate_id: REVIEW_ID,
        },
      ],
    );
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'generating' });
    // Verify getRequestScope was called with the ALT location from the cookie.
    // Leading arg is the sql client resolveOwnerScope threads through (A+ campaign 2a).
    expect(mockGetRequestScope).toHaveBeenCalledWith(sqlProxy, ACCOUNT_ID, ALT_LOCATION_ID);
  });

  it('returns 403 when polling a PRIMARY location outbox while scoped to ALT_LOCATION (cross-scope guard)', async () => {
    // Owner scoped to ALT — should NOT see outbox from the primary location.
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    seedTopLevel([
      {
        status: 'pending',
        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
        last_error: null,
        aggregate_id: REVIEW_ID,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});
