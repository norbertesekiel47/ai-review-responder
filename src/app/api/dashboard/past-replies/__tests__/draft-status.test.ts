import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  accountQueue,
  topLevelQueue,
  sqlProxy,
  sqlReadProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();

  const accountQueue: unknown[][] = [];
  const topLevelQueue: unknown[][] = [];

  // sql (write pool): the resolveOwnerScope auth preamble stays on it — the
  // subscription-gate SELECT it fires internally (plan #477 Task 1 wiring
  // decision: shared auth helper is never threaded onto sqlRead).
  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) {
      const nextAccount = accountQueue.shift();
      if (nextAccount) return nextAccount;
      return [{ subscription_status: 'active' }];
    }
    return [];
  });
  const sqlProxy = new Proxy(sqlMock, {
    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
  });

  const isExecutedStatement = (text: string) =>
    /^\s*(select|insert|update|delete|with)\b/i.test(text);

  // sqlRead (read bulkhead): the route-body reads (job_outbox lookup + the
  // completed-job response lookup) moved off write `sql` onto it (#477 Task 1).
  // Fragment builds (the `responses.id` ref, the openFlagExistsSql `EXISTS (…)`)
  // are captured in mock.calls for assertions but must NOT consume the queued
  // result of the outer executed query (#730 T4).
  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (!isExecutedStatement(text)) return { fragmentText: text, values };
    return Promise.resolve(topLevelQueue.shift() ?? []);
  });
  const sqlReadProxy = new Proxy(sqlReadMock, {
    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    accountQueue,
    topLevelQueue,
    sqlProxy,
    sqlReadProxy,
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
  sqlRead: sqlReadProxy,
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
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: requireRole succeeds; getRequestScope resolves to primary location.
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
});

async function importGET() {
  const mod = await import('../draft-status/route');
  return mod.GET as (req: NextRequest) => Promise<Response>;
}

function expectNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toContain('no-store');
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/dashboard/past-replies/draft-status', () => {
  it('returns 503 feature_disabled when flag is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(503);
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(401);
    expectNoStore(res);
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
    expectNoStore(res);
    expect(await res.json()).toEqual({ error: 'missing_outbox_id' });
  });

  it('returns 404 outbox_not_found when outbox row is missing', async () => {
    seedTopLevel([]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(404);
    expectNoStore(res);
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
    expectNoStore(res);
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
    expectNoStore(res);
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
    expectNoStore(res);
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

// ── #726 moderation-held draft gate ─────────────────────────────────
//
// A moderation-held draft (invariant #4) "surfaces neither its text nor any
// button" — the poller must answer with the owner-visible refusal vocabulary
// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
// is the semantic owner of "is this draft held"; the poller composes its
// openFlagExistsSql fragment (#730) into the tenant-scoped response lookup,
// projected as `held`.

// Unique sentinels: heldness refusals assert these appear NOWHERE in the
// serialized body — a leak of either is an invariant #4 violation.
const SENTINEL_HELD_ID = 'SENTINEL_HELD_ID_84c1f0d2e6b34c5f';
const SENTINEL_HELD_TEXT = 'SENTINEL_HELD_TEXT_9b3e5a710d2c4e8a';

function seedCompletedOutbox() {
  seedTopLevel([
    {
      status: 'completed',
      payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
      last_error: null,
      aggregate_id: REVIEW_ID,
    },
  ]);
}

describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
    seedCompletedOutbox();
    // Response row resolves for the caller's location but carries an OPEN flag.
    seedTopLevel([
      {
        id: SENTINEL_HELD_ID,
        status: 'pending_approval',
        response_text: SENTINEL_HELD_TEXT,
        business_id: LOCATION_ID,
        held: true,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SENTINEL_HELD_ID);
    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
    // Exactly the safe shape — nothing but the refusal vocabulary.
    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
  });

  it("returns the draft text when the resolved response's moderation flag is closed", async () => {
    // Deliberate GREEN characterization: a closed flag (held: false) is the
    // release path — the draft text surfaces exactly as today.
    seedCompletedOutbox();
    seedTopLevel([
      {
        id: SENTINEL_HELD_ID,
        status: 'pending_approval',
        response_text: SENTINEL_HELD_TEXT,
        business_id: LOCATION_ID,
        held: false,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_id: SENTINEL_HELD_ID,
      status: 'pending_approval',
      response_text: SENTINEL_HELD_TEXT,
    });
  });

  it('spells the correlated open-flag EXISTS with status open inside the tenant-scoped response lookup', async () => {
    // SQL-text assertion (held-draft.test.ts technique): the heldness
    // predicate is composed into the response lookup via openFlagExistsSql
    // (#730) — the poller projects the held-draft.ts semantics, so the
    // EXISTS text lives in the fragment's captured build call.
    seedCompletedOutbox();
    seedTopLevel([
      {
        id: SENTINEL_HELD_ID,
        status: 'pending_approval',
        response_text: SENTINEL_HELD_TEXT,
        business_id: LOCATION_ID,
        held: false,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);

    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
    const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');
    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
    expect(responseLookup).toBeDefined();
    // The outer lookup projects the composed fragment as `held`.
    expect(joinTemplate(responseLookup as unknown[])).toMatch(/AS held/);

    const existsCall = readCalls.find((call) => joinTemplate(call).includes('FROM flagged_responses'));
    expect(existsCall).toBeDefined();
    const text = joinTemplate(existsCall as unknown[]);
    expect(text).toMatch(/EXISTS/);
    expect(text).toMatch(/flagged_responses/);
    expect(text).toMatch(/fr\.response_id\s*=/);
    expect(text).toMatch(/fr\.status\s*=\s*'open'/);
    // Correlation predicate: an uncorrelated EXISTS (any open flag anywhere
    // holds every poll) would over-refuse fail-safe but still betray the
    // query's contract — assert the ref embedded in the EXISTS build call is
    // the outer `responses.id` fragment.
    const embeddedRef = (existsCall as unknown[])[1] as { fragmentText?: string };
    expect(embeddedRef?.fragmentText).toBe('responses.id');
  });

  // #730 T4: pins that the openFlagExistsSql fragment lands correlated against
  // the right response alias in every awaited query of the draft-status routes.
  it('each draft-status awaited query projects held from its correctly correlated response alias', async () => {
    seedCompletedOutbox();
    seedTopLevel([
      {
        id: SENTINEL_HELD_ID,
        status: 'pending_approval',
        response_text: SENTINEL_HELD_TEXT,
        business_id: LOCATION_ID,
        held: false,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(200);

    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
    const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');
    const refCall = readCalls.find((call) => joinTemplate(call).trim() === 'responses.id');
    expect(refCall, 'fragment ref must correlate on the outer query alias').toBeDefined();
    const existsCall = readCalls.find((call) => joinTemplate(call).includes('FROM flagged_responses'));
    expect(existsCall).toBeDefined();
    expect(joinTemplate(existsCall as unknown[])).toContain("fr.status = 'open'");
    // Symmetry with the reviews-route #9: the EXISTS build call embeds the
    // outer `responses.id` ref fragment.
    const embeddedRef = (existsCall as unknown[])[1] as { fragmentText?: string };
    expect(embeddedRef?.fragmentText).toBe('responses.id');
    // Built is not enough — the fragment must LAND in the executed response
    // lookup: a refactor that builds the EXISTS but projects `false AS held`
    // would otherwise pass. mock.calls entries are raw arg arrays
    // `[strings, ...values]`, so the executed call's values are `.slice(1)`.
    const responseLookup = readCalls.find((call) => {
      const text = joinTemplate(call);
      return /^\s*select\b/i.test(text) && text.includes('FROM responses');
    });
    expect(responseLookup).toBeDefined();
    expect(
      (responseLookup as unknown[])
        .slice(1)
        .some((v) => (v as { fragmentText?: string }).fragmentText?.includes('FROM flagged_responses') ?? false),
    ).toBe(true);
  });

  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
    // Deliberate GREEN characterization locking tenant-before-held ordering:
    // the tenant re-check must win over any held branching, and the refusal
    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
    seedCompletedOutbox();
    seedTopLevel([
      {
        id: SENTINEL_HELD_ID,
        status: 'pending_approval',
        response_text: SENTINEL_HELD_TEXT,
        business_id: OTHER_LOCATION_ID,
        held: true,
      },
    ]);
    const GET = await importGET();
    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
    expect(res.status).toBe(403);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SENTINEL_HELD_ID);
    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
    expect(serialized).not.toContain('held');
    expect(body).toEqual({ error: 'forbidden' });
  });
});
