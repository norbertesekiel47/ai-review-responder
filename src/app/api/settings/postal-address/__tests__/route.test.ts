import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// PUT /api/settings/postal-address — the attestation route (#656 T4).
//
// Auth precedent is `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`,
// NOT `requireSettingsOwner`: that helper resolves no location and, per its own
// doc comment, deliberately skips the writable-subscription gate. This route
// needs a cookie-resolved active location, a non-writable-subscription refusal,
// and `users.id` for the attester — `resolveOwnerScope` supplies all three, and
// `withSameOrigin()` still wraps the handler because that helper does no CSRF.
//
// Two behaviours the subscription gate does NOT cover, and the tests that pin
// them:
//
//  - Offboarding. `isFullBlockState` is true for `delete_data` at ANY status,
//    and confirming offboarding does not itself cancel the subscription — so a
//    `delete_data`/`pending` account is still `active`, sails through the
//    subscription gate, and would be able to mutate its sender address
//    mid-teardown. The route re-applies `getOffboardingState` +
//    `isOperationalUIBlocked` itself, BEFORE the body parse.
//
//  - Version assent. An unknown or stale `attestationVersion` is a 400 before
//    any write: a client must never assent to one text while the server records
//    another. `z.strictObject` is equally load-bearing — a body naming
//    `businessId` or `userId` is a tenant-selection knob and must be a 400, not
//    a silently ignored field.
//
// EVERY rejection asserts ZERO WRITES — `expect(mockAttest).not.toHaveBeenCalled()`
// — not merely a status code. The one deliberate exception is the lint case:
// `attestPostalAddress` IS the linter (it takes the RAW address so no code path
// can store an unlinted one), so it is reached by design and returns `invalid`
// before its own UPDATE. That test instead drives the REAL `lintPostalAddress`
// and asserts the raw address reached the module unchanged.
//
// WHAT IS MOCKED AND WHY: only the seams that would open a socket —
// `requireRole`, `getRequestScope`, the `sql` client, and the one module
// function this route delegates to. `resolveOwnerScope`, the same-origin gate,
// the offboarding gate and the postal-address lint all run FOR REAL, so the
// subscription/offboarding/cookie behaviour under test is the real behaviour
// rather than a restatement of the mock.

const {
  mockRequireRole,
  mockGetRequestScope,
  mockAttest,
  accountRow,
  offboardingRows,
  sqlMock,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();
  const mockAttest = vi.fn();
  const accountRow: { value: Record<string, unknown> } = { value: {} };
  const offboardingRows: { value: unknown[] } = { value: [] };

  // Two statements reach the DB on the real path: resolveOwnerScope's
  // subscription gate and getOffboardingState. Everything else returns [].
  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    if (text.includes('subscription_status')) return [accountRow.value];
    if (text.includes('FROM account_offboardings')) return offboardingRows.value;
    return [];
  });

  return { mockRequireRole, mockGetRequestScope, mockAttest, accountRow, offboardingRows, sqlMock };
});

vi.mock('@/lib/db/server', () => ({
  sql: sqlMock,
  jsonb: (v: unknown) => v,
}));

// importActual keeps the REAL `AuthError` class, so `resolveOwnerScope`'s
// `instanceof AuthError` branch is the one exercised — a hand-rolled stand-in
// would silently fall through to the generic 401.
vi.mock('@/lib/db/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/auth')>('@/lib/db/auth');
  return { ...actual, requireRole: (...args: unknown[]) => mockRequireRole(...args) };
});

vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
}));

// Only `attestPostalAddress` is replaced. The attestation-version constant and
// `lintPostalAddress` stay REAL: the constant is the compliance record (a
// hand-copied literal here would let the route and the schema drift apart), and
// the lint is what the lint test drives.
vi.mock('@/lib/solicitation/postal-address', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/solicitation/postal-address')>(
      '@/lib/solicitation/postal-address',
    );
  return { ...actual, attestPostalAddress: (...args: unknown[]) => mockAttest(...args) };
});

import { AuthError } from '@/lib/db/auth';
import {
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  lintPostalAddress,
  type AttestPostalAddressParams,
} from '@/lib/solicitation/postal-address';
import { PUT } from '../route';

// ── Fixtures ────────────────────────────────────────────────────────

