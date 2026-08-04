import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireWritableOwner,
  mockGetLocationById,
  mockMarkContactDoNotContact,
  mockClearContactDoNotContact,
} = vi.hoisted(() => ({
  mockRequireWritableOwner: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMarkContactDoNotContact: vi.fn(),
  mockClearContactDoNotContact: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    // Identity same-origin wrapper: this file exercises the owner outcomes, and
    // the real wrapper gets its own describe block at the bottom.
    withSameOrigin: () =>
      <TArgs extends unknown[]>(handler: (...args: TArgs) => unknown) => handler,
    requireWritableOwner: (...args: unknown[]) => mockRequireWritableOwner(...args),
  };
});

// Mocked BELOW `../location-scope`, deliberately: the shared `[id]` preamble
// (flag gate → owner auth → uniform-404 scope resolution → 500 mapping) is one
// wrapper now, and stubbing it out would leave nothing checking that these
// routes still run it. Everything from `withScopedContact` down is the real
// code path; only the auth verdict, the location row and the repo are stubs.
vi.mock('@/lib/locations/repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/locations/repo')>();
  return { ...actual, getLocationById: (...args: unknown[]) => mockGetLocationById(...args) };
});

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

/** The authenticated owner scope every test in this file acts under. Kept as
 *  one helper so the second describe block installs exactly the same posture. */
function stubAuthenticatedOwner(): void {
  // The routes ride the contacts surface's watch-mode gate (plan P-6), and it
  // fires before auth — an unset flag would 404 every case below.
  vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
  mockRequireWritableOwner.mockResolvedValue({
    ok: true,
    accountId: ACCOUNT_ID,
    user: { id: OWNER_USER_ID, locationId: LOCATION_ID },
  });
  mockGetLocationById.mockResolvedValue({
    id: LOCATION_ID,
    account_id: ACCOUNT_ID,
    archived_at: null,
  });
}

describe('owner contact suppression route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAuthenticatedOwner();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('derives account business contact and actor ids only from authenticated scope and route params', async () => {
    mockMarkContactDoNotContact.mockResolvedValue('marked');
    mockClearContactDoNotContact.mockResolvedValue('cleared');

    // A caller-supplied body naming other tenants' ids. The route reads none of
    // it: every id it passes down comes from the authenticated owner scope or
    // the resolved route param, so a body field cannot redirect a Suppression
    // ledger write at another account.
    const hostileBody = JSON.stringify({
      accountId: FOREIGN_ACCOUNT_ID,
      businessId: '01900000-0000-7000-8000-0000000000ff',
      contactId: '01900000-0000-7000-8000-0000000000fe',
      actorUserId: '01900000-0000-7000-8000-0000000000fd',
    });
    const authenticatedScope = {
      accountId: ACCOUNT_ID,
      businessId: LOCATION_ID,
      contactId: CONTACT_ID,
      actorUserId: OWNER_USER_ID,
    };

    for (const method of ['POST', 'DELETE'] as const) {
      const request = new NextRequest(
        `https://app.example.com/api/dashboard/contacts/${CONTACT_ID}/suppression`,
        { method, headers: { origin: 'https://app.example.com' }, body: hostileBody },
      );
      const handler = method === 'POST' ? POST : DELETE;
      const response = await handler(request, params);
      expect(response.status, method).toBe(200);
    }

    expect(mockMarkContactDoNotContact).toHaveBeenCalledWith(
      expect.anything(), authenticatedScope,
    );
    expect(mockClearContactDoNotContact).toHaveBeenCalledWith(
      expect.anything(), authenticatedScope,
    );
  });
});

// The wrapper itself, with the real `withSameOrigin` rather than the identity
// stand-in the suite above installs. Last in the file deliberately: it swaps the
// route-helpers mock out of the module registry, and the bindings the tests
// above already imported are unaffected by that.
describe('owner contact suppression route same-origin wrapper', () => {
  it('enforces same-origin on both owner suppression mutations', async () => {
    vi.clearAllMocks();
    stubAuthenticatedOwner();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
    mockMarkContactDoNotContact.mockResolvedValue('marked');
    mockClearContactDoNotContact.mockResolvedValue('cleared');

    // Re-mocked rather than un-mocked: `withSameOrigin` becomes the REAL one
    // (that is the point of this block), while `requireWritableOwner` stays
    // stubbed — restoring it would put a live auth call behind the wrapper and
    // the "not vacuous" assertion below could no longer reach 200.
    vi.doMock('@/lib/auth/route-helpers', async () => {
      const actual = await vi.importActual<typeof import('@/lib/auth/route-helpers')>(
        '@/lib/auth/route-helpers',
      );
      return {
        ...actual,
        requireWritableOwner: (...args: unknown[]) => mockRequireWritableOwner(...args),
      };
    });
    vi.resetModules();
    try {
      const route = await import('../[id]/suppression/route');

      for (const method of ['POST', 'DELETE'] as const) {
        const crossOrigin = new NextRequest(
          `https://app.example.com/api/dashboard/contacts/${CONTACT_ID}/suppression`,
          { method, headers: { origin: 'https://attacker.example.com' } },
        );
        const handler = method === 'POST' ? route.POST : route.DELETE;
        const response = await handler(crossOrigin, params);
        expect(response.status, method).toBe(403);
      }
      // Rejected before any owner work: a cross-origin request must never reach
      // the ledger, not even to be told 404.
      expect(mockRequireWritableOwner).not.toHaveBeenCalled();
      expect(mockMarkContactDoNotContact).not.toHaveBeenCalled();
      expect(mockClearContactDoNotContact).not.toHaveBeenCalled();

      // And the check is not vacuous — a same-origin request still gets through.
      const sameOrigin = await route.POST(suppressionRequest('POST'), params);
      expect(sameOrigin.status).toBe(200);
      expect(mockMarkContactDoNotContact).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@/lib/auth/route-helpers');
      vi.unstubAllEnvs();
    }
  });
});
