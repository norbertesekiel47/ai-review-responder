// src/app/api/locations/__tests__/promote-primary.test.ts
//
// TDD assertions for POST /api/locations/promote-primary.
// Feature spec: Primary promotion changes is_primary atomically from old to new.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockPromotePrimaryTransaction } = vi.hoisted(() => ({
  mockPromotePrimaryTransaction: vi.fn(),
}));

vi.mock('@/lib/locations/promote-primary-tx', () => ({
  promotePrimaryTransaction: mockPromotePrimaryTransaction,
}));

process.env.MULTI_LOCATION_ENABLED = 'true';

import { POST } from '../promote-primary/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OLD_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const NEW_PRIMARY_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/locations/promote-primary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/locations/promote-primary', () => {
  // ── Returns 404 when MULTI_LOCATION_ENABLED is not true ───────────────

  it('returns 404 when MULTI_LOCATION_ENABLED is not true', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    process.env.MULTI_LOCATION_ENABLED = 'true';
  });

  // ── 200 on successful promotion ────────────────────────────────────────

  it('returns 200 on successful promotion', async () => {
    mockPromotePrimaryTransaction.mockResolvedValueOnce({
      oldPrimaryId: OLD_PRIMARY_ID,
      newPrimaryId: NEW_PRIMARY_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oldPrimaryId).toBe(OLD_PRIMARY_ID);
    expect(body.newPrimaryId).toBe(NEW_PRIMARY_ID);
  });

  // ── Delegates to promotePrimaryTransaction ─────────────────────────────

  it('calls promotePrimaryTransaction with correct parameters', async () => {
    mockPromotePrimaryTransaction.mockResolvedValueOnce({
      oldPrimaryId: OLD_PRIMARY_ID,
      newPrimaryId: NEW_PRIMARY_ID,
    });

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    await POST(req);

    expect(mockPromotePrimaryTransaction).toHaveBeenCalledTimes(1);
    const txInput = mockPromotePrimaryTransaction.mock.calls[0]![0];
    expect(txInput.newPrimaryId).toBe(NEW_PRIMARY_ID);
    expect(txInput.accountId).toBe(ACCOUNT_ID);
  });

  // ── 400 when new primary is already primary ───────────────────────────

  it('returns 400 when new primary is already primary', async () => {
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('location bbbb...0002 is already the primary location'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('already_primary');
  });

  // ── 404 when new primary not found ────────────────────────────────────

  it('returns 404 when new primary location not found', async () => {
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('new primary location not found or not accessible: 0000...'),
    );

    const req = mkRequest({
      newPrimaryId: '00000000-0000-7f00-8000-000000000000',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('location_not_found');
  });

  // ── 400 when new primary is archived ──────────────────────────────────

  it('returns 400 when new primary is archived', async () => {
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('location bbbb...0002 is archived and cannot be promoted to primary'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('location_archived');
  });

  // ── Input validation ───────────────────────────────────────────────────

  it('returns 400 for invalid newPrimaryId format', async () => {
    const req = mkRequest({
      newPrimaryId: 'not-a-uuid',
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing accountId', async () => {
    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  // ── 500 on unexpected transaction failure ──────────────────────────────

  it('returns 500 on unexpected transaction failure', async () => {
    mockPromotePrimaryTransaction.mockRejectedValueOnce(
      new Error('Unexpected: connection lost'),
    );

    const req = mkRequest({
      newPrimaryId: NEW_PRIMARY_ID,
      accountId: ACCOUNT_ID,
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('promote_primary_failed');
  });
});
