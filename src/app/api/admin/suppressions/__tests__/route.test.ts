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
// §8.2). Both route modules land in Task 4, so this file is red at import time
// — the intended state of the eval task.
//
// These routes are deliberately NOT flag-gated (plan P-6): a statutory
// 10-business-day obligation behind a feature flag is a violation waiting for a
// flag flip. The authorization gate is therefore the ONLY thing standing
// between an unauthenticated caller and a cross-tenant read of every opted-out
// recipient — plus, on the Correction path, the removal of a recipient's
// revocation.

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

const SUPPRESSION_ID = '01900000-0000-7000-8000-000000000001';

function lookupRequest(): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/admin/suppressions?email=person@example.com',
  );
}

function entryRequest(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/suppressions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify({ email: 'person@example.com', note: 'mailbox ref 1' }),
  });
}

function correctRequest(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/suppressions/correct', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify({ suppressionId: SUPPRESSION_ID, reason: 'admin typo' }),
  });
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

    const { GET, POST: entryPost } = await import('../route');
    const { POST: correctPost } = await import('../correct/route');

    const responses = [
      await GET(lookupRequest()),
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
});
