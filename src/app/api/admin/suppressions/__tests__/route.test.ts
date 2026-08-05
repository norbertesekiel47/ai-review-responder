import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireAdminWithAal2,
  mockLookupSuppressions,
  mockRecordAdminManualSuppression,
  mockCorrectSuppression,
  mockSql,
  resetMockSql,
} = await vi.hoisted(async () => {
  const helpers = await import('../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    mockRequireAdminWithAal2: vi.fn(),
    mockLookupSuppressions: vi.fn(),
    mockRecordAdminManualSuppression: vi.fn(),
    mockCorrectSuppression: vi.fn(),
    ...helpers.createMockSql(),
  };
});

vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: mockRequireAdminWithAal2,
  internalError: vi.fn(() => NextResponse.json({ error: 'internal_error' }, { status: 500 })),
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/admin/suppressions-service', () => ({
  lookupSuppressions: mockLookupSuppressions,
  recordAdminManualSuppression: mockRecordAdminManualSuppression,
  correctSuppression: mockCorrectSuppression,
}));

// Route suite for the admin Suppression ledger surfaces (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.3,
// §8.2, §9.5). Three route modules, one per act: `lookup/` reads, `route.ts`
// enters, `correct/` corrects. All three are POSTs to the same prefix — the
// segment is what distinguishes them — and the lookup is a POST despite being
// a read because §9.5 forbids the raw handle reaching a place that logs it.
//
// These routes are deliberately NOT flag-gated (plan P-6): a statutory
// 10-business-day obligation behind a feature flag is a violation waiting for a
// flag flip. The authorization gate is therefore the ONLY thing standing
// between an unauthenticated caller and a cross-tenant read of every opted-out
// recipient — plus, on the Correction path, the removal of a recipient's
// revocation.

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

const SUPPRESSION_ID = '01900000-0000-7000-8000-000000000001';

// The lookup is a POST with the address in the body, not a GET with it in the
// query string (§9.5 — a query string is logged by construction).
function lookupRequest(
  body: unknown = { email: 'person@example.com' },
  origin = 'https://app.example.com',
): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/suppressions/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

function entryRequest(
  body: unknown = { email: 'person@example.com', note: 'mailbox ref 1' },
  origin = 'https://app.example.com',
): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/suppressions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

function correctRequest(
  body: unknown = { suppressionId: SUPPRESSION_ID, reason: 'admin typo' },
  origin = 'https://app.example.com',
): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/suppressions/correct', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
/** Any other user id a caller might try to write into the audit trail. */
const IMPOSTOR_ID = '44444444-4444-4444-8444-444444444444';

function gateAllows(): void {
  mockRequireAdminWithAal2.mockResolvedValue({ ok: true, admin: { id: ADMIN_ID } });
}

