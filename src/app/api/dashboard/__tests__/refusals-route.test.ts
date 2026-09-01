// `GET /api/dashboard/refusals` — route eval (#1014 T5).
//
// Titles 23-31, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// MOCKING LEVEL is `./scope-route.test.ts`'s: the auth PRIMITIVE
// (`@/lib/db/auth`), `@/lib/db/server`, the location repo and
// `@/lib/refusals/read` — never the dashboard policy helpers. ESM internal calls
// do not go through a mocked export, so a stub on a composed helper
// (`resolveDashboardLocation`) would stop intercepting the moment
// `withDashboardOwnerRead` called a sibling in that module, and the scoping
// cases below would prove nothing.
//
// THREE OF THESE NINE ARE REDACTION CASES, not shape cases, and they are
// deliberately three. `refusal_events` is deny-all RLS and the read runs through
// the RLS-BYPASSING `postgres` role, so application redaction IS the access
// control (ADR 0023) — and RLS filters ROWS, not COLUMNS. Each case plants a
// sentinel somewhere the route could plausibly pick it up (the request URL, a
// thrown error's message, a postgres.js error's `query`/`parameters`/`detail`)
// and asserts its ABSENCE from the serialized response walked at EVERY depth,
// and from every captured log line. The body, the error arm and the logs are
// three separate sinks; a leak on any one is a leak.
//
// THE IMPERSONATION CASE DOES NOT MOCK `requireRole`, and that is the whole
// point of it (carry-forward finding SC-3). The parked branch mocked the gate
// and then asserted the admin's account was absent from the read's arguments —
// which was vacuous, because the mock returned the owner unconditionally and
// impersonation was never exercised. Here the `@/lib/db/auth` mock is a
// PASS-THROUGH by default and only that case turns the override off, so the
// real `requireRole` runs against a real session and a real `users` row.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import type { RefusalLog } from '@/lib/refusals/read';

// ── Hoisted shared state ──────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRefusalLog,
  mockGetLocationById,
  mockGetAuthUser,
  sqlRows,
  sqlCallCount,
  useRequireRoleMock,
  sqlSentinel,
} = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const calls = { value: 0 };
  return {
    mockRequireRole: vi.fn(),
    mockGetRefusalLog: vi.fn(),
    mockGetLocationById: vi.fn(),
    mockGetAuthUser: vi.fn(),
    sqlRows: rows,
    sqlCallCount: calls,
    // Flipped OFF by the impersonation case so the REAL `requireRole` runs.
    useRequireRoleMock: { value: true },
    // Callable, so the real `getCurrentUser` can issue its one query through it
    // — and identity-stable, so the orchestration cases can assert the exact
    // singleton reached `getRefusalLog` (invariant #15).
    sqlSentinel: new Proxy(() => {}, {
      apply: () => {
        const result = rows[calls.value] ?? [];
        calls.value += 1;
        return Promise.resolve(result);
      },
    }),
  };
});

// ── Mock auth: a PASS-THROUGH, so one case can use the real gate ──────

vi.mock('@/lib/db/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/auth')>();
  return {
    ...actual,
    requireRole: (...args: Parameters<typeof actual.requireRole>) => (
      useRequireRoleMock.value
        ? mockRequireRole(...args)
        : actual.requireRole(...args)
    ),
  };
});

// ── Mock the Supabase SSR client the real auth path reads ─────────────

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: () => mockGetAuthUser() } }),
}));

// ── Mock the db singleton ─────────────────────────────────────────────

vi.mock('@/lib/db/server', () => ({ sql: sqlSentinel }));

// ── Mock the read layer ───────────────────────────────────────────────

vi.mock('@/lib/refusals/read', () => ({
  getRefusalLog: (...args: unknown[]) => mockGetRefusalLog(...args),
}));

// ── Mock the location repo (`resolveDashboardLocation`'s only query) ──

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: (...args: unknown[]) => mockGetLocationById(...args),
}));

// Import AFTER the mocks are set up.
import { GET } from '../refusals/route';

// ── Fixtures ──────────────────────────────────────────────────────────

const ROUTE_PATH = 'src/app/api/dashboard/refusals/route.ts';

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const ADMIN_ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000009';
const LOCATION_ID = '01234567-0000-0000-0000-000000000001';
const FOREIGN_LOCATION_ID = '01234567-0000-0000-0000-000000000002';

/**
 * Moderation prose of the kind `flagged_responses.reason` stores, and one raw
 * lane code. Neither may leave the server (ADR 0023), so they are the sentinels
 * the three redaction cases hunt for.
 */
const FLAGGED_REASON = 'hate speech directed at a named staff member';
const RAW_CODE = 'moderation_flagged';
const CO_OCCURRING_CODE = 'daily_cap_reached';

