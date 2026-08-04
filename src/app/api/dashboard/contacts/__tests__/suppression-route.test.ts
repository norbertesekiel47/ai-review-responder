import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireContactsWriteAccess,
  mockResolveContactsScopedId,
  mockMarkContactDoNotContact,
  mockClearContactDoNotContact,
} = vi.hoisted(() => ({
  mockRequireContactsWriteAccess: vi.fn(),
  mockResolveContactsScopedId: vi.fn(),
  mockMarkContactDoNotContact: vi.fn(),
  mockClearContactDoNotContact: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    // Identity same-origin wrapper: this file exercises the owner outcomes, and
    // the wrapper itself gets its own test in Task 5.
    withSameOrigin: () =>
      <TArgs extends unknown[]>(handler: (...args: TArgs) => unknown) => handler,
  };
});

vi.mock('../location-scope', () => ({
  requireContactsWriteAccess: mockRequireContactsWriteAccess,
  resolveContactsScopedId: mockResolveContactsScopedId,
}));

vi.mock('@/lib/solicitation/contacts-repo', () => ({
  markContactDoNotContact: mockMarkContactDoNotContact,
  clearContactDoNotContact: mockClearContactDoNotContact,
}));

import { DELETE, POST } from '../[id]/suppression/route';

// Route suite for the owner Suppression ledger controls (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.5
// owner do-not-contact and §7.6 owner clearing). The route module lands in
// Task 5, so this file is red at import time — the intended state of the eval
// task.
//
// The two outcomes pinned here are the ones a mapped status code can get wrong
// in a way no repo test would catch:
//
//  1. A contact belonging to another account is the SAME 404 as a contact that
//     does not exist (the sibling delete route's uniform-not-found posture,
//     invariant #8). Any response that distinguishes them confirms the contact
//     exists somewhere else.
//  2. A global row is NOT the owner's to remove (§7.6). Removing one is the
//     admin-only audited Correction path — a different act, a different sink,
//     and never presented to an owner as the same control.

const CONTACT_ID = '01900000-0000-7000-8000-000000000002';
const LOCATION_ID = '01900000-0000-7000-8000-000000000003';
const ACCOUNT_ID = '01900000-0000-7000-8000-000000000004';
const FOREIGN_ACCOUNT_ID = '01900000-0000-7000-8000-000000000005';
const OWNER_USER_ID = '01900000-0000-7000-8000-000000000006';

const params = { params: Promise.resolve({ id: CONTACT_ID }) };

function suppressionRequest(method: 'POST' | 'DELETE'): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/dashboard/contacts/${CONTACT_ID}/suppression`,
    { method, headers: { origin: 'https://app.example.com' } },
  );
}

describe('owner contact suppression route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireContactsWriteAccess.mockResolvedValue({
      ok: true,
      accountId: ACCOUNT_ID,
      user: { id: OWNER_USER_ID, locationId: LOCATION_ID },
    });
    mockResolveContactsScopedId.mockResolvedValue({
      ok: true,
      id: CONTACT_ID,
      locationId: LOCATION_ID,
    });
  });

  it('returns a uniform 404 for a contact belonging to another account', async () => {
    // The repo's `businesses` join is the account-scope check, so a foreign
    // contact and a missing one both arrive here as 'not_found'.
    mockMarkContactDoNotContact.mockResolvedValue('not_found');

    const response = await POST(suppressionRequest('POST'), params);

    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: 'Not found' });
    // Nothing in the response may confirm the contact exists elsewhere: not the
    // owning account, not a 403, not a differently-worded message.
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain(FOREIGN_ACCOUNT_ID.toLowerCase());
    expect(serialized).not.toContain('account');
    expect(serialized).not.toContain('forbidden');
    // The authenticated scope is what reached the repo — never anything the
    // caller could choose.
    expect(mockMarkContactDoNotContact).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      businessId: LOCATION_ID,
      contactId: CONTACT_ID,
      actorUserId: OWNER_USER_ID,
    });
  });

  it('refuses to clear a global row through the owner path', async () => {
    // 'not_marked' is the shape a global-only match produces: the repo's
    // predicate can only ever reach `scope='account' AND account_id = <the
    // caller's>`, so a global row leaves it with nothing to delete.
    mockClearContactDoNotContact.mockResolvedValue('not_marked');

    const response = await DELETE(suppressionRequest('DELETE'), params);

    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: 'No do-not-contact to clear' });
    // The response must never claim the contact came off the Suppression
    // ledger, and must never borrow the banned re-subscribe vocabulary — the
    // Correction path is admin-only and is not this control.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const banned of ['cleared', 'unsuppress', 're-subscribe', 'resubscribe', 'opted back']) {
      expect(serialized).not.toContain(banned);
    }
  });
});