const APP_URL = 'http://localhost:3000';
const ACCOUNT_ID = '01999000-0000-7000-8000-000000000001';
/** What getRequestScope falls back to when the cookie is absent or invalid. */
const PRIMARY_LOCATION_ID = '01999000-0000-7000-8000-0000000000a1';
/** A SECOND location on the same account — the one the owner is looking at. */
const ACTIVE_LOCATION_ID = '01999000-0000-7000-8000-0000000000a2';
/** `users.id` — the app-user PK the attestation column stores. */
const APP_USER_ID = '01999000-0000-7000-8000-0000000000b1';
/** The Supabase Auth UID. A decoy: it must NEVER reach the attestation write. */
const SUPABASE_AUTH_UID = '01999000-0000-7000-8000-0000000000b2';

const VALID_ADDRESS = '123 Main St\nAustin, TX 78701';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: VALID_ADDRESS,
    attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
    attested: true,
    ...overrides,
  };
}

function makeRequest(opts?: {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  locationScopeCookie?: string | null;
}): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers.Origin = origin;
  const cookie = opts?.locationScopeCookie;
  if (cookie) headers.Cookie = `rw_location_scope=${cookie}`;

  return new NextRequest(`${APP_URL}/api/settings/postal-address`, {
    method: 'PUT',
    headers,
    body: opts?.rawBody ?? JSON.stringify(opts?.body ?? validBody()),
  });
}

