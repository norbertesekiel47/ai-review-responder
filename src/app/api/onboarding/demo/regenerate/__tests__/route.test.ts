// `POST /api/onboarding/demo/regenerate` — route eval (#1078 B, T2).
//
// Titles below are VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// MOCKING LEVEL is the sibling route's (`../../status/__tests__/route.test.ts`)
// and the house level named in the intake
// (`src/app/api/dashboard/__tests__/refusals-route.test.ts`): the auth primitive
// (`@supabase/ssr`, which is what this route reaches auth through — it predates
// `@/lib/db/auth`), `@/lib/db/server`, and the two REDIS seams
// (`@/lib/shared/rate-limit`, the cost guard's reservation). No domain helper is
// stubbed, and `assertSameOrigin` runs for real against a real Origin header
// rather than being mocked away.
//
// The lookup cases read the STATUS SET off the query PARAMETER, not off the
// query text. That is the whole reason the route spells the predicate
// `= ANY(${…}::text[])` over a local const: a status baked into the template as
// a literal can only be asserted by string-matching the SQL, which passes just
// as happily for `'completed'` alone as for `'completed','failed'`. As a
// parameter, the accepted set is a VALUE — so "running is not in it" is a real
// assertion instead of a hopeful `not.toContain`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ──────────────────────────────────────────────

const {
  mockSql,
  mockBegin,
  mockTx,
  mockGetUser,
  mockCheckRateLimit,
  mockReserve,
  mockRelease,
} = vi.hoisted(() => {
  const tx = vi.fn(() => Promise.resolve([] as unknown[]));
  const begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
  const sql = vi.fn(() => Promise.resolve([] as unknown[]));
  Object.assign(sql, { begin });
  return {
    mockSql: sql,
    mockBegin: begin,
    mockTx: tx,
    mockGetUser: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockReserve: vi.fn(),
    mockRelease: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  // The real helper is `sql.json(value)`; the route only needs the payload to
  // survive into the `job_outbox` INSERT, and wrapping it keeps the boundary
  // visible in the recorded parameters.
  jsonb: (value: unknown) => ({ jsonb: value }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/costs/onboarding-demo-cost-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/costs/onboarding-demo-cost-guard')>();
  // `CostCeilingExceeded` stays the REAL class, so the route's `instanceof` arm
  // is not tested against a look-alike.
  return { ...actual, reserveOnboardingDemoBudget: mockReserve };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.ONBOARDING_DEMO_ENABLED = 'true';

// Import AFTER the mocks are set up.
import { POST } from '../route';

// ── Fixtures ──────────────────────────────────────────────────────────

const AUTH_USER = { id: 'auth-uuid-123', email: 'owner@example.com' };
const USER_ID = '11111111-1111-1111-1111-111111111111';
const BUSINESS_ID = '22222222-2222-2222-2222-222222222222';
const FAILED_DEMO_ID = '33333333-3333-3333-3333-333333333333';

function mkReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/demo/regenerate', {
    method: 'POST',
    headers: { origin: 'https://app.example.com' },
  });
}

function ownerRow() {
  return {
    id: BUSINESS_ID,
    user_id: USER_ID,
    // Regenerate is a pre-pay affordance; anything else 409s before the lookup.
    subscription_status: 'pending_payment',
  };
}

function failedDemoRow() {
  return {
    id: FAILED_DEMO_ID,
    business_name: 'Bella Pizzeria',
    category: 'restaurant',
    google_place_id: 'ChIJplace',
    google_maps_url: 'https://maps.google.com/?cid=1',
  };
}

/** The SQL text of one recorded tagged-template call, values elided as `?`. */
function queryText(call: unknown[] | undefined): string {
  return (call?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
}

/** The interpolated values of one recorded tagged-template call. */
function queryValues(call: unknown[] | undefined): unknown[] {
  return call ? call.slice(1) : [];
}

/** The 2nd top-level statement: the eligible-demo lookup. */
function demoLookupCall(): unknown[] | undefined {
  return mockSql.mock.calls[1] as unknown[] | undefined;
}

/**
 * The accepted-status array the lookup passed as a parameter. Found by VALUE
 * shape rather than by position, so re-ordering the predicate's parameters does
 * not silently turn these assertions vacuous.
 */
function acceptedStatuses(): string[] | undefined {
  return queryValues(demoLookupCall()).find(
    (value): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ONBOARDING_DEMO_ENABLED = 'true';
  mockGetUser.mockResolvedValue({ data: { user: AUTH_USER }, error: null });
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 2 });
  mockReserve.mockResolvedValue({ release: mockRelease, date: '2026-09-02' });
  mockRelease.mockResolvedValue(undefined);
  mockSql.mockResolvedValue([]);
  mockTx.mockResolvedValue([]);
});

