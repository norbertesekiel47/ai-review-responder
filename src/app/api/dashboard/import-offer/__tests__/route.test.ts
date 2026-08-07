// src/app/api/dashboard/import-offer/__tests__/route.test.ts
//
// T0 EVAL suite for #677 — titles 26–30 (POST) and 34–39 (GET) of the intake's
// 70, authored VERBATIM before implementation.
//
// The MOCKED half of the decision API. Its live twin, route.integration.test.ts,
// owns titles 31–33, 61 and 68 — the committed-state, rollback and concurrency
// proofs a mocked `sql` tag cannot make.
//
// Division of labour (plan §2): this file asserts the ROUTE CONTRACT — that POST
// validates its body with zod, resolves scope via resolveOwnerScope, makes ONE
// call to recordImportDecisionAndEnqueue and maps its four outcomes; that GET
// needs no CSRF wrapper (GETs are exempt, draft-status:18-20) and returns the
// banner state. Invariant #12: the handler holds no sql.begin and no business
// logic, so "the route called the module once with the right arguments" IS the
// contract here.
//
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';

const {
  mockSql,
  mockResolveOwnerScope,
  mockCreateImportOffer,
  mockRecordDecision,
  mockReadView,
  scenario,
} = vi.hoisted(() => {
  const scenario = {
    scopeError: null as { message: string; statusCode: number } | null,
  };
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
  return {
    mockSql,
    mockResolveOwnerScope: vi.fn(),
    mockCreateImportOffer: vi.fn(async () => 'unchanged' as const),
    mockRecordDecision: vi.fn(async () => 'recorded' as const),
    mockReadView: vi.fn(async () => ({ state: 'none' as const })),
    scenario,
  };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('@/lib/auth/resolve-owner-scope', async () => {
  class ScopeError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  }
  return { resolveOwnerScope: mockResolveOwnerScope, ScopeError };
});
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));
vi.mock('@/lib/reviews/import-consent', () => ({
  createImportOffer: mockCreateImportOffer,
  recordImportDecisionAndEnqueue: mockRecordDecision,
}));
vi.mock('@/lib/reviews/import-offer-view', () => ({ readImportOfferView: mockReadView }));
vi.mock('@/lib/shared/csrf', () => ({
  assertSameOrigin: vi.fn(),
  SameOriginError: class SameOriginError extends Error {},
}));

import { GET, POST } from '../route';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard/import-offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard/import-offer', {
    method: 'GET',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scenario.scopeError = null;
  mockResolveOwnerScope.mockResolvedValue({
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
    userId: 'user-1',
  });
  mockCreateImportOffer.mockResolvedValue('unchanged');
  mockRecordDecision.mockResolvedValue('recorded');
  mockReadView.mockResolvedValue({ state: 'none' });
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
});