describe('admin suppression routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('requires admin AAL2 on every suppression admin route', async () => {
    mockRequireAdminWithAal2.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'mfa_required' }, { status: 403 }),
    });

    const { POST: entryPost } = await import('../route');
    const { POST: lookupPost } = await import('../lookup/route');
    const { POST: correctPost } = await import('../correct/route');

    const responses = [
      await lookupPost(lookupRequest()),
      await entryPost(entryRequest()),
      await correctPost(correctRequest()),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
    }
    expect(mockRequireAdminWithAal2).toHaveBeenCalledTimes(3);
    // The gate decides BEFORE any service call: a lookup that ran would have
    // read across every tenant, and a correction that ran would have removed a
    // recipient's revocation for an unauthenticated caller.
    expect(mockLookupSuppressions).not.toHaveBeenCalled();
    expect(mockRecordAdminManualSuppression).not.toHaveBeenCalled();
    expect(mockCorrectSuppression).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('uses the authenticated admin id for entry and correction and rejects client-supplied actor fields', async () => {
    gateAllows();
    mockRecordAdminManualSuppression.mockResolvedValue({
      ok: true,
      created: true,
      handle: 'person@example.com',
    });
    mockCorrectSuppression.mockResolvedValue('corrected');

    const { POST: entryPost } = await import('../route');
    const { POST: correctPost } = await import('../correct/route');

    const entryResponse = await entryPost(entryRequest());
    expect(entryResponse.status).toBe(200);
    // The actor is the gate's admin, never a body field: an audit record that
    // can name an arbitrary user proves nothing about who acted.
    expect(mockRecordAdminManualSuppression).toHaveBeenCalledWith(mockSql, {
      rawEmail: 'person@example.com',
      adminUserId: ADMIN_ID,
      note: 'mailbox ref 1',
    });

    const correctResponse = await correctPost(correctRequest());
    expect(correctResponse.status).toBe(200);
    expect(mockCorrectSuppression).toHaveBeenCalledWith(mockSql, {
      suppressionId: SUPPRESSION_ID,
      adminUserId: ADMIN_ID,
      reason: 'admin typo',
    });

    vi.clearAllMocks();
    gateAllows();

    // A client-supplied actor field is a 400 from strictObject, not a silently
    // ignored key — the difference between "cannot be set" and "is overwritten
    // today" is one refactor.
    const spoofedEntry = await entryPost(entryRequest({
      email: 'person@example.com',
      note: 'mailbox ref 1',
      createdByUserId: IMPOSTOR_ID,
    }));
    expect(spoofedEntry.status).toBe(400);
    expect(mockRecordAdminManualSuppression).not.toHaveBeenCalled();

    const spoofedCorrection = await correctPost(correctRequest({
      suppressionId: SUPPRESSION_ID,
      reason: 'admin typo',
      removedByUserId: IMPOSTOR_ID,
    }));
    expect(spoofedCorrection.status).toBe(400);
    expect(mockCorrectSuppression).not.toHaveBeenCalled();
  });

  it('rejects blank entry notes blank correction reasons malformed suppression ids and unknown fields before any write', async () => {
    gateAllows();

    const { POST: entryPost } = await import('../route');
    const { POST: correctPost } = await import('../correct/route');

    const entryBodies: unknown[] = [
      { email: 'person@example.com', note: '' },
      { email: 'person@example.com', note: '   ' },
      { email: '', note: 'mailbox ref 1' },
      { email: 'person@example.com' },
      { email: 'person@example.com', note: 'mailbox ref 1', scope: 'account' },
    ];
    for (const body of entryBodies) {
      const response = await entryPost(entryRequest(body));
      expect(response.status).toBe(400);
    }

    const correctBodies: unknown[] = [
      { suppressionId: SUPPRESSION_ID, reason: '' },
      { suppressionId: SUPPRESSION_ID, reason: '  ' },
      { suppressionId: 'not-a-uuid', reason: 'admin typo' },
      { suppressionId: SUPPRESSION_ID },
      { suppressionId: SUPPRESSION_ID, reason: 'admin typo', force: true },
    ];
    for (const body of correctBodies) {
      const response = await correctPost(correctRequest(body));
      expect(response.status).toBe(400);
    }

    // Validation precedes every write: a rejected body must never have reached
    // the ledger or the Correction path's audit sink.
    expect(mockRecordAdminManualSuppression).not.toHaveBeenCalled();
    expect(mockCorrectSuppression).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('enforces same-origin on both admin suppression mutations', async () => {
    gateAllows();

    const { POST: entryPost } = await import('../route');
    const { POST: correctPost } = await import('../correct/route');

    // The wrapper lives at the export, so only calling the exported POST
    // exercises it — a mocked-AAL2 assertion alone never would.
    const entryResponse = await entryPost(entryRequest(
      { email: 'person@example.com', note: 'mailbox ref 1' },
      'https://evil.example.com',
    ));
    const correctResponse = await correctPost(correctRequest(
      { suppressionId: SUPPRESSION_ID, reason: 'admin typo' },
      'https://evil.example.com',
    ));

    expect(entryResponse.status).toBe(403);
    expect(correctResponse.status).toBe(403);
    // Same-origin is decided before the gate, so a cross-origin caller never
    // even reaches the authorization step.
    expect(mockRequireAdminWithAal2).not.toHaveBeenCalled();
    expect(mockRecordAdminManualSuppression).not.toHaveBeenCalled();
    expect(mockCorrectSuppression).not.toHaveBeenCalled();
  });

  it('enforces same-origin on the admin suppression lookup', async () => {
    gateAllows();

    const { POST: lookupPost } = await import('../lookup/route');

    // The lookup is a read, but it is a POST, so it gets the same wrapper as
    // the mutations — a cross-origin caller must not be able to drive a
    // cross-tenant read of every opted-out recipient from a victim's session.
    const response = await lookupPost(lookupRequest(
      { email: 'person@example.com' },
      'https://evil.example.com',
    ));

    expect(response.status).toBe(403);
    expect(mockRequireAdminWithAal2).not.toHaveBeenCalled();
    expect(mockLookupSuppressions).not.toHaveBeenCalled();
  });

  it('carries the looked-up address in the request body and never in the URL', async () => {
    gateAllows();
    mockLookupSuppressions.mockResolvedValue({
      ok: true,
      handle: 'person@example.com',
      rows: [],
      corrections: [],
    });

    const { POST: lookupPost } = await import('../lookup/route');
    const request = lookupRequest();

    // §9.5: never log the raw handle. A query string is logged by construction
    // — Vercel access logs, every log drain downstream, browser history — and
    // no care inside the handler takes it back out. This is why the read is a
    // POST; do not "simplify" it back to a GET.
    expect(request.url).not.toContain('person');
    expect(request.nextUrl.search).toBe('');

    const response = await lookupPost(request);
    expect(response.status).toBe(200);
    expect(mockLookupSuppressions).toHaveBeenCalledWith(mockSql, 'person@example.com');
  });

  it('maps the lookup service result to an explicit response body rather than serialising the union', async () => {
    gateAllows();
    mockLookupSuppressions.mockResolvedValue({
      ok: true,
      handle: 'person@example.com',
      rows: [],
      corrections: [],
    });

    const { POST: lookupPost } = await import('../lookup/route');
    const okResponse = await lookupPost(lookupRequest());
    expect(okResponse.status).toBe(200);

    // The service's `ok` discriminant is internal. Shipping the union verbatim
    // makes every future `ok: false` variant a silent wire-contract change that
    // arrives at the browser as a raw token inside a 200.
    const okBody = (await okResponse.json()) as Record<string, unknown>;
    expect(Object.keys(okBody).sort()).toEqual(['corrections', 'handle', 'rows']);
    expect(okBody).toEqual({ handle: 'person@example.com', rows: [], corrections: [] });

    vi.clearAllMocks();
    gateAllows();
    mockLookupSuppressions.mockResolvedValue({ ok: false, error: 'invalid_handle' });

    // Each `ok: false` variant maps to its own status at the boundary.
    const failResponse = await lookupPost(lookupRequest());
    expect(failResponse.status).toBe(400);
    expect(await failResponse.json()).toEqual({ error: 'invalid_handle' });
  });

  it('rejects a malformed or unknown-field lookup body before reading any tenant', async () => {
    gateAllows();

    const { POST: lookupPost } = await import('../lookup/route');

    const bodies: unknown[] = [
      { email: '' },
      { email: '   ' },
      {},
      { email: 'person@example.com', scope: 'account' },
    ];
    for (const body of bodies) {
      const response = await lookupPost(lookupRequest(body));
      expect(response.status).toBe(400);
    }

    expect(mockLookupSuppressions).not.toHaveBeenCalled();
  });
});