describe('POST /api/onboarding/demo/regenerate', () => {
  it('the regenerate route selects a demo whose generation_status is completed or failed', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([failedDemoRow()]);

    const res = await POST(mkReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/onboarding/demo', demoQueued: true });

    // The predicate is a parameterised set, not a baked literal.
    const text = queryText(demoLookupCall());
    expect(text).toContain('FROM onboarding_demos');
    expect(text).toContain('generation_status = ANY(?::text[])');
    expect(text).not.toContain("generation_status = 'completed'");

    // BOTH statuses are accepted, and only those two.
    expect(acceptedStatuses()).toEqual(['completed', 'failed']);

    // Owner scoping (invariant #8) survives the widened predicate.
    expect(text).toContain('user_id = ?::uuid');
    expect(text).toContain('business_id = ?::uuid');
    expect(queryValues(demoLookupCall())).toContain(USER_ID);
    expect(queryValues(demoLookupCall())).toContain(BUSINESS_ID);

    // Still the most recent of the eligible set — a newer failure beats an
    // older success.
    expect(text).toContain('ORDER BY created_at DESC');
    expect(text).toContain('LIMIT 1');
  });

  it('the regenerate route returns no_demo_to_regenerate when the owner has no completed or failed demo', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([]); // no eligible demo

    const res = await POST(mkReq());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_demo_to_regenerate' });

    // The reservation taken a moment earlier is released, not leaked, and
    // nothing is written.
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('the regenerate route does not select a demo whose generation_status is running, queued or archived', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([failedDemoRow()]);

    await POST(mkReq());

    // A retry must not race a worker that is still generating, and an archived
    // demo is already superseded. These three are absent from the accepted set
    // as a VALUE — not merely absent from the SQL text.
    const statuses = acceptedStatuses();
    expect(statuses).toBeDefined();
    for (const ineligible of ['running', 'queued', 'archived']) {
      expect(statuses, `${ineligible} is regenerable`).not.toContain(ineligible);
    }
    // Non-vacuous in the other direction.
    expect(statuses).toContain('failed');
  });

  it('the regenerate route archives the selected failed demo and inserts its replacement in one transaction', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([failedDemoRow()]);

    const res = await POST(mkReq());

    expect(res.status).toBe(200);

    // ONE transaction (invariant #2), and every write inside it. The two
    // top-level statements are the owner resolve and the demo lookup — both
    // reads.
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockTx).toHaveBeenCalledTimes(3);

    const [archive, insertDemo, insertOutbox] = mockTx.mock.calls as unknown[][];

    // 1 — the FAILED demo is archived, still owner-scoped.
    expect(queryText(archive)).toContain('UPDATE onboarding_demos');
    expect(queryText(archive)).toContain("generation_status = 'archived'");
    expect(queryValues(archive)).toContain(FAILED_DEMO_ID);
    expect(queryValues(archive)).toContain(USER_ID);
    expect(queryValues(archive)).toContain(BUSINESS_ID);

    // 2 — its replacement is inserted queued, carrying the same business facts.
    expect(queryText(insertDemo)).toContain('INSERT INTO onboarding_demos');
    expect(queryText(insertDemo)).toContain("'queued'");
    expect(queryValues(insertDemo)).toContain('Bella Pizzeria');

    // 3 — the follow-up work rides the SAME transaction as the state change.
    expect(queryText(insertOutbox)).toContain('INSERT INTO job_outbox');
    expect(queryText(insertOutbox)).toContain("'pending'");

    // The reservation is NOT released on the success path — the worker
    // finalizes it.
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
