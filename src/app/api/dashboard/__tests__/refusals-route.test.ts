// The Refusal Log eval — route half (T5 turns T0's `.todo`s green).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// Mocking level is `./scope-route.test.ts`'s: the auth PRIMITIVE (`@/lib/db/auth`),
// `@/lib/db/server`, the location repo and `@/lib/refusals/read` — never the
// dashboard policy helpers. ESM internal calls do not go through a mocked
// export, so a stub on a composed helper (`resolveDashboardLocation`) would stop
// intercepting the moment `withDashboardOwnerRead` called a sibling in that
// module, and the scoping cases below would prove nothing.
//
// THREE OF THESE ARE REDACTION CASES, not shape cases. S1 reads
// `flagged_responses` — deny-all RLS, reached through the RLS-bypassing
// `postgres` role — so application redaction is the whole security story (plan
// §7 risk 1). Each of the three plants `FLAGGED_REASON` somewhere the route
// could plausibly pick it up (the request URL, a thrown error's message, a
// postgres.js error's `query`/`parameters`/`detail` body) and then asserts its
// ABSENCE from the serialized response walked at EVERY depth and from every
// captured log line. "A label looks right" is a different claim and is not
// made here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import type { RefusalLog } from '@/lib/refusals/read';

// ── Hoisted shared state ──────────────────────────────────────────────

const { mockRequireRole, mockGetRefusalLog, mockGetLocationById, sqlSentinel } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetRefusalLog: vi.fn(),
  mockGetLocationById: vi.fn(),
  // The route hands this straight down to `getRefusalLog` and
  // `resolveDashboardLocation`; both are mocked, so it is never invoked. Its
  // identity is the assertion: invariant #15 says the composition root owns the
  // singleton and passes it, so we check the exact object arrives.
  sqlSentinel: { __sql: 'db/server singleton' },
}));

// ── Mock auth ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

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
 * Moderation prose of the kind `flagged_responses.reason` stores. It may never
 * leave the server (intake invariant 4), so it is the sentinel the three
 * redaction cases hunt for.
 */
const FLAGGED_REASON = 'hate speech directed at a named staff member';

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
 * A realistic `RefusalLog` — including a `held_draft` entry, the ONLY lane whose
 * source row carries a reason at all. The deep walk below runs over this, so an
 * entry field named `reason` added later turns the redaction case red here as
 * well as in the read layer.
 */
function refusalLogFixture(): RefusalLog {
  return {
    total: 3,
    categories: [
      {
        category: 'unsafe_content',
        count: 2,
        entries: [
          {
            id: 'f0000000-0000-0000-0000-000000000001',
            source: 'held_draft',
            category: 'unsafe_content',
            occurredAt: '2026-08-20T10:00:00.000Z',
            reviewId: 'r0000000-0000-0000-0000-000000000001',
          },
          {
            id: 'f0000000-0000-0000-0000-000000000002',
            source: 'outreach_withheld',
            category: 'unsafe_content',
            occurredAt: '2026-08-19T10:00:00.000Z',
            reviewId: null,
          },
        ],
      },
      {
        category: 'autonomy_paused',
        count: 1,
        entries: [
          {
            id: 'f0000000-0000-0000-0000-000000000003',
            source: 'autonomy_suspended',
            category: 'autonomy_paused',
            occurredAt: '2026-08-18T10:00:00.000Z',
            reviewId: null,
          },
        ],
      },
    ],
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
// `reportCaughtError` (the shared error boundary's sink) emits ONE JSON line
// per handled error through `createWorkerLogger`, which writes to
// `console.error`. Capturing the three console methods captures every line the
// request produces, whatever writes it.

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
        trimmed !== '' &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('//')
      );
    })
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLogArgs.length = 0;
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

// ── Redaction ─────────────────────────────────────────────────────────