describe('POST /api/dashboard/import-offer', () => {
  it('POST import-offer accept records the decision and enqueues the import in one transaction', async () => {
    const res = await POST(postRequest({ decision: 'accepted' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decision: 'accepted' });
    // ONE call to the domain function, and the handler opens no transaction of its
    // own — invariant #12. The "in one transaction" part is owned by
    // recordImportDecisionAndEnqueue and proven live by title 31's rollback test;
    // what this asserts is that the route did not take that job back.
    expect(mockRecordDecision).toHaveBeenCalledTimes(1);
    expect(mockRecordDecision).toHaveBeenCalledWith(
      mockSql, LOCATION_ID, ACCOUNT_ID, 'accepted',
    );
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('POST import-offer decline records the decision and enqueues nothing', async () => {
    const res = await POST(postRequest({ decision: 'declined' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decision: 'declined' });
    expect(mockRecordDecision).toHaveBeenCalledWith(
      mockSql, LOCATION_ID, ACCOUNT_ID, 'declined',
    );
  });

  // The late click. Derived expiry means nothing fires at the deadline (#670),
  // so a banner rendered at T+6d59m and clicked at T+7d01m is the ordinary case,
  // not an edge case — the guarded UPDATE is the only thing standing between it
  // and a manufactured consent.
  it('POST import-offer rejects a late click on a derived-expired offer without writing or enqueueing', async () => {
    mockRecordDecision.mockResolvedValue('expired' as never);

    const res = await POST(postRequest({ decision: 'accepted' }));

    // 409, not 200-with-a-body-field: the banner must be able to tell "too late"
    // from "recorded" without inspecting the payload. The no-write half is proven
    // byte-for-byte against live Postgres by title 32.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'offer_expired' });
  });

  // F3 terminal-state contract. "Enqueues exactly one" is the assertion that
  // matters: a duplicate accept that re-enqueued would import twice while
  // looking perfectly idempotent at the decision column.
  it('POST import-offer never overwrites an already-answered decision and enqueues exactly one import on a duplicate accept', async () => {
    mockRecordDecision.mockResolvedValueOnce('recorded' as never);
    mockRecordDecision.mockResolvedValueOnce('already_answered' as never);

    const first = await POST(postRequest({ decision: 'accepted' }));
    const second = await POST(postRequest({ decision: 'accepted' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_answered' });
    // "Exactly one import" is the F3 contract and it lives in the domain
    // function's guarded UPDATE — proven live by title 33 (two concurrent accepts
    // → one transition, one outbox row). Here the assertion is that the route
    // faithfully surfaces the refusal instead of retrying or reporting success.
    expect(mockRecordDecision).toHaveBeenCalledTimes(2);
  });

  // Invariant #8. Owner scope is app-enforced, and this route takes a decision
  // that gates a data import — a foreign business_id must not be reachable by
  // supplying it.
  it('POST import-offer resolves its location from owner scope and rejects a foreign business', async () => {
    // The location is NEVER taken from the request body — there is no location
    // field in the schema, so a crafted body cannot name one. Scope decides.
    await POST(postRequest({ decision: 'accepted', locationId: 'someone-elses-id' }));
    expect(mockRecordDecision).toHaveBeenCalledWith(
      mockSql, LOCATION_ID, ACCOUNT_ID, 'accepted',
    );

    // And a scope failure is surfaced with its own status, not swallowed into 500.
    const { ScopeError } = await import('@/lib/auth/resolve-owner-scope');
    mockResolveOwnerScope.mockRejectedValue(new ScopeError('forbidden', 403));

    const res = await POST(postRequest({ decision: 'accepted' }));
    expect(res.status).toBe(403);
  });

  it('POST import-offer rejects an invalid decision without calling the domain function', async () => {
    // Not one of the 69 intake titles: zod validation is named in the plan's T4
    // contract but no title pins it, and an unvalidated body reaching
    // recordImportDecisionAndEnqueue would put an arbitrary string into
    // import_decision — where migration 101's CHECK is the only thing standing
    // between it and a corrupt consent state.
    for (const body of [{ decision: 'maybe' }, { decision: null }, {}]) {
      const res = await POST(postRequest(body));
      expect(res.status).toBe(400);
    }
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});

describe('GET /api/dashboard/import-offer', () => {
  it('GET import-offer returns the offer state only for a pending unexpired offer', async () => {
    const expiresAt = '2026-08-14T00:00:00.000Z';
    mockReadView.mockResolvedValue({ state: 'offer', expiresAt } as never);

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'offer', expiresAt });
    expect(mockReadView).toHaveBeenCalledWith(mockSql, LOCATION_ID, ACCOUNT_ID);

    // 'none' is what a declined, expired, or never-offered location returns — the
    // banner self-nulls on it. The route passes the view through unchanged rather
    // than re-deriving anything, which is why there is one owner for the mapping.
    mockReadView.mockResolvedValue({ state: 'none' } as never);
    expect(await (await GET(getRequest())).json()).toEqual({ state: 'none' });
  });

  // The self-heal (F105/F106). It is what makes best-effort offer creation on the
  // Stripe path acceptable — do not drop one without the other (plan T3). The
  // route does NOT re-implement a junction check: createImportOffer owns that
  // condition, and calling it "when at the junction" was revision 2's mistake.
  it('GET import-offer re-attempts offer creation for a junction location whose offer was never created', async () => {
    mockCreateImportOffer.mockResolvedValue('created' as never);

    await GET(getRequest());

    // Called unconditionally — the route asserts NO junction precondition of its
    // own. If it did, that condition would have two owners and could disagree with
    // the helper's SQL.
    expect(mockCreateImportOffer).toHaveBeenCalledTimes(1);
    expect(mockCreateImportOffer).toHaveBeenCalledWith(mockSql, LOCATION_ID, ACCOUNT_ID);

    // In its own transaction, with the row lock taken BEFORE the helper runs. A
    // read path calling a TransactionSql helper with no transaction is the F107
    // defect; `SELECT … FOR UPDATE` outside sql.begin() is a no-op under
    // PgBouncer transaction pooling.
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    const lockCall = mockSql.mock.calls.find((c: any[]) =>
      Array.from(c[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'),
    );
    expect(lockCall).toBeDefined();
    expect(lockCall!.slice(1)).toContain(ACCOUNT_ID);
  });

  // completed_at decides done, never imported_count — the count DEFAULTs to 0
  // and is written incrementally (ZernioBackfillWorker.ts:379).
  //
  // These four assert the ROUTE surfaces each view state faithfully. Which state
  // the SQL actually produces for a given row set is the view module's contract
  // and is proven against live Postgres by titles 40–43 and 66–67 — a mocked
  // readImportOfferView cannot tell you anything about the join.
  it('GET import-offer reports importing while the accepted import has no completed run', async () => {
    mockReadView.mockResolvedValue({ state: 'importing' } as never);
    expect(await (await GET(getRequest())).json()).toEqual({ state: 'importing' });
  });

  it('GET import-offer reports the imported count when the run completes', async () => {
    mockReadView.mockResolvedValue({ state: 'imported', count: 37 } as never);
    expect(await (await GET(getRequest())).json()).toEqual({ state: 'imported', count: 37 });
  });

  it('GET import-offer reports the empty outcome when the import stored zero reviews', async () => {
    // `empty`, not `imported` with count 0 — a distinct outcome, because
    // "Imported 0 reviews" reads as a bug to the owner (owner decision 4).
    mockReadView.mockResolvedValue({ state: 'empty' } as never);
    const body = await (await GET(getRequest())).json();
    expect(body).toEqual({ state: 'empty' });
    expect(body).not.toHaveProperty('count');
  });

  it('GET import-offer reports a failed import when the outbox row reaches a terminal non-completed status', async () => {
    mockReadView.mockResolvedValue({ state: 'failed' } as never);
    expect(await (await GET(getRequest())).json()).toEqual({ state: 'failed' });
  });

  it('GET import-offer surfaces a scope failure with its own status', async () => {
    // Not one of the 69 titles. Included because the GET's catch-all returns 500,
    // and a ScopeError thrown by resolveOwnerScope must escape it as 401/403 —
    // otherwise a signed-out poll reads as an outage in Sentry rather than as an
    // expired session.
    const { ScopeError } = await import('@/lib/auth/resolve-owner-scope');
    mockResolveOwnerScope.mockRejectedValue(new ScopeError('unauthorized', 401));

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mockCreateImportOffer).not.toHaveBeenCalled();
  });
});