function ownerUser(overrides?: { accountId?: string; locationId?: string | null }) {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides?.accountId ?? ACCOUNT_ID,
    locationId: overrides?.locationId === undefined ? LOCATION_ID : overrides.locationId,
  };
}

function ownedLocation(accountId = ACCOUNT_ID, id = LOCATION_ID) {
  return { id, account_id: accountId, archived_at: null };
}

/**
 * A realistic `RefusalLog` in the shape `getRefusalLog` actually returns. It
 * carries a `held_draft` entry — the lane whose source row is the one that has a
 * moderation reason at all — so the deep walk below runs over the entry an added
 * `reason` field would ride on.
 */
function refusalLogFixture(): RefusalLog {
  return {
    total: 2,
    entries: [
      {
        id: 'f0000000-0000-0000-0000-000000000001',
        category: 'unsafe_content',
        occurredAt: '2026-08-20T10:00:00.000Z',
        subjectType: 'response',
        subjectId: 'r0000000-0000-0000-0000-000000000001',
        linkKind: 'review',
      },
      {
        id: 'f0000000-0000-0000-0000-000000000002',
        category: 'autonomy_paused',
        occurredAt: '2026-08-18T10:00:00.000Z',
        subjectType: null,
        subjectId: null,
        linkKind: 'auto-approval',
      },
    ],
    windowStart: '2026-07-21T10:00:00.000Z',
    windowEnd: '2026-08-20T10:00:00.000Z',
    coverageStart: '2026-05-01T00:00:00.000Z',
    archivedLocations: { refusalCount: 0, locationCount: 0 },
    archivedPeriods: [],
  };
}

function makeRequest(
  url = 'http://localhost:3000/api/dashboard/refusals',
  init?: { impersonating?: boolean },
): NextRequest {
  const headers = new Headers();
  if (init?.impersonating) {
    headers.set('cookie', `${IMPERSONATION_COOKIE_NAME}=session-1.deadbeef`);
  }
  return new NextRequest(url, { headers });
}

// ── Log capture ───────────────────────────────────────────────────────
//
// `reportCaughtError` (the shared error boundary's sink) emits ONE JSON line per
// handled error through `createWorkerLogger`, which writes to `console.error`.
// Capturing the three console methods captures every line the request produces,
// whatever writes it.

const capturedLogArgs: unknown[][] = [];