describe('GET /api/dashboard/refusals redaction', () => {
  it('the refusals route serializes no flagged reason at any depth', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // The sentinel is planted in the REQUEST, the one place a route could echo
    // it from without the read layer's help. The read returns the real shape.
    const res = await GET(
      makeRequest(
        `http://localhost:3000/api/dashboard/refusals?window=30d&reason=${encodeURIComponent(FLAGGED_REASON)}`,
      ),
    );
    expect(res.status).toBe(200);

    const raw = await res.text();
    const body: unknown = JSON.parse(raw);
    const { keys, strings } = everyKeyAndString(body);

    // Absence, at every depth: no key names a reason, no value carries the
    // prose, and the serialized bytes do not contain it either.
    expect(keys.filter((key) => /reason/i.test(key))).toEqual([]);
    expect(strings.filter((value) => value.includes(FLAGGED_REASON))).toEqual([]);
    expect(raw).not.toContain(FLAGGED_REASON);

    // Non-vacuous: the body really did carry the held-draft entry the sentinel
    // would have ridden on.
    expect(strings).toContain('held_draft');
  });

  it('the refusals route returns no flagged reason on an error path', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // A database error that echoes the offending row — message AND postgres.js
    // body. An implementation that mapped either into the response leaks.
    const dbError = Object.assign(
      new Error(`invalid input for column reason: ${FLAGGED_REASON}`),
      {
        query: `SELECT reason FROM flagged_responses WHERE reason = '${FLAGGED_REASON}'`,
        parameters: [FLAGGED_REASON],
        detail: FLAGGED_REASON,
      },
    );
    mockGetRefusalLog.mockRejectedValue(dbError);

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    const raw = await res.text();
    const body: unknown = JSON.parse(raw);
    const { keys, strings } = everyKeyAndString(body);

    expect(keys.filter((key) => /reason/i.test(key))).toEqual([]);
    expect(strings.filter((value) => value.includes(FLAGGED_REASON))).toEqual([]);
    expect(raw).not.toContain(FLAGGED_REASON);
    // The error arm is the boundary's fixed literal, not a mapped DB body.
    expect(body).toEqual({ error: 'Failed to fetch refusals' });
  });

  it('the refusals route logs no flagged reason', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    // Arm 1 — the success path. The route logs nothing at all, so the payload
    // it just served reaches no sink.
    await GET(makeRequest());
    expect(capturedLogText()).not.toContain(FLAGGED_REASON);
    expect(capturedLogArgs).toEqual([]);

    // Arm 2 — the error path, with the reason on the postgres.js error BODY
    // (`query` / `parameters` / `detail`) and a clean message. That body is
    // what "never echo a DB error" means: the shared boundary serializes an
    // error's name and message only, so a route that logged the error OBJECT,
    // its query, or the payload would put the prose on disk. The message is
    // deliberately clean — it is the one field the boundary does serialize, and
    // this route does not own that behaviour (deviations D14).
    capturedLogArgs.length = 0;
    mockGetRefusalLog.mockRejectedValue(
      Object.assign(new Error('read failed'), {
        query: `SELECT reason FROM flagged_responses`,
        parameters: [FLAGGED_REASON],
        detail: FLAGGED_REASON,
      }),
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(500);

    expect(capturedLogText()).not.toContain(FLAGGED_REASON);

    // And the one line it did emit carries only the scope context — nothing
    // from the refusal payload or the failing statement.
    const records = capturedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toEqual({ accountId: ACCOUNT_ID });
    expect(records[0]?.logger).toBe('api/dashboard/refusals');
  });
});

// ── Orchestration, auth and scope ─────────────────────────────────────

