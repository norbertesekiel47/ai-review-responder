import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  mockAssertCanEdit,
  mockValidateOptimistic,
  mockInsertAuditLogSession,
  txQueue,
  txMock,
  topLevelQueue,
  sqlProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();
  const mockAssertCanEdit = vi.fn();
  const mockValidateOptimistic = vi.fn();
  const mockInsertAuditLogSession = vi.fn();

  // Each call to tx`...` returns the next array from the queue.
  const txQueue: unknown[][] = [];
  const txMock = vi.fn(async () => txQueue.shift() ?? []);
  // Enqueue helpers now bind JSONB via `tx.json(x)` (Postgres.js identity JSONB
  // constructor) instead of the module `jsonb` helper. Mirror the module mock's
  // identity passthrough so payloads flow into the tagged-template params as before.
  (txMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  // sql.begin runs the callback synchronously with the tx mock.
  const beginMock = vi.fn(async (cb: (tx: unknown) => Promise<Response>) => cb(txMock));

  // Top-level sql`...` (used by route's pre-tx response_id → review_id lookup).
  const topLevelQueue: unknown[][] = [];
  const sqlTopMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    // resolveOwnerScope's subscription_status lookup must see an ACTIVE account
    // without consuming the route's own top-level queue entries.
    if (text.includes('subscription_status')) {
      return [{ subscription_status: 'active' }];
    }
    return topLevelQueue.shift() ?? [];
  });

  // Calling sql`...` returns from the top-level queue; sql.begin uses beginMock.
  const sqlProxy = new Proxy(sqlTopMock, {
    get: (target, prop, receiver) => {
      if (prop === 'begin') return beginMock;
      return Reflect.get(target, prop, receiver);
    },
    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    mockAssertCanEdit,
    mockValidateOptimistic,
    mockInsertAuditLogSession,
    txQueue,
    txMock,
    beginMock,
    topLevelQueue,
    sqlTopMock,
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

vi.mock('@/lib/approval/audit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/approval/audit')>('@/lib/approval/audit');
  return {
    ...actual,
    insertAuditLogSession: (...args: unknown[]) => mockInsertAuditLogSession(...args),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
// A second location on the same account — for non-primary scoping tests.
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
// The users.id FK used in approval_audit_log.actor_user_id — must NOT be accountId.
const USER_ID = 'user-1';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const RESPONSE_ID = '01234567-0000-7000-8000-0000000000bb';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ accountId: string | null; id: string }>) {
  return {
    id: overrides?.id ?? 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
  };
}

function makeRequest(opts?: {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  locationScopeCookie?: string;
}): NextRequest {
  const body = opts?.rawBody ?? (opts?.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers['Origin'] = origin;
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/publish`, {
    method: 'POST',
    body,
    headers,
  });
}

function validBody(
  overrides: Partial<{
    response_id: string;
    snapshot: { hash: string; version: number };
  }> = {},
) {
  return {
    response_id: overrides.response_id ?? RESPONSE_ID,
    snapshot: overrides.snapshot ?? { hash: 'hash-A', version: 3 },
  };
}

function seedTxRows(...rowsets: unknown[][]) {
  txQueue.push(...rowsets);
}

function seedTopLevelRows(...rowsets: unknown[][]) {
  topLevelQueue.push(...rowsets);
}

beforeEach(() => {
  vi.clearAllMocks();
  txQueue.length = 0;
  topLevelQueue.length = 0;
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: auth + scope resolves to primary location.
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
  mockAssertCanEdit.mockResolvedValue(undefined);
  mockValidateOptimistic.mockResolvedValue(undefined);
  mockInsertAuditLogSession.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
});

async function importPOST() {
  const mod = await import('../publish/route');
  return mod.POST as (req: NextRequest) => Promise<Response>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/past-replies/publish', () => {
  it('returns 503 feature_disabled when EDIT_REPLIES_ENABLED is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('feature_disabled');
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(401);
  });

  it('returns 403 cross-origin when wrong Origin header (withSameOrigin)', async () => {
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody(), origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns 400 invalid_body when Zod schema fails (missing snapshot)', async () => {
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: { response_id: RESPONSE_ID } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('returns 404 response_not_found when response_id does not belong to current location', async () => {
    // Top-level lookup scoped by locationId returns no row → 404.
    seedTopLevelRows([]);
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('response_not_found');
  });

  it('returns 403 forbidden when tier gate fires', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    const { ForbiddenError } = await import('@/lib/responses/edit-existing');
    mockAssertCanEdit.mockRejectedValue(new ForbiddenError());
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns 409 review_changed when hash drifts; body includes current text + hash', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review row
    seedTxRows([{ id: REVIEW_ID }]);
    const { ReviewChangedError } = await import('@/lib/responses/edit-existing');
    mockValidateOptimistic.mockRejectedValue(
      new ReviewChangedError({ reviewText: 'Edited content', reviewHash: 'hash-NEW' }),
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('review_changed');
    expect(body.current_review_text).toBe('Edited content');
    expect(body.current_review_hash).toBe('hash-NEW');
  });

  it('returns 409 response_changed when version drifts', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    seedTxRows([{ id: REVIEW_ID }]);
    const { ResponseChangedError } = await import('@/lib/responses/edit-existing');
    mockValidateOptimistic.mockRejectedValue(new ResponseChangedError());
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('response_changed');
  });

  it('returns 409 response_changed when candidate status !== pending_approval', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-candidate (status=superseded)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'superseded', edited_text: null, response_text: 'x', llm_provider: 'openai' }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('response_changed');
  });

  it('returns 409 held_for_review when an open moderation flag holds the draft', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-candidate (pending), hasOpenFlag → non-empty.
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'pending_approval',
          edited_text: 'Brand new reply',
          approved_text: 'Brand new reply',
          response_text: 'Old reply',
          llm_provider: null,
        },
      ],
      [{ one: 1 }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('held_for_review');
    // Must not publish: no audit row, no status transition past the flag check.
    expect(mockInsertAuditLogSession).not.toHaveBeenCalled();
  });

  it('manual happy path → status="edited", audit mode="manual", outbox INSERTed', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // tx queue:
    //   1. lock-review
    //   2. lock-candidate (manual: llm_provider=NULL, edited_text=set)
    //   3. hasOpenFlag (empty → not held)
    //   4. UPDATE responses (empty)
    //   5. INSERT job_outbox (empty)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'pending_approval',
          edited_text: 'Brand new reply',
          approved_text: 'Brand new reply',
          response_text: 'Old reply',
          llm_provider: null,
        },
      ],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.outbox_id).toBe('string');
    expect(body.outbox_id).toMatch(/^[0-9a-f-]{36}$/);

    // assertCanEditReply called with { accountId, locationId } scope.
    // Leading arg is the sql client edit-reply-request.ts threads through (A+ campaign 2f-C).
    expect(mockAssertCanEdit).toHaveBeenCalledWith(sqlProxy, REVIEW_ID, {
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
    });

    // Audit invocation: (tx, responseId, locationId, action, audit, metadata)
    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    const auditCall = mockInsertAuditLogSession.mock.calls[0]!;
    expect(auditCall[1]).toBe(RESPONSE_ID);
    expect(auditCall[2]).toBe(LOCATION_ID);
    expect(auditCall[3]).toBe('approve_edit');
    // FK regression guard: actorUserId must be users.id, NOT accountId.
    expect((auditCall[4] as { actorUserId: string }).actorUserId).toBe(USER_ID);
    expect((auditCall[4] as { actorUserId: string }).actorUserId).not.toBe(ACCOUNT_ID);
    expect(auditCall[5]).toEqual({ mode: 'manual' });
    expect(auditCall[6]).toEqual({ responseTextAtApproval: 'Brand new reply' });

    // UPDATE responses tx call (4th tx call: lock-review, lock-candidate, hasOpenFlag, UPDATE)
    const updateCall = txMock.mock.calls[3] as unknown as unknown[];
    const updateSql = (updateCall[0] as unknown as TemplateStringsArray).join('|');
    expect(updateSql).toContain('UPDATE responses');
    expect(updateSql).toContain("'edited'");
    expect(updateSql).toContain("'approved'");
    expect(updateSql).toContain('approval_method');
    expect(updateSql).toContain('COALESCE(approved_text, response_text)');
    expect(updateCall).toContain('owner');
    expect(updateCall).toContain(RESPONSE_ID);
    expect(updateCall).toContain(LOCATION_ID);

    // INSERT outbox tx call (5th tx call)
    const insertCall = txMock.mock.calls[4] as unknown as unknown[];
    const insertSql = (insertCall[0] as unknown as TemplateStringsArray).join('|');
    expect(insertSql).toContain('INSERT INTO job_outbox');
    expect(insertCall[1]).toBe(body.outbox_id);
    expect(insertCall[2]).toBe('publish_response');
    expect(insertCall[3]).toBe('response');
    expect(insertCall[4]).toBe(RESPONSE_ID);
    const payload = insertCall[5] as unknown as { response_id: string; business_id: string };
    expect(payload.response_id).toBe(RESPONSE_ID);
    expect(payload.business_id).toBe(LOCATION_ID);
  });

  it('regenerate_as_is happy path → status="approved", approved_text via COALESCE, audit mode="regenerate_as_is"', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // Candidate: llm_provider=set, edited_text=NULL (regenerated, not tweaked).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'pending_approval',
          edited_text: null,
          approved_text: null,
          response_text: 'Worker-generated draft',
          llm_provider: 'openai',
        },
      ],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.outbox_id).toBe('string');

    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLogSession.mock.calls[0]![5]).toEqual({ mode: 'regenerate_as_is' });
    expect(mockInsertAuditLogSession.mock.calls[0]![6]).toEqual({
      responseTextAtApproval: 'Worker-generated draft',
    });

    const updateCall = txMock.mock.calls[3] as unknown as unknown[];
    const updateSql = (updateCall[0] as unknown as TemplateStringsArray).join('|');
    // CASE expression flips on edited_text presence — when NULL, status='approved'.
    expect(updateSql).toContain(
      "CASE WHEN edited_text IS NOT NULL THEN 'edited' ELSE 'approved' END",
    );
    expect(updateSql).toContain('approval_method');
    expect(updateCall).toContain('owner');
    // The COALESCE is the regression guard for regenerate_as_is.
    expect(updateSql).toContain('COALESCE(approved_text, response_text)');
  });

  it('regenerate_edited happy path → status="edited", audit mode="regenerate_edited"', async () => {
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    // Candidate: llm_provider=set AND edited_text=set (PATCH happened after regen).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'pending_approval',
          edited_text: 'Owner-tweaked text',
          approved_text: 'Owner-approved regenerated text',
          response_text: 'Worker-generated draft',
          llm_provider: 'openai',
        },
      ],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(200);

    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLogSession.mock.calls[0]![5]).toEqual({ mode: 'regenerate_edited' });
    expect(mockInsertAuditLogSession.mock.calls[0]![6]).toEqual({
      responseTextAtApproval: 'Owner-approved regenerated text',
    });
  });

  it('scopes response lookup and tx to ALT_LOCATION_ID when cookie is set (non-primary regression)', async () => {
    // Owner switches to a second location.
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    // Pre-tx lookup scoped by ALT_LOCATION_ID — returns a review_id.
    seedTopLevelRows([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'pending_approval',
          edited_text: 'Alt location reply',
          response_text: 'Original',
          llm_provider: null,
        },
      ],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(
      makeRequest({ body: validBody(), locationScopeCookie: ALT_LOCATION_ID }),
    );
    expect(res.status).toBe(200);
    // Leading arg is the sql client resolveOwnerScope threads through (A+ campaign 2a).
    expect(mockGetRequestScope).toHaveBeenCalledWith(sqlProxy, ACCOUNT_ID, ALT_LOCATION_ID);

    // assertCanEditReply called with ALT_LOCATION_ID, not LOCATION_ID.
    expect(mockAssertCanEdit).toHaveBeenCalledWith(sqlProxy, REVIEW_ID, {
      accountId: ACCOUNT_ID,
      locationId: ALT_LOCATION_ID,
    });

    // Audit log references ALT_LOCATION_ID as business_id.
    const auditCall = mockInsertAuditLogSession.mock.calls[0]!;
    expect(auditCall[2]).toBe(ALT_LOCATION_ID);

    // Outbox payload references ALT_LOCATION_ID.
    const insertCall = txMock.mock.calls[4] as unknown as unknown[];
    const payload = insertCall[5] as unknown as { response_id: string; business_id: string };
    expect(payload.business_id).toBe(ALT_LOCATION_ID);
  });
});