/** Flattens captured args to text, unpacking Errors' own enumerable props (a postgres.js error's body lives there). */
function capturedLogText(): string {
  return capturedLogArgs
    .flat()
    .map((arg) => {
      if (arg instanceof Error) {
        return [arg.name, arg.message, arg.stack ?? '', JSON.stringify({ ...arg })].join(' ');
      }
      try {
        return typeof arg === 'string' ? arg : JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join('\n');
}

/** The structured records the logger actually emitted, parsed back. */
function capturedLogRecords(): Record<string, unknown>[] {
  return capturedLogArgs
    .flat()
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Deep-walk helpers (absence, at every depth) ───────────────────────

function walk(value: unknown, keys: string[], strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, strings);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walk(child, keys, strings);
    }
  }
}

function everyKeyAndString(value: unknown): { keys: string[]; strings: string[] } {
  const keys: string[] = [];
  const strings: string[] = [];
  walk(value, keys, strings);
  return { keys, strings };
}

/** The route's own source with every comment line removed — the structural cases read code, not prose. */
function routeCodeWithoutComments(): string {
  return readFileSync(join(process.cwd(), ROUTE_PATH), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== ''
        && !trimmed.startsWith('*')
        && !trimmed.startsWith('/*')
        && !trimmed.startsWith('//')
      );
    })
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLogArgs.length = 0;
  sqlRows.length = 0;
  sqlCallCount.value = 0;
  useRequireRoleMock.value = true;
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      capturedLogArgs.push(args);
    });
  }
  mockGetRefusalLog.mockResolvedValue(refusalLogFixture());
  mockGetLocationById.mockResolvedValue(ownedLocation());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/dashboard/refusals', () => {
  // ── The two scopes ──────────────────────────────────────────────────

  it('GET /api/dashboard/refusals returns the window and the log for an account scope', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireRole.mockResolvedValue(ownerUser());

    const response = await GET(
      makeRequest('http://localhost:3000/api/dashboard/refusals?scope=all'),
    );

    expect(response.status).toBe(200);
    // ONE call, account-scoped, with the exact `sql` singleton handed down
    // (invariant #15 — the composition root owns it and passes it).
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'account', accountId: ACCOUNT_ID },
      '30d',
    );
    expect(await response.json()).toEqual({
      window: '30d',
      autoApprovalEnabled: expect.any(Boolean),
      ...refusalLogFixture(),
    });

    // Orchestrate only (invariant #12): no query, no mapping, no re-shaping.
    const code = routeCodeWithoutComments();
    for (const forbidden of ['sql`', 'SELECT', 'JOIN', 'WHERE', '.map(', '.filter(', '.reduce(', '.sort(']) {
      expect(code, `route source contains ${forbidden}`).not.toContain(forbidden);
    }
    expect(code.match(/@\/lib\/refusals\/\w+/g)).toEqual(['@/lib/refusals/read']);

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('GET /api/dashboard/refusals returns the window and the log for a location scope', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireRole.mockResolvedValue(ownerUser());

    const response = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${LOCATION_ID}&window=7d`),
    );

    expect(response.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'location', accountId: ACCOUNT_ID, businessId: LOCATION_ID },
      '7d',
    );
    // The window the caller asked for is the window the body reports, so the tab
    // never prints a range the query did not use.
    expect((await response.json()).window).toBe('7d');

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  // ── Tenant boundary (invariant #8) ──────────────────────────────────

  it("GET /api/dashboard/refusals rejects a request for a location outside the caller's account", async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';
    mockRequireRole.mockResolvedValue(ownerUser());
    // The location EXISTS — it just belongs to somebody else.
    mockGetLocationById.mockResolvedValue(
      ownedLocation('a0000000-0000-0000-0000-000000000002', FOREIGN_LOCATION_ID),
    );

    const foreign = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${FOREIGN_LOCATION_ID}`),
    );

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Business not found' });
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    // UNIFORM: a location that genuinely does not exist is byte-identical, so
    // the response leaks no existence signal (`exposure: 'uniform-not-found'`).
    mockGetLocationById.mockResolvedValue(null);
    const absent = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${FOREIGN_LOCATION_ID}`),
    );
    expect(absent.status).toBe(foreign.status);
    expect(await absent.json()).toEqual({ error: 'Business not found' });
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('GET /api/dashboard/refusals exercises the impersonation path without mocking requireRole', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    // THE REAL GATE. `requireRole` → `requireAuth` → `getCurrentUser` all run;
    // only the Supabase client and the `users` row underneath them are supplied.
    useRequireRoleMock.value = false;
    mockGetAuthUser.mockResolvedValue({ data: { user: { id: 'auth-owner-1' } } });
    sqlRows.push([{
      id: 'user-1',
      name: 'Impersonated Owner',
      email: 'owner@test.com',
      role: 'owner',
      account_id: ACCOUNT_ID,
      primary_location_id: LOCATION_ID,
    }]);

    const response = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${LOCATION_ID}`, {
        impersonating: true,
      }),
    );

    expect(response.status).toBe(200);
    // The account came from the RESOLVED session, not from the cookie and not
    // from the admin. The gate really ran: it issued its own `users` lookup.
    expect(sqlCallCount.value).toBe(1);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'location', accountId: ACCOUNT_ID, businessId: LOCATION_ID },
      '30d',
    );
    expect(JSON.stringify(mockGetRefusalLog.mock.calls)).not.toContain(ADMIN_ACCOUNT_ID);

    // Non-vacuous in the other direction: with no session the same real gate
    // 401s and reads nothing.
    mockGetRefusalLog.mockClear();
    mockGetAuthUser.mockResolvedValue({ data: { user: null } });
    const unauthenticated = await GET(makeRequest());
    expect(unauthenticated.status).toBe(401);
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  // ── Redaction, once per sink (ADR 0023) ─────────────────────────────

  it('GET /api/dashboard/refusals omits all_refusal_codes from the body at any depth', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // The sentinels are planted in the REQUEST — the one place the route could
    // echo them from without the read layer's help. The read returns the real
    // shape, which carries no code axis at all.
    const response = await GET(makeRequest(
      'http://localhost:3000/api/dashboard/refusals'
      + `?reason=${encodeURIComponent(FLAGGED_REASON)}`
      + `&code=${RAW_CODE}&all=${CO_OCCURRING_CODE}`,
    ));

    expect(response.status).toBe(200);
    const raw = await response.text();
    const { keys, strings } = everyKeyAndString(JSON.parse(raw) as unknown);

    // Absence at every depth: no key names a code or a reason, no value carries
    // one, and the serialized bytes do not either.
    expect(keys.filter((key) => /reason|refusal_code|refusalCode|all_refusal_codes|allRefusalCodes|refusalSource/i.test(key)))
      .toEqual([]);
    expect(strings.filter((value) => value.includes(FLAGGED_REASON))).toEqual([]);
    for (const sentinel of [FLAGGED_REASON, RAW_CODE, CO_OCCURRING_CODE, 'all_refusal_codes', 'allRefusalCodes']) {
      expect(raw, `body contains ${sentinel}`).not.toContain(sentinel);
    }
    // Non-vacuous: the body really did carry the entries a leak would ride on.
    expect(strings).toContain('unsafe_content');
  });

  it('GET /api/dashboard/refusals omits all_refusal_codes and moderation prose from the error arm', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // A database error that echoes the offending row — message AND postgres.js
    // body. An implementation that mapped either into the response leaks.
    mockGetRefusalLog.mockRejectedValue(Object.assign(
      new Error(`invalid input for column reason: ${FLAGGED_REASON}`),
      {
        query: `SELECT all_refusal_codes FROM refusal_events WHERE refusal_code = '${RAW_CODE}'`,
        parameters: [FLAGGED_REASON, CO_OCCURRING_CODE],
        detail: FLAGGED_REASON,
      },
    ));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    const raw = await response.text();
    const { keys, strings } = everyKeyAndString(JSON.parse(raw) as unknown);

    expect(keys.filter((key) => /reason|code/i.test(key))).toEqual([]);
    expect(strings.filter((value) => value.includes(FLAGGED_REASON))).toEqual([]);
    for (const sentinel of [FLAGGED_REASON, RAW_CODE, CO_OCCURRING_CODE, 'all_refusal_codes']) {
      expect(raw, `error body contains ${sentinel}`).not.toContain(sentinel);
    }
    // The arm is the boundary's FIXED literal, not a mapped database body.
    expect(JSON.parse(raw)).toEqual({ error: 'Failed to fetch refusals' });
  });

  it('GET /api/dashboard/refusals omits all_refusal_codes and moderation prose from its logs', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // Arm 1 — the SUCCESS path. The route logs nothing at all, so the payload it
    // just served reaches no sink.
    await GET(makeRequest());
    expect(capturedLogArgs).toEqual([]);

    // Arm 2 — the ERROR path, with the sentinels on the postgres.js error BODY
    // (`query` / `parameters` / `detail`) and a clean message. That body is what
    // "never echo a DB error" means: the shared boundary serializes an error's
    // name and message only, so a route that logged the error OBJECT, its query,
    // or the payload would put the prose on disk.
    capturedLogArgs.length = 0;
    mockGetRefusalLog.mockRejectedValue(Object.assign(new Error('read failed'), {
      query: `SELECT all_refusal_codes FROM refusal_events WHERE refusal_code = '${RAW_CODE}'`,
      parameters: [FLAGGED_REASON, CO_OCCURRING_CODE],
      detail: FLAGGED_REASON,
    }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    const logged = capturedLogText();
    for (const sentinel of [FLAGGED_REASON, RAW_CODE, CO_OCCURRING_CODE, 'all_refusal_codes']) {
      expect(logged, `logs contain ${sentinel}`).not.toContain(sentinel);
    }
    // And the one line it did emit carries only the scope context — nothing from
    // the refusal payload or the failing statement.
    const records = capturedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toEqual({ accountId: ACCOUNT_ID });
    expect(records[0]?.logger).toBe('api/dashboard/refusals');
  });

  // ── The one server-read flag the payload carries (invariant #13) ─────

  it('GET /api/dashboard/refusals reports autoApprovalEnabled as a payload boolean', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const originalFlag = process.env.AUTO_APPROVAL_ENABLED;

    process.env.AUTO_APPROVAL_ENABLED = 'true';
    const enabled = await (await GET(makeRequest())).json();
    expect(enabled.autoApprovalEnabled).toBe(true);

    process.env.AUTO_APPROVAL_ENABLED = 'false';
    const disabled = await (await GET(makeRequest())).json();
    expect(disabled.autoApprovalEnabled).toBe(false);

    // A BOOLEAN, not a string: the tab branches on it, and `'false'` is truthy.
    expect(typeof disabled.autoApprovalEnabled).toBe('boolean');

    // Invariant #13 — the browser learns flag state from this response and never
    // from a `NEXT_PUBLIC_*` companion.
    expect(routeCodeWithoutComments()).not.toContain('NEXT_PUBLIC_');

    process.env.AUTO_APPROVAL_ENABLED = originalFlag;
  });

  // ── Subscription guard (invariant #11) ──────────────────────────────

  it('GET /api/dashboard/refusals serves an owner whose subscription is past_due', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const response = await GET(makeRequest());

    // READS stay available to a past-due account; only mutations are gated. The
    // route reaches auth through `withDashboardOwnerRead`, whose owner gate is
    // `requireOwnerWithAccount` — which deliberately does NOT check the
    // writable-subscription gate.
    expect(response.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);

    // The structural half, because the risk is a later edit swapping the gate:
    // this route must name no writable or subscription gate of its own.
    const code = routeCodeWithoutComments();
    expect(code).toContain('withDashboardOwnerRead');
    for (const forbidden of ['requireWritableOwner', 'assertWritableSubscription', 'subscriptionGrantsFullAccess', 'subscription_status']) {
      expect(code, `route source contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});
