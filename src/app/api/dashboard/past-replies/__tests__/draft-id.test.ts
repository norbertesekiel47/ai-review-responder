import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  mockAssertCanEdit,
  mockValidateOptimistic,
  topLevelQueue,
  topLevelMock,
  txQueue,
  txMock,
  beginMock,
  sqlProxy,
  mockOffboardingRows,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();
  const mockAssertCanEdit = vi.fn();
  const mockValidateOptimistic = vi.fn();
  const mockOffboardingRows: { value: unknown[] } = { value: [] };

  // Top-level sql`...` calls (outside sql.begin) consume from this queue.
  const topLevelQueue: unknown[][] = [];
  const topLevelMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) {
      return [{ subscription_status: 'active' }];
    }
    if (text.includes('FROM account_offboardings')) {
      return mockOffboardingRows.value;
    }
    return topLevelQueue.shift() ?? [];
  });

  // Each call to tx`...` returns the next array from the queue.
  const txQueue: unknown[][] = [];
  const txMock = vi.fn(async () => txQueue.shift() ?? []);

  // sql.begin runs the callback synchronously with the tx mock.
  const beginMock = vi.fn(async (cb: (tx: unknown) => Promise<Response>) => cb(txMock));

  const sqlProxy = new Proxy(topLevelMock, {
    get: (_t, prop) => {
      if (prop === 'begin') return beginMock;
      return undefined;
    },
    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    mockAssertCanEdit,
    mockValidateOptimistic,
    topLevelQueue,
    topLevelMock,
    txQueue,
    txMock,
    beginMock,
    sqlProxy,
    mockOffboardingRows,
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

vi.mock('@/lib/responses/edit-existing', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/responses/edit-existing')>(
      '@/lib/responses/edit-existing',
    );
  return {
    ...actual,
    assertCanEditReply: (...args: unknown[]) => mockAssertCanEdit(...args),
    validateOptimisticConcurrency: (...args: unknown[]) => mockValidateOptimistic(...args),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
// A second location on the same account — used to verify cookie-based scoping.
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const RESPONSE_ID = '01234567-0000-7000-8000-0000000000bb';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ locationId: string | null; accountId: string | null; id: string }>) {
  return {
    id: overrides?.id ?? 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : LOCATION_ID,
  };
}

function makeRequest(opts?: {
  method?: 'PATCH' | 'DELETE';
  body?: unknown;
  origin?: string | null;
  responseIdInUrl?: string;
  locationScopeCookie?: string;
}): NextRequest {
  const method = opts?.method ?? 'PATCH';
  const body = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers['Origin'] = origin;
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  const id = opts?.responseIdInUrl ?? RESPONSE_ID;
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/draft/${id}`, {
    method,
    body,
    headers,
  });
}

function ctx(responseId = RESPONSE_ID) {
  return { params: Promise.resolve({ responseId }) };
}

function validPatchBody(overrides: Partial<{ new_text: string; snapshot: { hash: string; version: number } }> = {}) {
  return {
    new_text: overrides.new_text ?? 'Updated reply text',
    snapshot: overrides.snapshot ?? { hash: 'hash-A', version: 3 },
  };
}

function seedTopLevel(...rowsets: unknown[][]) {
  topLevelQueue.push(...rowsets);
}

function seedTxRows(...rowsets: unknown[][]) {
  txQueue.push(...rowsets);
}

function directOffboardingRow() {
  return {
    id: 'offboarding-1',
    account_id: ACCOUNT_ID,
    mode: 'delete_data',
    status: 'pending',
    failed_step: null,
    terminal_at: null,
    access_ends_at: null,
    teardown_started_at: null,
    purge_after: null,
    purge_started_at: null,
    purge_cancelled_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  topLevelQueue.length = 0;
  txQueue.length = 0;
  process.env.PAST_REPLIES_VIEW_ENABLED = 'true';
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: getRequestScope resolves to the primary location.
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
  mockAssertCanEdit.mockResolvedValue(undefined);
  mockValidateOptimistic.mockResolvedValue(undefined);
  mockOffboardingRows.value = [];
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
  delete process.env.PAST_REPLIES_VIEW_ENABLED;
});

interface RouteCtx {
  params: Promise<{ responseId: string }>;
}

async function importHandlers() {
  const mod = await import('../draft/[responseId]/route');
  return {
    PATCH: mod.PATCH as (req: NextRequest, ctx: RouteCtx) => Promise<Response>,
    DELETE: mod.DELETE as (req: NextRequest, ctx: RouteCtx) => Promise<Response>,
  };
}

// ── PATCH tests ─────────────────────────────────────────────────────

describe('PATCH /api/dashboard/past-replies/draft/:responseId', () => {
  it('returns 503 feature_disabled when flag is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 cross-origin when wrong Origin header', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { PATCH } = await importHandlers();
    const res = await PATCH(
      makeRequest({ body: validPatchBody(), origin: 'https://evil.example.com' }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 403 premium_required when assertCanEditReply throws PremiumRequiredError', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // Top-level lookup of review_id succeeds.
    seedTopLevel([{ review_id: REVIEW_ID }]);
    const { PremiumRequiredError } = await import('@/lib/responses/edit-existing');
    mockAssertCanEdit.mockRejectedValue(new PremiumRequiredError());
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'premium_required' });
  });

  it('returns 404 response_not_found when responseId belongs to another location', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // Top-level lookup returns no rows (scoped by business_id/locationId).
    seedTopLevel([]);
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'response_not_found' });
  });

  it('returns 403 account_offboarding_blocked after authorization and before PATCH mutation', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTopLevel([{ review_id: REVIEW_ID }]);
    mockOffboardingRows.value = [directOffboardingRow()];
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(beginMock).not.toHaveBeenCalled();
    expect(txMock).not.toHaveBeenCalled();
  });

  it('returns 409 review_changed when hash mismatches; body includes current_review_text and current_review_hash', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review
    seedTxRows([{ id: REVIEW_ID }]);
    const { ReviewChangedError } = await import('@/lib/responses/edit-existing');
    mockValidateOptimistic.mockRejectedValue(
      new ReviewChangedError({ reviewText: 'Edited content', reviewHash: 'hash-NEW' }),
    );
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('review_changed');
    expect(body.current_review_text).toBe('Edited content');
    expect(body.current_review_hash).toBe('hash-NEW');
  });

  it('returns 409 response_changed when version mismatches', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows([{ id: REVIEW_ID }]);
    const { ResponseChangedError } = await import('@/lib/responses/edit-existing');
    mockValidateOptimistic.mockRejectedValue(new ResponseChangedError());
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'response_changed' });
  });

  it('returns 409 response_changed when status !== pending_approval (already moved past)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-response (status='approved' — already moved past)
    seedTxRows([{ id: REVIEW_ID }], [{ status: 'approved' }]);
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: validPatchBody() }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'response_changed' });
  });

  it('happy path → 204; UPDATEs approved_text + edited_text; status stays pending_approval', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-response (pending_approval), UPDATE
    seedTxRows([{ id: REVIEW_ID }], [{ status: 'pending_approval' }], []);
    const { PATCH } = await importHandlers();
    const res = await PATCH(
      makeRequest({ body: validPatchBody({ new_text: 'Brand new reply' }) }),
      ctx(),
    );
    expect(res.status).toBe(204);

    // UPDATE call: last tx invocation. Inspect SQL + bound params.
    const updateCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    expect(updateCall).toBeDefined();
    const templateStrings = updateCall[0] as unknown as TemplateStringsArray;
    const sqlText = templateStrings.join('|');
    expect(sqlText).toContain('UPDATE responses');
    expect(sqlText).toContain('approved_text');
    expect(sqlText).toContain('edited_text');
    // status='pending_approval' MUST NOT appear as an UPDATE assignment —
    // status is not transitioned (spec §4.4 atomicity rule).
    expect(sqlText).not.toMatch(/SET[\s\S]*status\s*=/);
    const args = updateCall.slice(1);
    expect(args[0]).toBe('Brand new reply'); // approved_text
    expect(args[1]).toBe('Brand new reply'); // edited_text
    expect(args[2]).toBe(RESPONSE_ID);       // WHERE id =
  });

  it('idempotent: PATCHing twice produces same end-state', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // First call.
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows([{ id: REVIEW_ID }], [{ status: 'pending_approval' }], []);
    const { PATCH } = await importHandlers();
    const res1 = await PATCH(makeRequest({ body: validPatchBody({ new_text: 'Same text' }) }), ctx());
    expect(res1.status).toBe(204);

    // Second call with same body — same tx flow, same end-state.
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows([{ id: REVIEW_ID }], [{ status: 'pending_approval' }], []);
    const res2 = await PATCH(makeRequest({ body: validPatchBody({ new_text: 'Same text' }) }), ctx());
    expect(res2.status).toBe(204);
  });

  it('returns 400 invalid_body when Zod schema fails', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { PATCH } = await importHandlers();
    const res = await PATCH(makeRequest({ body: { new_text: '' } }), ctx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('REGRESSION: when rw_location_scope cookie points at a non-primary location, DB lookups use that location (not primary)', async () => {
    // Session user's locationId is the PRIMARY (LOCATION_ID).
    // Cookie selects ALT_LOCATION_ID — getRequestScope returns it.
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: LOCATION_ID }));
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    // Top-level SELECT response → review_id (scoped to ALT_LOCATION_ID via business_id).
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-response (pending_approval), UPDATE
    seedTxRows([{ id: REVIEW_ID }], [{ status: 'pending_approval' }], []);
    const { PATCH } = await importHandlers();
    const res = await PATCH(
      makeRequest({
        body: validPatchBody({ new_text: 'Alt location reply' }),
        locationScopeCookie: ALT_LOCATION_ID,
      }),
      ctx(),
    );
    expect(res.status).toBe(204);

    // getRequestScope must have been called with ALT_LOCATION_ID as the cookie value.
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, ALT_LOCATION_ID);

    // The top-level SELECT must have scoped to ALT_LOCATION_ID (not LOCATION_ID).
    // topLevelMock was called with a tagged template — the bound arg for business_id is ALT_LOCATION_ID.
    // resolveOwnerScope's subscription_status lookup is a separate top-level call;
    // pick the route's response lookup (the one that does not query subscription_status).
    const topLevelCall = topLevelMock.mock.calls.find(
      (call) => !(call[0] as TemplateStringsArray).join('').includes('subscription_status'),
    ) as unknown as unknown[];
    const topLevelArgs = topLevelCall.slice(1);
    // args: [responseId, locationId] → second bound value is the locationId
    expect(topLevelArgs[1]).toBe(ALT_LOCATION_ID);
    expect(topLevelArgs[1]).not.toBe(LOCATION_ID);
  });
});

// ── DELETE tests ────────────────────────────────────────────────────

describe('DELETE /api/dashboard/past-replies/draft/:responseId', () => {
  it('returns 503 feature_disabled when flag is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 cross-origin when wrong Origin header', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { DELETE } = await importHandlers();
    const res = await DELETE(
      makeRequest({ method: 'DELETE', origin: 'https://evil.example.com' }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('happy path: pending_approval → superseded; returns 204', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-response (pending_approval), offboarding lookup, UPDATE
    seedTxRows([{ status: 'pending_approval' }], [], []);
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());
    expect(res.status).toBe(204);

    // Last tx call should be the UPDATE to superseded.
    const updateCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    const templateStrings = updateCall[0] as unknown as TemplateStringsArray;
    const sqlText = templateStrings.join('|');
    expect(sqlText).toContain('UPDATE responses');
    expect(sqlText).toContain("'superseded'");
  });

  it('returns 403 account_offboarding_blocked before superseding a pending draft', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTxRows([{ status: 'pending_approval' }], [directOffboardingRow()]);
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(txMock.mock.calls.length).toBe(2);
    const lastCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    const sqlText = (lastCall[0] as TemplateStringsArray).join('|');
    expect(sqlText).toContain('FROM account_offboardings');
  });

  it('idempotent on already-superseded row: no UPDATE issued, returns 204', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-response returns status='superseded' — no UPDATE follows.
    seedTxRows([{ status: 'superseded' }]);
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());
    expect(res.status).toBe(204);

    // Only one tx call (the SELECT FOR UPDATE) — no UPDATE.
    expect(txMock.mock.calls.length).toBe(1);
    const onlyCall = txMock.mock.calls[0] as unknown as unknown[];
    const sqlText = (onlyCall[0] as unknown as TemplateStringsArray).join('|');
    expect(sqlText).not.toContain('UPDATE responses');
  });

  it('idempotent on non-existent row: returns 204 (no 404)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-response returns no rows.
    seedTxRows([]);
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeRequest({ method: 'DELETE' }), ctx());
    expect(res.status).toBe(204);

    // Only one tx call (the SELECT FOR UPDATE) — no UPDATE.
    expect(txMock.mock.calls.length).toBe(1);
  });

  it('REGRESSION: when rw_location_scope cookie points at a non-primary location, DELETE scopes to that location (not primary)', async () => {
    // Session user's locationId is the PRIMARY (LOCATION_ID).
    // Cookie selects ALT_LOCATION_ID — getRequestScope returns it.
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: LOCATION_ID }));
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    // tx queue: lock-response scoped to ALT_LOCATION_ID → pending_approval, offboarding lookup, UPDATE
    seedTxRows([{ status: 'pending_approval' }], [], []);
    const { DELETE } = await importHandlers();
    const res = await DELETE(
      makeRequest({ method: 'DELETE', locationScopeCookie: ALT_LOCATION_ID }),
      ctx(),
    );
    expect(res.status).toBe(204);

    // getRequestScope must have been called with ALT_LOCATION_ID as the cookie value.
    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, ALT_LOCATION_ID);

    // The tx SELECT FOR UPDATE must have used ALT_LOCATION_ID as business_id.
    const selectCall = txMock.mock.calls[0] as unknown as unknown[];
    const selectArgs = selectCall.slice(1);
    // args: [responseId, locationId] → second bound value is the locationId
    expect(selectArgs[1]).toBe(ALT_LOCATION_ID);
    expect(selectArgs[1]).not.toBe(LOCATION_ID);
  });
});
