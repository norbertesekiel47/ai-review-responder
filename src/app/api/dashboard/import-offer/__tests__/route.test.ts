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

/** The consent shape the self-heal acts on: offered nothing yet. */
const NO_OFFER_YET = { state: 'pending' as const, decidedAt: null, expiresAt: null };

const {
  mockSql,
  mockResolveOwnerScope,
  mockCreateImportOffer,
  mockReadConsent,
  mockAssertWritable,
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
    mockReadConsent: vi.fn(),
    mockAssertWritable: vi.fn(async () => ({ ok: true }) as const),
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
  readImportConsent: mockReadConsent,
  recordImportDecisionAndEnqueue: mockRecordDecision,
}));
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: mockAssertWritable,
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
  // Default: the self-heal's two gates both open, so every GET below exercises
  // the same path it did before round-1 A1/A5 added them.
  mockReadConsent.mockResolvedValue(NO_OFFER_YET);
  mockAssertWritable.mockResolvedValue({ ok: true });
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

    // The route still asserts NO junction precondition of its own — if it did,
    // that condition would have two owners and could disagree with the helper's
    // SQL. What round-1 A5 added in front is a "could this possibly do anything?"
    // filter (`pending` + NULL deadline, the only state createImportOffer can act
    // on), not a junction check, and it is never the authority: the helper
    // re-proves both junction halves inside the transaction.
    expect(mockReadConsent).toHaveBeenCalledWith(mockSql, LOCATION_ID, ACCOUNT_ID);
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

  // Round-1 A1. Not one of the 70 intake titles: the GET resolves scope with
  // `allowReadOnly: true` so a past-due owner keeps seeing their banner, but
  // `resolveOwnerScope`'s own JSDoc scopes it to "owner MUTATION routes" and the
  // self-heal IS a mutation. Minting a 7-day offer for an owner whose POST 402s
  // hands them something they can never answer — and because expiry is derived
  // and terminal (#670), the location's one-time Import offer is then consumed
  // permanently by a dashboard render.
  it('GET import-offer does not create an offer for a past-due read-only owner', async () => {
    mockAssertWritable.mockResolvedValue({ ok: false, status: 402, error: 'past_due_read_only' } as never);
    mockReadView.mockResolvedValue({ state: 'importing' } as never);

    const res = await GET(getRequest());

    // The READ is unconditional — a read-only owner still sees where their import
    // got to. Only the write is withheld.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'importing' });
    expect(mockReadView).toHaveBeenCalledWith(mockSql, LOCATION_ID, ACCOUNT_ID);

    expect(mockCreateImportOffer).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  // Round-1 A5. Not one of the 70 intake titles. The GET previously opened a
  // transaction and took `SELECT … FOR UPDATE` on the businesses row for EVERY
  // location on every dashboard mount — including terminal ones where
  // createImportOffer provably cannot act — and the banner polls this endpoint
  // every 4s while importing, against a row four producers and the decision POST
  // also lock.
  it('GET import-offer takes no row lock when no offer could be created', async () => {
    const cannotAct = [
      // Already answered — terminal, and first-write-wins.
      { state: 'accepted' as const, decidedAt: new Date(), expiresAt: new Date() },
      { state: 'declined' as const, decidedAt: new Date(), expiresAt: new Date() },
      // A deadline already exists: the offer was created, nothing to repair.
      { state: 'pending' as const, decidedAt: null, expiresAt: new Date() },
      // Derived-expired — terminal, and re-stamping would resurrect it.
      { state: 'expired' as const, decidedAt: null, expiresAt: new Date() },
      // Not this account's location (or gone).
      null,
    ];

    for (const consent of cannotAct) {
      vi.clearAllMocks();
      mockResolveOwnerScope.mockResolvedValue({
        accountId: ACCOUNT_ID, locationId: LOCATION_ID, userId: 'user-1',
      });
      mockReadView.mockResolvedValue({ state: 'none' });
      mockAssertWritable.mockResolvedValue({ ok: true });
      mockReadConsent.mockResolvedValue(consent);
      mockSql.begin = vi.fn();

      expect((await GET(getRequest())).status).toBe(200);

      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockCreateImportOffer).not.toHaveBeenCalled();
      // Cheapest gate first: the writable check is not even reached, because the
      // consent read already proved there is nothing to write.
      expect(mockAssertWritable).not.toHaveBeenCalled();
      // The banner is still read — the precondition guards the write, not the read.
      expect(mockReadView).toHaveBeenCalledTimes(1);
    }
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