describe('GET /api/dashboard/refusals', () => {
  // Invariant #12: parse input, call one module function, return output.
  it('the refusals route resolves scope, calls getRefusalLog once, and contains no source query logic', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());

    // Aggregate branch — one call, account scope, the singleton handed down.
    const aggregate = await GET(
      makeRequest('http://localhost:3000/api/dashboard/refusals?scope=all'),
    );
    expect(aggregate.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'account', accountId: ACCOUNT_ID },
      '30d',
    );
    expect(await aggregate.json()).toEqual({ window: '30d', ...refusalLogFixture() });

    // Location branch — still exactly one call, now location-scoped.
    mockGetRefusalLog.mockClear();
    const scoped = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${LOCATION_ID}`),
    );
    expect(scoped.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'location', accountId: ACCOUNT_ID, businessId: LOCATION_ID },
      '30d',
    );

    // …and no source query logic: no tagged SQL template, no SQL verbs, no
    // category mapping, no re-shaping of what the read returned.
    const code = routeCodeWithoutComments();
    for (const forbidden of ['sql`', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UNION', 'JOIN', 'WHERE']) {
      expect(code, `route source contains ${forbidden}`).not.toContain(forbidden);
    }
    for (const forbidden of [
      'refusalCategoryFor',
      'REFUSAL_CATEGORIES',
      '@/lib/refusals/vocabulary',
      // Re-shaping what the read returned is the leak vector a mutation probe
      // found slipping past the SQL scan: the body is `{ window, ...log }` and
      // nothing else.
      '.map(',
      '.filter(',
      '.reduce(',
      '.sort(',
    ]) {
      expect(code, `route source contains ${forbidden}`).not.toContain(forbidden);
    }
    // The refusals domain reaches this file through exactly one symbol.
    expect(code.match(/@\/lib\/refusals\/\w+/g)).toEqual(['@/lib/refusals/read']);

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('the refusals route rejects an unauthenticated caller', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });

    // Nothing is read for a caller we could not authenticate.
    expect(mockGetRefusalLog).not.toHaveBeenCalled();
    expect(mockGetLocationById).not.toHaveBeenCalled();
  });

  // `resolveDashboardLocation` with `exposure: 'uniform-not-found'` — a location
  // the caller does not own is indistinguishable from one that does not exist.
  it('the refusals route returns the uniform not-found response for a location the caller does not own', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    mockRequireRole.mockResolvedValue(ownerUser());
    // The location exists — it just belongs to somebody else (invariant #8).
    mockGetLocationById.mockResolvedValue(
      ownedLocation('a0000000-0000-0000-0000-000000000002', FOREIGN_LOCATION_ID),
    );

    const foreign = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${FOREIGN_LOCATION_ID}`),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Business not found' });
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    // Uniform: a location that genuinely does not exist is byte-identical, so
    // the response leaks no existence signal.
    mockGetLocationById.mockResolvedValue(null);
    const absent = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${FOREIGN_LOCATION_ID}`),
    );
    expect(absent.status).toBe(foreign.status);
    expect(await absent.json()).toEqual({ error: 'Business not found' });
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });

  it('the refusals route clamps an invalid window to the default', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await GET(
      makeRequest('http://localhost:3000/api/dashboard/refusals?window=9000d'),
    );
    expect(res.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(sqlSentinel, expect.anything(), '30d');
    expect((await res.json()).window).toBe('30d');

    // Non-vacuous: an allowlisted window is honoured, so the clamp is a clamp
    // and not the route ignoring `?window=` altogether.
    mockGetRefusalLog.mockClear();
    const valid = await GET(
      makeRequest('http://localhost:3000/api/dashboard/refusals?window=7d'),
    );
    expect(mockGetRefusalLog).toHaveBeenCalledWith(sqlSentinel, expect.anything(), '7d');
    expect((await valid.json()).window).toBe('7d');
  });

  it('the refusals route reads only the impersonated account', async () => {
    const originalEnv = process.env.MULTI_LOCATION_ENABLED;
    process.env.MULTI_LOCATION_ENABLED = 'true';

    // Under impersonation the admin's session resolves to the IMPERSONATED
    // owner (the cookie gates mutations only — see the auto-approval route).
    // The route must take its account from that resolved owner and nowhere
    // else: it never reads the cookie, and never widens to the admin's account.
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${LOCATION_ID}`, {
        impersonating: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockGetRefusalLog).toHaveBeenCalledTimes(1);
    expect(mockGetRefusalLog).toHaveBeenCalledWith(
      sqlSentinel,
      { kind: 'location', accountId: ACCOUNT_ID, businessId: LOCATION_ID },
      '30d',
    );
    expect(JSON.stringify(mockGetRefusalLog.mock.calls)).not.toContain(ADMIN_ACCOUNT_ID);

    // The admin's OWN location is a foreign location to this session, and gets
    // the same uniform 404 as any other tenant's.
    mockGetRefusalLog.mockClear();
    mockGetLocationById.mockResolvedValue(
      ownedLocation(ADMIN_ACCOUNT_ID, FOREIGN_LOCATION_ID),
    );
    const crossTenant = await GET(
      makeRequest(`http://localhost:3000/api/dashboard/refusals?scope=${FOREIGN_LOCATION_ID}`, {
        impersonating: true,
      }),
    );
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: 'Business not found' });
    expect(mockGetRefusalLog).not.toHaveBeenCalled();

    process.env.MULTI_LOCATION_ENABLED = originalEnv;
  });
});
