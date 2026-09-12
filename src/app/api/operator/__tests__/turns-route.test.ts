import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockCreateTurn } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockWritable: vi.fn(),
  mockCreateTurn: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...a: unknown[]) => mockRequireRole(...a), AuthError };
});
vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...a: unknown[]) => mockSqlQuery(...a), {
    begin: (...a: unknown[]) => mockSqlBegin(...a),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));
vi.mock('@/lib/agents/operator/turns', () => ({ createTurn: (...a: unknown[]) => mockCreateTurn(...a) }));

import { POST } from '../turns/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const CONVERSATION = '00000000-0000-7000-8000-00000000c001';
const TURN = '00000000-0000-7000-8000-000000000011';
const KEY = '00000000-0000-7000-8000-000000009001';
const ORIGIN = 'https://app.repworth.test';

const BODY = { conversationId: CONVERSATION, clientTurnKey: KEY, locationId: LOCATION, text: 'Make my replies warmer.' };

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/turns`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/operator/turns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // withSameOrigin() compares the Origin header against NEXT_PUBLIC_APP_URL,
    // which vitest.setup.ts defaults to http://localhost:3000 — without this
    // every request built above would 403 on the app URL rather than on the
    // case under test.
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockCreateTurn.mockResolvedValue({ kind: 'created', conversationId: CONVERSATION, turnId: TURN });
  });

  it('POST turns inserts the conversation, the accepted turn, and the outbox row in one transaction and returns the ids', async () => {
    const response = await POST(request(BODY));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversationId: CONVERSATION, turnId: TURN });
    expect(mockCreateTurn).toHaveBeenCalledTimes(1);
    expect(mockCreateTurn.mock.calls[0]![1]).toMatchObject({
      accountId: ACCOUNT,
      actorUserId: 'user-1',
      conversationId: CONVERSATION,
      clientTurnKey: KEY,
      locationId: LOCATION,
      text: 'Make my replies warmer.',
    });
    // VERBATIM: the route passes the raw body through, with no trim, so
    // `owner_text` can be compared byte-for-byte on a replay. The live proof
    // that the stored column equals this string is T7's turns suite.
    const trailing = { ...BODY, text: 'Make my replies warmer.   ' };
    await POST(request(trailing));
    expect(mockCreateTurn.mock.calls[1]![1]).toMatchObject({ text: 'Make my replies warmer.   ' });
    // A whitespace-only message is still a 400, and never reaches the module.
    mockCreateTurn.mockClear();
    expect((await POST(request({ ...BODY, text: '   \n\t ' }))).status).toBe(400);
    expect(mockCreateTurn).not.toHaveBeenCalled();
    // The route orchestrates only: one module call, no SQL of its own. The
    // transaction and its statement ORDER (conversation lock BEFORE the turn-key
    // read — see createTurn's header) are proven live in T7's turns suite, not
    // through a mocked tx here.
    expect(mockSqlQuery).not.toHaveBeenCalled();
    expect(mockSqlBegin).not.toHaveBeenCalled();
  });

  it('POST turns returns the existing ids for a repeated clientTurnKey with the same payload and 409 for a different payload', async () => {
    mockCreateTurn.mockResolvedValue({ kind: 'existing', conversationId: CONVERSATION, turnId: TURN });
    const repeat = await POST(request(BODY));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ conversationId: CONVERSATION, turnId: TURN });

    mockCreateTurn.mockResolvedValue({ kind: 'turn_key_conflict' });
    const conflict = await POST(request({ ...BODY, text: 'Something else entirely.' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'turn_key_conflict' });

    // Differing ONLY by trailing whitespace is a different payload, not a
    // replay: no `.trim()` runs anywhere on the path, so the module sees the
    // raw string and answers 409. Asserting the bound value here is what makes
    // a re-introduced trim fail this test rather than pass it silently.
    mockCreateTurn.mockClear();
    mockCreateTurn.mockResolvedValue({ kind: 'turn_key_conflict' });
    const whitespaceOnly = await POST(request({ ...BODY, text: `${BODY.text} ` }));
    expect(whitespaceOnly.status).toBe(409);
    expect(mockCreateTurn.mock.calls[0]![1]).toMatchObject({ text: `${BODY.text} ` });
  });

  it('POST turns rejects a missing or mismatched Origin before any write', async () => {
    const mismatched = await POST(new NextRequest(`${ORIGIN}/api/operator/turns`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', host: 'app.repworth.test', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    }));
    expect(mismatched.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockCreateTurn).not.toHaveBeenCalled();

    // The MISSING half of the title: no Origin header at all is the same 403,
    // and still never reaches auth or the module.
    const missing = await POST(new NextRequest(`${ORIGIN}/api/operator/turns`, {
      method: 'POST',
      headers: { host: 'app.repworth.test', 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    }));
    expect(missing.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockCreateTurn).not.toHaveBeenCalled();
  });

  it('POST turns returns 404 operator_disabled before any write when OWNER_OPERATOR_ENABLED is off', async () => {
    for (const value of [undefined, 'false']) {
      if (value === undefined) delete process.env.OWNER_OPERATOR_ENABLED;
      else process.env.OWNER_OPERATOR_ENABLED = value;
      const response = await POST(request(BODY));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'operator_disabled' });
    }
    expect(mockCreateTurn).not.toHaveBeenCalled();
    // The flag gate runs BEFORE auth, so nothing about the caller was resolved.
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('POST turns rejects a location that is archived or belongs to another account and a conversation owned by another account', async () => {
    mockCreateTurn.mockResolvedValue({ kind: 'location_not_found' });
    const badLocation = await POST(request(BODY));
    expect(badLocation.status).toBe(404);
    expect(await badLocation.json()).toEqual({ error: 'location_not_found' });

    mockCreateTurn.mockResolvedValue({ kind: 'conversation_not_found' });
    const badConversation = await POST(request(BODY));
    expect(badConversation.status).toBe(404);
    expect(await badConversation.json()).toEqual({ error: 'conversation_not_found' });

    // Shape failures never reach the module.
    mockCreateTurn.mockClear();
    expect((await POST(request({ ...BODY, text: '   ' }))).status).toBe(400);
    expect((await POST(request({ ...BODY, locationId: 'not-a-uuid' }))).status).toBe(400);
    expect(mockCreateTurn).not.toHaveBeenCalled();
  });
});
