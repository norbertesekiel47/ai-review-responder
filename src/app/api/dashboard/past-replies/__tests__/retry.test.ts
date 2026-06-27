import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  PENDING_AFTER_DELETE,
  STALE_AFTER_REVIEW_CHANGED,
} from '@/lib/publishing/orphan-markers';

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
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/${id}/retry`, {
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
  const mod = await import('../[responseId]/retry/route');
  return mod.POST as (req: NextRequest, ctx: RouteCtx) => Promise<Response>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/past-replies/:responseId/retry', () => {
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

  it('returns 403 premium_required when standard owner retries a historical review', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    const { PremiumRequiredError } = await import('@/lib/responses/edit-existing');
    mockAssertCanEdit.mockRejectedValue(new PremiumRequiredError());
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'premium_required' });
  });

  it('returns 404 response_not_found when response_id does not belong to current location', async () => {
    // Top-level lookup scoped by locationId returns no row → 404.
    seedTopLevel([]);
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'response_not_found' });
  });

  it('returns 409 already_recovered when status !== failed', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-candidate (status=posted)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'posted', posting_error: null }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_recovered' });
  });

  it('returns 409 newer_draft_exists when a non-terminal sibling exists', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // tx queue: lock-review, lock-candidate (failed), non-terminal-sibling-check (FOUND)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'delete_failed_transient' }],
      [{ '?column?': 1 }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'newer_draft_exists' });
  });

  it('returns 409 not_recoverable_via_retry for posting_error=review_content_changed', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'review_content_changed' }],
      [], // non-terminal sibling check: none
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_recoverable_via_retry' });
  });

  it('returns 409 not_recoverable_via_retry for posting_error=stale_after_review_changed (review changed after edit failure)', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: STALE_AFTER_REVIEW_CHANGED }],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_recoverable_via_retry' });
  });

  it('returns 409 sibling_state_mismatch when delete_failed_* row has no live posted sibling', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-candidate (delete_failed), non-terminal-sibling (none),
    // live-posted check (NONE — should be sibling_state_mismatch).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'delete_failed_transient' }],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'sibling_state_mismatch' });
  });

  it('returns 409 live_reply_exists when post_after_delete_failed_* row has a live posted sibling (post-restore scenario — branch-shape validation)', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-candidate (post_after_delete_failed), non-terminal (none),
    // live-posted (FOUND — security-critical: prevents undoing /restore-original).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'post_after_delete_failed_permanent' }],
      [],
      [{ id: 'sibling-id' }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'live_reply_exists' });
  });

  it('happy path delete_failed_* → status=approved, posting_error=NULL, audit row, outbox row', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-candidate (delete_failed), non-terminal (none),
    // live-posted (FOUND — sibling still alive), UPDATE, INSERT outbox.
    seedTxRows(
      [{ id: REVIEW_ID }],
      [
        {
          status: 'failed',
          posting_error: 'delete_failed_transient',
          approved_text: 'Retry approved text',
          response_text: 'Retry fallback text',
        },
      ],
      [],
      [{ id: 'live-sibling' }],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.outbox_id).toBe('string');
    expect(body.outbox_id).toMatch(/^[0-9a-f-]{36}$/);

    // Audit invocation — actor_user_id MUST be users.id, NOT accountId.
    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    const auditCall = mockInsertAuditLogSession.mock.calls[0]!;
    // (tx, responseId, businessId, action, audit, metadata)
    expect(auditCall[1]).toBe(RESPONSE_ID);
    expect(auditCall[2]).toBe(LOCATION_ID);
    expect(auditCall[3]).toBe('retry_after_failure');
    expect(auditCall[4]).toMatchObject({ actorUserId: USER_ID });
    expect(auditCall[4].actorUserId).not.toBe(ACCOUNT_ID);
    expect(auditCall[5]).toEqual({ previous_posting_error: 'delete_failed_transient' });
    expect(auditCall[6]).toEqual({ responseTextAtApproval: 'Retry approved text' });

    // UPDATE responses tx call (5th tx call: lock-review, lock-candidate, non-term, live-posted, UPDATE)
    const updateCall = txMock.mock.calls[4] as unknown as unknown[];
    const updateSql = (updateCall[0] as unknown as TemplateStringsArray).join('|');
    expect(updateSql).toContain('UPDATE responses');
    expect(updateSql).toContain("status = 'approved'");
    expect(updateSql).toContain('approval_method');
    expect(updateSql).toContain('posting_error =');
    // delete_failed branch → posting_error cleared to NULL.
    expect(updateCall[1]).toBeNull();
    expect(updateCall).toContain('owner');
    expect(updateSql).toContain('COALESCE(approved_text, response_text)');

    // INSERT outbox tx call (6th tx call)
    const insertCall = txMock.mock.calls[5] as unknown as unknown[];
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

  it('happy path post_after_delete_failed_* → status=approved, posting_error re-installed as the orphan marker, audit + outbox', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    // lock-review, lock-candidate (post_after_delete_failed), non-terminal (none),
    // live-posted (NONE — orphan state), UPDATE, INSERT outbox.
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'post_after_delete_failed_permanent' }],
      [],
      [],
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.outbox_id).toBe('string');

    expect(mockInsertAuditLogSession).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLogSession.mock.calls[0]![5]).toEqual({
      previous_posting_error: 'post_after_delete_failed_permanent',
    });

    // UPDATE responses — the 5th tx call. posting_error MUST be re-installed
    // as the PENDING_AFTER_DELETE orphan marker so the publisher takes the
    // no-DELETE branch on the next attempt.
    const updateCall = txMock.mock.calls[4] as unknown as unknown[];
    const updateSql = (updateCall[0] as unknown as TemplateStringsArray).join('|');
    expect(updateSql).toContain('approval_method');
    expect(updateCall[1]).toBe(PENDING_AFTER_DELETE);
    expect(updateCall).toContain('owner');

    // Outbox INSERT (6th tx call)
    const insertCall = txMock.mock.calls[5] as unknown as unknown[];
    const insertSql = (insertCall[0] as unknown as TemplateStringsArray).join('|');
    expect(insertSql).toContain('INSERT INTO job_outbox');
  });

  it('post_after_delete_failed_retry_exhausted is recoverable (shares the orphan prefix)', async () => {
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'post_after_delete_failed_retry_exhausted' }],
      [],
      [], // no live posted sibling — valid orphan state
      [],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest(), ctx());
    expect(res.status).toBe(200);
    // Re-installs the orphan marker so the next attempt stays orphan-recoverable.
    const updateCall = txMock.mock.calls[4] as unknown as unknown[];
    expect(updateCall[1]).toBe(PENDING_AFTER_DELETE);
  });

  it('scopes to the non-primary location from the rw_location_scope cookie', async () => {
    // Owner is on a second location — getRequestScope resolves ALT_LOCATION_ID.
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    seedTopLevel([{ review_id: REVIEW_ID }]);
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ status: 'failed', posting_error: 'delete_failed_transient' }],
      [],
      [{ id: 'live-sibling' }],
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
    // assertCanEditReply receives the ALT location, not the primary.
    expect(mockAssertCanEdit).toHaveBeenCalledWith(REVIEW_ID, {
      accountId: ACCOUNT_ID,
      locationId: ALT_LOCATION_ID,
    });
    // Audit + outbox payload scoped to the ALT location.
    expect(mockInsertAuditLogSession.mock.calls[0]![2]).toBe(ALT_LOCATION_ID);
    const insertCall = txMock.mock.calls[5] as unknown as unknown[];
    const payload = insertCall[5] as unknown as { business_id: string };
    expect(payload.business_id).toBe(ALT_LOCATION_ID);
  });
});
