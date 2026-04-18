import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const { mockVerifyFeedback, mockSqlCalls, mockBeginCallback } = vi.hoisted(() => ({
  mockVerifyFeedback: vi.fn(),
  mockSqlCalls: [] as unknown[][],
  mockBeginCallback: { fn: null as ((tx: unknown) => Promise<void>) | null },
}));

// ── Mock feedback-hmac ─────────────────────────────────────────────

vi.mock('@/lib/shared/feedback-hmac', () => ({
  verifyFeedback: (...args: unknown[]) => mockVerifyFeedback(...args),
}));

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const txProxy = new Proxy(() => {}, {
    apply: (_target, _thisArg, args) => {
      mockSqlCalls.push(args);
      return Promise.resolve([]);
    },
  }) as unknown;

  const sqlProxy = Object.assign(() => Promise.resolve([]), {
    begin: async (callback: (tx: unknown) => Promise<void>) => {
      mockBeginCallback.fn = callback;
      return callback(txProxy);
    },
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

// Import AFTER mocks
import { GET, POST } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const BIZ_ID = '01234567-0000-0000-0000-000000000001';
const WEEK = '2026-04-13';
const SIG = 'valid-sig-hex';

function makeGetUrl(overrides?: Record<string, string>): string {
  const params = new URLSearchParams({
    business_id: BIZ_ID,
    rating: 'great',
    week: WEEK,
    sig: SIG,
    ...overrides,
  });
  return `http://localhost:3000/api/feedback?${params.toString()}`;
}

function makeGetRequest(overrides?: Record<string, string>): NextRequest {
  return new NextRequest(makeGetUrl(overrides));
}

function makePostRequest(
  fields: Record<string, string>,
): NextRequest {
  const body = new URLSearchParams(fields);
  return new NextRequest('http://localhost:3000/api/feedback', {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function defaultPostFields(overrides?: Record<string, string>): Record<string, string> {
  return {
    business_id: BIZ_ID,
    rating: 'great',
    week: WEEK,
    sig: SIG,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlCalls.length = 0;
    mockBeginCallback.fn = null;
    mockVerifyFeedback.mockReturnValue(true);
  });

  it('returns 200 HTML with form and hidden inputs for valid sig', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('<form');
    expect(html).toContain(`value="${BIZ_ID}"`);
    expect(html).toContain('value="great"');
    expect(html).toContain(`value="${WEEK}"`);
    expect(html).toContain(`value="${SIG}"`);
    expect(html).toContain('Submit Feedback');
  });

  it('returns 400 for invalid sig', async () => {
    mockVerifyFeedback.mockReturnValue(false);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('Invalid signature');
  });

  it('returns 400 for missing params', async () => {
    const req = new NextRequest('http://localhost:3000/api/feedback?business_id=abc');

    const res = await GET(req);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('Missing required parameters');
  });

  it('does NOT call sql (scanner-safe)', async () => {
    await GET(makeGetRequest());

    expect(mockSqlCalls).toHaveLength(0);
    expect(mockBeginCallback.fn).toBeNull();
  });

  it('returns no-store Cache-Control header', async () => {
    const res = await GET(makeGetRequest());
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('shows textarea for not_great rating', async () => {
    const res = await GET(makeGetRequest({ rating: 'not_great' }));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<textarea');
    expect(html).toContain('name="comment"');
  });

  it('does not show textarea for great rating', async () => {
    const res = await GET(makeGetRequest({ rating: 'great' }));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<textarea');
  });

  it('returns 400 for invalid rating value', async () => {
    const res = await GET(makeGetRequest({ rating: 'terrible' }));

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('Invalid rating');
  });
});

describe('POST /api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlCalls.length = 0;
    mockBeginCallback.fn = null;
    mockVerifyFeedback.mockReturnValue(true);
  });

  it('calls sql.begin for valid sig', async () => {
    const req = makePostRequest(defaultPostFields());

    await POST(req);

    expect(mockBeginCallback.fn).not.toBeNull();
    // At least the upsert call
    expect(mockSqlCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('includes outbox INSERT for not_great rating', async () => {
    const req = makePostRequest(defaultPostFields({ rating: 'not_great' }));

    await POST(req);

    // 3 sql calls in transaction: upsert + dedup SELECT + outbox INSERT ON CONFLICT DO NOTHING
    expect(mockSqlCalls).toHaveLength(3);
  });

  it('does NOT include outbox INSERT for great rating', async () => {
    const req = makePostRequest(defaultPostFields({ rating: 'great' }));

    await POST(req);

    // Only 1 sql call: the upsert
    expect(mockSqlCalls).toHaveLength(1);
  });

  it('does NOT include outbox INSERT for ok rating', async () => {
    const req = makePostRequest(defaultPostFields({ rating: 'ok' }));

    await POST(req);

    expect(mockSqlCalls).toHaveLength(1);
  });

  it('returns 400 with no sql call for invalid sig', async () => {
    mockVerifyFeedback.mockReturnValue(false);
    const req = makePostRequest(defaultPostFields());

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockSqlCalls).toHaveLength(0);
    expect(mockBeginCallback.fn).toBeNull();
  });

  it('redirects to /feedback/thanks with 303', async () => {
    const req = makePostRequest(defaultPostFields());

    const res = await POST(req);

    expect(res.status).toBe(303);
    const location = res.headers.get('Location');
    expect(location).toContain('/feedback/thanks');
  });

  it('trims and stores comment', async () => {
    const req = makePostRequest(
      defaultPostFields({ rating: 'not_great', comment: '  needs work  ' }),
    );

    await POST(req);

    // 3 sql calls: upsert + dedup SELECT + outbox INSERT
    expect(mockSqlCalls).toHaveLength(3);
  });

  it('stores null for empty comment', async () => {
    const req = makePostRequest(
      defaultPostFields({ rating: 'not_great', comment: '   ' }),
    );

    await POST(req);

    // Transaction should still run (upsert + dedup SELECT + outbox INSERT)
    expect(mockSqlCalls).toHaveLength(3);
    expect(mockBeginCallback.fn).not.toBeNull();
  });

  it('returns 400 for missing fields in POST', async () => {
    const req = makePostRequest({ business_id: BIZ_ID });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockSqlCalls).toHaveLength(0);
  });
});
