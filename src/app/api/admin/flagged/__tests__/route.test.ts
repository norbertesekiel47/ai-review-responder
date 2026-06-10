import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockWriteAccountAuditLog,
  mockSql,
  mockTx,
  txResults,
  txCalls,
} = vi.hoisted(() => {
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockSql,
    mockTx,
    txResults,
    txCalls,
  };
});

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => ({ __jsonb: v }) }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));
vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));
vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { GET, POST } from '../route';

function getReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/flagged?limit=20&offset=0');
}

describe('GET /api/admin/flagged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  });

  it('returns 403 for non-admins', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });

  it('returns 403 without a current AAL2 session', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    // Must not reach the queue query when MFA step-up is unsatisfied.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns the total open-flag count alongside the page', async () => {
    // 1st sql call → page rows; 2nd sql call → COUNT.
    mockSql.mockResolvedValueOnce([
      {
        id: 'flag-1', response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1',
        review_id: 'rev-1', source: 'local_regex', reason: 'refund_discount', severity: 'high',
        status: 'open', created_at: '2026-05-26T00:00:00.000Z', response_text: 'x',
        version: 1, reviewer_name: 'Jane', star_rating: 2, business_name: 'Bella Italia',
      },
    ]);
    mockSql.mockResolvedValueOnce([{ total: 137 }]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagged: unknown[]; total: number };
    expect(body.total).toBe(137);
    expect(body.flagged).toHaveLength(1);
  });

  it('lists open flags mapped to the display shape', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'flag-1', response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1',
        review_id: 'rev-1', source: 'local_regex', reason: 'refund_discount', severity: 'high',
        status: 'open', created_at: '2026-05-26T00:00:00.000Z', response_text: 'Here is a full refund.',
        version: 1, reviewer_name: 'Jane', star_rating: 2, business_name: 'Bella Italia',
      },
    ]);
    mockSql.mockResolvedValueOnce([{ total: 1 }]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagged: Array<Record<string, unknown>>; total: number };
    expect(body.flagged).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.flagged[0]).toMatchObject({
      id: 'flag-1',
      responseId: 'resp-1',
      businessName: 'Bella Italia',
      severity: 'high',
      reason: 'refund_discount',
      responseText: 'Here is a full refund.',
      reviewerName: 'Jane',
      starRating: 2,
    });
  });
});

function postReq(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/flagged', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify(body),
  });
}

const FLAG_ID = '33333333-3333-4333-8333-333333333333';

describe('POST /api/admin/flagged (disposition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    txResults.length = 0;
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  });

  it('rejects a non-same-origin request with 403', async () => {
    const bad = new NextRequest('https://app.example.com/api/admin/flagged', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }),
    });
    const res = await POST(bad);
    expect(res.status).toBe(403);
  });

  it('requires AAL2', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown action with 400', async () => {
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'banana' }));
    expect(res.status).toBe(400);
  });

  it('approve: updates status and enqueues send_notification, returns ok', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]); // flag SELECT
    txResults.push(Object.assign([], { count: 1 })); // UPDATE flagged_responses
    txResults.push([{ archived_at: null }]); // archived-location gate SELECT (active location)
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(200);

    const notifyPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'response_id' in p && 'business_id' in p);
    expect(notifyPayloads).toHaveLength(1);
    expect(notifyPayloads[0]).toMatchObject({ response_id: 'resp-1', business_id: 'biz-1' });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('dismiss: updates status, does NOT enqueue a notification', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]);
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'dismissed_false_positive' }));
    expect(res.status).toBe(200);
    const notifyPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'response_id' in p && 'business_id' in p);
    expect(notifyPayloads).toHaveLength(0);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('approve: rejects with 409 archived_location when the location is archived (flag stays open)', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]); // flag SELECT
    txResults.push(Object.assign([], { count: 1 })); // UPDATE flagged_responses (rolled back)
    txResults.push([{ archived_at: new Date() }]); // archived-location gate SELECT → archived

    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('archived_location');

    // No notification enqueued, no audit write committed.
    const notifyPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'response_id' in p && 'business_id' in p);
    expect(notifyPayloads).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('dismiss: succeeds for an archived location (deliberately ungated — flags must be closable)', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]); // flag SELECT
    // No archived-gate row queued: dismissed_false_positive never queries businesses.
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'dismissed_false_positive' }));
    expect(res.status).toBe(200);
    expect(txCalls.some((c) => /FROM businesses/.test(c.text))).toBe(false);
  });

  it('requires_regeneration: supersedes the held draft and enqueues generate_response, no notification', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]); // flag SELECT
    txResults.push(Object.assign([], { count: 1 })); // UPDATE flagged_responses
    txResults.push([{ review_id: 'rev-1', version: 1, status: 'pending_approval' }]); // response SELECT FOR UPDATE
    txResults.push([{ archived_at: null }]); // archived-location gate SELECT, AFTER the responses lock (active location)

    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'requires_regeneration' }));
    expect(res.status).toBe(200);

    const jsonbPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb);

    // No owner notification for a regenerated (still-unsafe) draft.
    expect(jsonbPayloads.filter((p) => 'response_id' in p && 'business_id' in p)).toHaveLength(0);

    // A generate_response job at version+1 was enqueued.
    const regenPayloads = jsonbPayloads.filter((p) => 'review_id' in p && 'version' in p);
    expect(regenPayloads).toHaveLength(1);
    expect(regenPayloads[0]).toMatchObject({
      review_id: 'rev-1',
      business_id: 'biz-1',
      version: 2,
      origin_lane: 'regenerate',
    });

    // The held response row was superseded.
    expect(txCalls.some((c) => /UPDATE responses/.test(c.text) && /superseded/.test(c.text))).toBe(true);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('returns 409 when the flag is not open (already dispositioned)', async () => {
    txResults.push([]);
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(409);
  });

  it('requires_regeneration: rejects an archived location with 409 archived_location and supersedes nothing', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]); // flag SELECT
    txResults.push(Object.assign([], { count: 1 })); // UPDATE flagged_responses
    txResults.push([{ archived_at: new Date('2026-06-01T00:00:00Z') }]); // archived-location gate SELECT

    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'requires_regeneration' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'archived_location' });

    // The tx threw before the supersede: no responses UPDATE, no
    // generate_response enqueue, no audit write (rollback keeps the flag open).
    expect(txCalls.some((c) => /UPDATE responses/.test(c.text))).toBe(false);
    const regenPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'review_id' in p && 'version' in p);
    expect(regenPayloads).toHaveLength(0);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
