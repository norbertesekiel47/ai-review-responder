import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST_AFTER_DELETE_FAILED_PREFIX } from '../../../../../../worker/jobs/publisher/orphan-markers';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  mockAssertCanEdit,
  mockInsertAuditLogSession,
  topLevelQueue,
  topLevelMock,
  txQueue,
  txMock,
  beginMock,
  sqlProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();
  const mockAssertCanEdit = vi.fn();
  const mockInsertAuditLogSession = vi.fn();

  const topLevelQueue: unknown[][] = [];
  const topLevelMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) {
      return [{ subscription_status: 'active' }];
    }
    return topLevelQueue.shift() ?? [];
  });

  const txQueue: unknown[][] = [];
  const txMock = vi.fn(async () => txQueue.shift() ?? []);

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
    mockInsertAuditLogSession,
    topLevelQueue,
    topLevelMock,
    txQueue,
    txMock,
    beginMock,
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
const SUPERSEDED_ID = '01234567-0000-7000-8000-0000000000cc';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ accountId: string | null; id: string }>) {
  return {
    id: overrides?.id ?? USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
  };
}

function makeRequest(opts?: {
  origin?: string | null;
  responseIdInUrl?: string;
  locationScopeCookie?: string;
}): NextRequest {
  const headers: Record<string, string> = {};
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers['Origin'] = origin;
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  const id = opts?.responseIdInUrl ?? RESPONSE_ID;
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/${id}/restore-original`, {
    method: 'POST',
    headers,
  });
}

function ctx(responseId = RESPONSE_ID) {
  return { params: Promise.resolve({ responseId }) };
}

function seedTopLevel(...rowsets: unknown[][]) {
  topLevelQueue.push(...rowsets);
}

function seedTxRows(...rowsets: unknown[][]) {
  txQueue.push(...rowsets);
}

beforeEach(() => {
  vi.clearAllMocks();
  topLevelQueue.length = 0;
  txQueue.length = 0;
  process.env.PAST_REPLIES_VIEW_ENABLED = 'true';
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: auth + scope resolves to primary location.
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
  mockAssertCanEdit.mockResolvedValue(undefined);
  mockInsertAuditLogSession.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
  delete process.env.PAST_REPLIES_VIEW_ENABLED;
});

interface RouteCtx {
  params: Promise<{ responseId: string }>;
}

async function importPOST() {
  const mod = await import('../[responseId]/restore-original/route');
  return mod.POST as (req: NextRequest, ctx: RouteCtx) => Promise<Response>;
}

const orphanFailedRow = (
  overrides?: Partial<{ posting_error: string | null; status: string; business_id: string }>,
) => ({
  review_id: REVIEW_ID,
  status: overrides && 'status' in overrides ? overrides.status : 'failed',
  business_id: overrides && 'business_id' in overrides ? overrides.business_id : LOCATION_ID,
  // Use `in` check rather than `??` so callers can pass posting_error: null
  // (which `??` would otherwise replace with the default string).
  posting_error:
    overrides && 'posting_error' in overrides
      ? overrides.posting_error
      : `${POST_AFTER_DELETE_FAILED_PREFIX}permanent`,
});

const supersededRow = () => ({
  id: SUPERSEDED_ID,
  approved_text: 'Original posted reply text',
  response_text: 'Original posted reply text',
  original_draft_text: 'Original posted reply text',
  response_language: 'en',
  version: 5,
  posted_at: new Date('2026-04-01T12:00:00Z'),
});

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/past-replies/:responseId/restore-original', () => {
  it('returns 503 feature_disabled when flag is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 cross-origin when wrong Origin header', async () => {
    const POST = await importPOST();
    const res = await POST(makeRequest({ origin: 'https://evil.example.com' }), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 403 premium_required when standard owner restores a historical review', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    const { PremiumRequiredError } = await import('@/lib/responses/edit-existing');
    mockAssertCanEdit.mockRejectedValue(new PremiumRequiredError());
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'premium_required' });
  });

  it('returns 404 response_not_found when response_id does not belong to current location', async () => {
    seedTopLevel([]);
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'response_not_found' });
  });

  it('returns 409 already_recovered when status !== failed', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow({ status: 'posted' })],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_recovered' });
  });

  it('returns 409 not_in_orphan_state for posting_error=delete_failed_* (sibling still alive — wrong route)', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow({ posting_error: 'delete_failed_transient' })],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_in_orphan_state' });
  });

  it('returns 409 not_in_orphan_state when posting_error is NULL', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow({ posting_error: null })],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_in_orphan_state' });
  });

  it('returns 409 live_reply_exists when a posted sibling already exists (orphan state isnt real)', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-failed (orphan), live-posted (FOUND).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow()],
      [{ '?column?': 1 }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'live_reply_exists' });
  });

  it('returns 409 newer_draft_exists when non-terminal sibling exists', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-failed (orphan), live-posted (none), non-terminal (FOUND).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow()],
      [],
      [{ '?column?': 1 }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'newer_draft_exists' });
  });

  it('returns 404 no_original_to_restore when no superseded sibling with posted_at exists', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-failed (orphan), live-posted (none), non-terminal (none),
    // superseded-with-posted_at (NONE).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow()],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_original_to_restore' });
  });

  it('happy path: orphan + superseded sibling → INSERTs new APPROVED row at MAX(version)+1 with original text in all 3 text columns; OLD failed row STAYS failed; audit row written; publish_response outbox enqueued; NO validateOptimisticConcurrency', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue:
    //   1. lock-review
    //   2. lock-failed (orphan)
    //   3. live-posted check (none — orphan state real)
    //   4. non-terminal-sibling check (none)
    //   5. superseded-FOR-UPDATE select (FOUND)
    //   6. INSERT new approved row (no rows returned)
    //   7. INSERT publish_response outbox (no rows returned)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow()],
      [],
      [],
      [supersededRow()],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.response_id).toBe('string');
    expect(body.response_id).toMatch(/^[0-9a-f-]{36}$/);
    // Restore is terminal: route returns the new response id + the outbox id
    // it enqueued to republish the original directly. No response_text — the
    // drawer no longer routes through the preview/publish path.
    expect(typeof body.outbox_id).toBe('string');
    expect(body.outbox_id).toMatch(/^[0-9a-f-]{36}$/);

    // INSERT call (6th tx call). Verify it's an INSERT INTO responses with
    // the correct shape: approved status, all 3 text columns set, edited_text
    // NULL, approved_at set, version = MAX+1 inline expression, llm fields NULL.
    const insertCall = txMock.mock.calls[5] as unknown as unknown[];
    const insertSql = (insertCall[0] as unknown as TemplateStringsArray).join('|');
    expect(insertSql).toContain('INSERT INTO responses');
    expect(insertSql).toContain('response_text');
    expect(insertSql).toContain('approved_text');
    expect(insertSql).toContain('original_draft_text');
    expect(insertSql).toContain('edited_text');
    expect(insertSql).toContain('approval_method');
    expect(insertSql).toContain("'approved'");
    expect(insertSql).toContain('approved_at');
    expect(insertSql).toContain('NOW()');
    expect(insertCall).toContain('owner');
    // The version expression is inline SQL; verify the COALESCE/MAX expression is present.
    expect(insertSql).toContain('COALESCE');
    expect(insertSql).toContain('MAX(version)');

    // Bound params on the INSERT (positions 1..N from the route's tagged template):
    //   ${newId}, ${reviewId}, ${failed.business_id},
    //   ${restoredText}, ${restoredText}, ${restoredText}, ${null},
    //   ${superseded.response_language},
    //   inline SQL — ${reviewId} again,
    //   ${APPROVAL_METHOD.OWNER},
    //   ${null}, ${null}, ${null}, ${null}
    const newIdParam = insertCall[1] as string;
    expect(newIdParam).toBe(body.response_id);
    expect(insertCall[2]).toBe(REVIEW_ID);
    expect(insertCall[3]).toBe(LOCATION_ID);
    // All three text columns get the same restored value.
    expect(insertCall[4]).toBe('Original posted reply text');
    expect(insertCall[5]).toBe('Original posted reply text');
    expect(insertCall[6]).toBe('Original posted reply text');
    // edited_text = NULL.
    expect(insertCall[7]).toBeNull();
    // response_language preserved from superseded row.
    expect(insertCall[8]).toBe('en');
    // The MAX(version) sub-select also uses ${reviewId} — bound at position 9.
    expect(insertCall[9]).toBe(REVIEW_ID);
    expect(insertCall[10]).toBe('owner');
    // llm_provider, llm_model, prompt_tokens, completion_tokens all NULL.
    expect(insertCall[11]).toBeNull();
    expect(insertCall[12]).toBeNull();
    expect(insertCall[13]).toBeNull();
    expect(insertCall[14]).toBeNull();

    // The OLD failed row was NOT updated — verify no UPDATE call hit responses.
    const allTxCalls = txMock.mock.calls as unknown as unknown[][];
    const updateCalls = allTxCalls.filter((call) => {
      const sqlText = (call[0] as unknown as TemplateStringsArray).join('|');
      return sqlText.includes('UPDATE responses');
    });
    expect(updateCalls).toHaveLength(0);

    // Recovery skips validateOptimisticConcurrency (no live posted row to
    // validate against). Verify no SELECT touched review_content_hash.
    const optimisticChecks = [...allTxCalls, ...(topLevelMock.mock.calls as unknown as unknown[][])].filter((call) => {
      const sqlText = (call[0] as unknown as TemplateStringsArray).join('|');
      return sqlText.includes('review_content_hash');
    });
    expect(optimisticChecks).toHaveLength(0);

    // A publish_response outbox row IS enqueued — restore republishes directly.
    const outboxInserts = allTxCalls.filter((call) => {
      const sqlText = (call[0] as unknown as TemplateStringsArray).join('|');
      return sqlText.includes('INSERT INTO job_outbox') && call.includes('publish_response');
    });
    expect(outboxInserts).toHaveLength(1);
    const outboxCall = outboxInserts[0]!;
    // payload param is jsonb()-wrapped; the mock unwraps jsonb to identity.
    const outboxArgs = outboxCall.slice(1);
    expect(outboxArgs[0]).toBe(body.outbox_id); // outbox id
    expect(outboxArgs[1]).toBe('publish_response');
    expect(outboxArgs[2]).toBe('response');
    expect(outboxArgs[3]).toBe(body.response_id); // aggregate_id = new response id
    const outboxPayload = outboxArgs[4] as { response_id: string; business_id: string };
    expect(outboxPayload.response_id).toBe(body.response_id);
    expect(outboxPayload.business_id).toBe(LOCATION_ID);

    // Audit log written with the restore_original action + cross-references.
    // actor_user_id MUST be users.id, NOT accountId.
    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    const auditCall = mockInsertAuditLogSession.mock.calls[0]!;
    expect(auditCall[1]).toBe(body.response_id); // new id, NOT the failed id
    expect(auditCall[2]).toBe(LOCATION_ID);
    expect(auditCall[3]).toBe('restore_original');
    expect(auditCall[4]).toMatchObject({ actorUserId: USER_ID });
    expect(auditCall[4].actorUserId).not.toBe(ACCOUNT_ID);
    expect(auditCall[5]).toEqual({
      failed_response_id: RESPONSE_ID,
      restored_from_superseded_id: SUPERSEDED_ID,
    });
    expect(auditCall[6]).toEqual({
      responseTextAtApproval: 'Original posted reply text',
    });
  });

  it('scopes to the non-primary location from the rw_location_scope cookie', async () => {
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [orphanFailedRow({ business_id: ALT_LOCATION_ID })],
      [],
      [],
      [supersededRow()],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(
      makeRequest({ locationScopeCookie: ALT_LOCATION_ID }),
      ctx(),
    );
    expect(res.status).toBe(200);

    // Top-level response lookup must be scoped by the ALT location's business_id.
    // resolveOwnerScope's subscription_status lookup is the first top-level call;
    // the route's response lookup is the one that interpolates the location id.
    const topLevelCall = topLevelMock.mock.calls.find(
      (call) => !(call[0] as TemplateStringsArray).join('').includes('subscription_status'),
    ) as unknown as unknown[];
    expect(topLevelCall).toContain(ALT_LOCATION_ID);
    expect(mockAssertCanEdit).toHaveBeenCalledWith(REVIEW_ID, {
      accountId: ACCOUNT_ID,
      locationId: ALT_LOCATION_ID,
    });
    // New row's business_id (INSERT param 3) is the ALT location's.
    const insertCall = txMock.mock.calls[5] as unknown as unknown[];
    expect(insertCall[3]).toBe(ALT_LOCATION_ID);
    // Audit business_id scoped to the ALT location.
    expect(mockInsertAuditLogSession.mock.calls[0]![2]).toBe(ALT_LOCATION_ID);
  });
});