/** The single call `attestPostalAddress` received, typed. */
function attestCall(): AttestPostalAddressParams {
  expect(mockAttest).toHaveBeenCalledTimes(1);
  return mockAttest.mock.calls[0]![1] as AttestPostalAddressParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;

  mockRequireRole.mockResolvedValue({
    id: APP_USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    // The primary location, deliberately NOT the one the cookie selects.
    locationId: PRIMARY_LOCATION_ID,
    // Decoy — the Supabase Auth identity is on the session but is not the
    // attester. A route that reached for it would fail the attester test.
    authId: SUPABASE_AUTH_UID,
  });

  // Faithful to the real helper's contract: the cookie wins, primary is the
  // fallback. This is what makes the cookie test falsifiable — a route that
  // hard-coded the primary location would still pass if this echoed one value.
  mockGetRequestScope.mockImplementation(
    async (_sql: unknown, accountId: string, cookieLocationId: string | null) => ({
      accountId,
      currentLocationId: cookieLocationId ?? PRIMARY_LOCATION_ID,
    }),
  );

  accountRow.value = { subscription_status: 'active', past_due_at: null, flags: null };
  offboardingRows.value = [];
  mockAttest.mockResolvedValue({ status: 'attested' });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('PUT /api/settings/postal-address', () => {
  it('PUT /api/settings/postal-address rejects unauthenticated and non-owner callers before writing', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('unauthorized', 401));
    const unauthenticated = await PUT(makeRequest());
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: 'unauthorized' });
    expect(mockAttest).not.toHaveBeenCalled();

    mockRequireRole.mockRejectedValueOnce(new AuthError('forbidden', 403));
    const nonOwner = await PUT(makeRequest());
    expect(nonOwner.status).toBe(403);
    expect(await nonOwner.json()).toEqual({ error: 'forbidden' });
    expect(mockAttest).not.toHaveBeenCalled();

    // An authenticated owner with no account is the third shape of "not an
    // owner of anything" — also a refusal, also no write.
    mockRequireRole.mockResolvedValueOnce({
      id: APP_USER_ID,
      name: 'Test Owner',
      email: 'owner@test.com',
      role: 'owner',
      accountId: null,
      locationId: null,
    });
    const noAccount = await PUT(makeRequest());
    expect(noAccount.status).toBe(403);
    expect(await noAccount.json()).toEqual({ error: 'no_business' });
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/postal-address rejects cross-origin mutation requests', async () => {
    const response = await PUT(makeRequest({ origin: 'https://evil.example.com' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(mockAttest).not.toHaveBeenCalled();
    // withSameOrigin wraps the handler, so a cross-origin request is refused
    // before the session is even resolved.
    expect(mockRequireRole).not.toHaveBeenCalled();

    // A request with no Origin header at all is equally refused — an absent
    // header must not read as "same origin".
    const originless = await PUT(makeRequest({ origin: null }));
    expect(originless.status).toBe(403);
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/postal-address refuses writes for a non-writable subscription', async () => {
    // A past-due account past its 7-day recovery window. This is the precise
    // case `requireSettingsOwner` would have ALLOWED through — it skips the
    // writable-subscription gate on purpose — so it is the discriminator
    // between the two helpers, not merely a generic auth case.
    accountRow.value = {
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      flags: null,
    };
    const readOnly = await PUT(makeRequest());
    expect(readOnly.status).toBe(402);
    expect(await readOnly.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAttest).not.toHaveBeenCalled();

    accountRow.value = { subscription_status: 'cancelled', past_due_at: null, flags: null };
    const cancelled = await PUT(makeRequest());
    expect(cancelled.status).toBe(403);
    expect(await cancelled.json()).toEqual({ error: 'subscription_inactive' });
    expect(mockAttest).not.toHaveBeenCalled();

    // Sanity: a past-due account still INSIDE the window is writable, so the
    // test above is pinning the window and not just the status string.
    accountRow.value = {
      subscription_status: 'past_due',
      past_due_at: new Date(Date.now() - 86_400_000).toISOString(),
      flags: null,
    };
    const inGrace = await PUT(makeRequest());
    expect(inGrace.status).toBe(200);
    expect(mockAttest).toHaveBeenCalledTimes(1);
  });

  it('PUT /api/settings/postal-address refuses writes while the account is offboarding', async () => {
    // delete_data at status `pending`: operationally blocked, yet the
    // subscription is still ACTIVE because confirming offboarding does not
    // itself cancel it. Without the explicit gate this request would succeed.
    accountRow.value = { subscription_status: 'active', past_due_at: null, flags: null };
    offboardingRows.value = [
      {
        id: '01999000-0000-7000-8000-0000000000c1',
        account_id: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'pending',
        failed_step: null,
        terminal_at: null,
        access_ends_at: null,
        teardown_started_at: null,
        purge_after: null,
        purge_started_at: null,
        purge_cancelled_at: null,
      },
    ];

    const response = await PUT(makeRequest());
    // Specifically the offboarding refusal, not `subscription_inactive` — the
    // subscription gate did not fire, which is the whole point.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockAttest).not.toHaveBeenCalled();

    // The gate runs BEFORE the body is read: a syntactically broken body still
    // returns the offboarding refusal, never `invalid_body`.
    const brokenBody = await PUT(makeRequest({ rawBody: '{ not json' }));
    expect(brokenBody.status).toBe(403);
    expect(await brokenBody.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/postal-address rejects a request that omits the attestation', async () => {
    const omitted = await PUT(
      makeRequest({
        body: { address: VALID_ADDRESS, attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION },
      }),
    );
    expect(omitted.status).toBe(400);
    expect(await omitted.json()).toEqual({ error: 'invalid_request' });
    expect(mockAttest).not.toHaveBeenCalled();

    // An UNCHECKED box is a refusal, never a silent skip of the attestation.
    const unchecked = await PUT(makeRequest({ body: validBody({ attested: false }) }));
    expect(unchecked.status).toBe(400);
    expect(mockAttest).not.toHaveBeenCalled();

    // A truthy non-literal must not pass for consent either.
    const truthy = await PUT(makeRequest({ body: validBody({ attested: 'true' }) }));
    expect(truthy.status).toBe(400);
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/postal-address rejects an unknown attestation version without writing', async () => {
    const unknownVersion = await PUT(
      makeRequest({ body: validBody({ attestationVersion: 'postal_address_attestation_v99' }) }),
    );
    expect(unknownVersion.status).toBe(400);
    expect(await unknownVersion.json()).toEqual({ error: 'invalid_request' });
    expect(mockAttest).not.toHaveBeenCalled();

    // A stale version — the shape this guard actually exists for: the client
    // rendered an older checkbox text and would be assenting to wording the
    // server no longer records.
    const staleVersion = await PUT(
      makeRequest({ body: validBody({ attestationVersion: 'postal_address_attestation_v0' }) }),
    );
    expect(staleVersion.status).toBe(400);
    expect(mockAttest).not.toHaveBeenCalled();

    // Omitting the version entirely is the same refusal.
    const missingVersion = await PUT(
      makeRequest({ body: { address: VALID_ADDRESS, attested: true } }),
    );
    expect(missingVersion.status).toBe(400);
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/postal-address rejects an address that fails the lint', async () => {
    // The module IS the linter — it takes the RAW address so no path can store
    // an unlinted one — so here it runs the REAL lint. Nothing is written: the
    // module returns `invalid` before its own UPDATE.
    mockAttest.mockImplementation(async (_sql: unknown, params: AttestPostalAddressParams) => {
      const lint = lintPostalAddress(params.address);
      return lint.ok ? { status: 'attested' } : { status: 'invalid', reason: lint.reason };
    });

    // The service-area trap from spec §7.5 — what Google returns for a mobile
    // locksmith, and never a valid sender address.
    const serviceArea = await PUT(makeRequest({ body: validBody({ address: 'Austin, TX, USA' }) }));
    expect(serviceArea.status).toBe(400);
    expect(await serviceArea.json()).toEqual({ error: 'invalid_address', reason: 'single_line' });

    // The route hands over the RAW bytes: it neither pre-lints nor normalizes,
    // so there is exactly one author of what a valid address is.
    expect(attestCall().address).toBe('Austin, TX, USA');

    mockAttest.mockClear();
    const noPostalCode = await PUT(
      makeRequest({ body: validBody({ address: "Joe's Diner\nAustin, TX" }) }),
    );
    expect(noPostalCode.status).toBe(400);
    expect(await noPostalCode.json()).toEqual({
      error: 'invalid_address',
      reason: 'no_postal_code',
    });

    // The same handler with a lint-clean address succeeds, so the 400 above is
    // the lint's verdict and not a hard-coded refusal.
    mockAttest.mockClear();
    const accepted = await PUT(makeRequest());
    expect(accepted.status).toBe(200);
  });

  it('PUT /api/settings/postal-address records the authenticated app user as the attester', async () => {
    const response = await PUT(makeRequest({ locationScopeCookie: ACTIVE_LOCATION_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'attested' });

    const call = attestCall();
    // `users.id` — the PK the attestation column stores.
    expect(call.userId).toBe(APP_USER_ID);
    // NOT the Supabase Auth UID, which the session also carries.
    expect(call.userId).not.toBe(SUPABASE_AUTH_UID);
    expect(call.accountId).toBe(ACCOUNT_ID);

    // And it cannot be named by the client: `strictObject` refuses a body that
    // carries a `userId` rather than ignoring it, so there is no request shape
    // in which the attester is anything but the session's own user.
    mockAttest.mockClear();
    const bodySuppliedUser = await PUT(
      makeRequest({ body: validBody({ userId: SUPABASE_AUTH_UID }) }),
    );
    expect(bodySuppliedUser.status).toBe(400);
    expect(await bodySuppliedUser.json()).toEqual({ error: 'invalid_request' });
    expect(mockAttest).not.toHaveBeenCalled();

    // The module verifies the actor itself (the column has no FK), and its
    // refusal surfaces as a 403 rather than being flattened into a 500.
    mockAttest.mockClear();
    mockAttest.mockResolvedValueOnce({ status: 'actor_not_in_account' });
    const foreignActor = await PUT(makeRequest());
    expect(foreignActor.status).toBe(403);
    expect(await foreignActor.json()).toEqual({ error: 'actor_not_in_account' });
  });

  it('PUT /api/settings/postal-address writes the cookie-resolved active location', async () => {
    const withCookie = await PUT(makeRequest({ locationScopeCookie: ACTIVE_LOCATION_ID }));
    expect(withCookie.status).toBe(200);
    expect(attestCall().businessId).toBe(ACTIVE_LOCATION_ID);
    // The cookie value is what reached the scope resolver.
    expect(mockGetRequestScope).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      ACTIVE_LOCATION_ID,
    );

    // The SAME request without the cookie writes the PRIMARY location instead.
    // Two different destinations from one handler is what proves the location
    // is cookie-resolved: a route that hard-coded the primary would pass the
    // assertion above only if both values were the same, and they are not.
    mockAttest.mockClear();
    const withoutCookie = await PUT(makeRequest());
    expect(withoutCookie.status).toBe(200);
    expect(attestCall().businessId).toBe(PRIMARY_LOCATION_ID);
    expect(ACTIVE_LOCATION_ID).not.toBe(PRIMARY_LOCATION_ID);

    // A body-supplied `businessId` is a tenant-selection knob: refused, not
    // ignored. The location is server-derived or the request does not happen.
    mockAttest.mockClear();
    const bodySuppliedLocation = await PUT(
      makeRequest({
        body: validBody({ businessId: PRIMARY_LOCATION_ID }),
        locationScopeCookie: ACTIVE_LOCATION_ID,
      }),
    );
    expect(bodySuppliedLocation.status).toBe(400);
    expect(await bodySuppliedLocation.json()).toEqual({ error: 'invalid_request' });
    expect(mockAttest).not.toHaveBeenCalled();

    // A location the account does not own is a 404 from the module's own
    // account-scoped UPDATE — distinct from the actor refusal above, so the
    // owner learns which guard fired.
    mockAttest.mockClear();
    mockAttest.mockResolvedValueOnce({ status: 'business_not_found' });
    const foreignLocation = await PUT(makeRequest());
    expect(foreignLocation.status).toBe(404);
    expect(await foreignLocation.json()).toEqual({ error: 'business_not_found' });
  });
});
