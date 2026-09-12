import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockUpdateVoiceConfig } =
  vi.hoisted(() => {
    const tx = (...args: unknown[]) => {
      const [first] = args;
      if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) return Promise.resolve([]);
      return { __helper: first };
    };
    return {
      mockRequireRole: vi.fn(),
      mockSqlQuery: vi.fn(),
      mockSqlBegin: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      mockWritable: vi.fn(),
      mockUpdateVoiceConfig: vi.fn(),
    };
  });

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
    begin: (...a: unknown[]) => mockSqlBegin(...(a as Parameters<typeof mockSqlBegin>)),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));
vi.mock('@/lib/responses/voice-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/responses/voice-settings')>()),
  updateVoiceConfig: (...a: unknown[]) => mockUpdateVoiceConfig(...a),
}));

// The suite lives in src/app/api/settings/__tests__/, so the route is one
// level up and then into voice/ — the sibling suite's own relative shape.
import { GET, PUT } from '../voice/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const ORIGIN = 'https://app.repworth.test';

function putRequest(body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/settings/voice`, {
    method: 'PUT',
    headers: { origin: ORIGIN, host: 'app.repworth.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // withSameOrigin() compares the Origin header against NEXT_PUBLIC_APP_URL;
    // point it at this suite's ORIGIN the way the sibling settings suite does.
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockUpdateVoiceConfig.mockResolvedValue({ ok: true, updatedAt: '2026-09-11T10:00:00.000Z' });
  });

  it('voice route accepts and returns highlightFacts through the shared writer', async () => {
    const response = await PUT(putRequest({
      locationId: LOCATION,
      highlightFacts: ['award-winning espresso'],
    }));
    expect(response.status).toBe(200);
    expect(mockSqlBegin).toHaveBeenCalledTimes(1);
    expect(mockUpdateVoiceConfig).toHaveBeenCalledTimes(1);
    expect(mockUpdateVoiceConfig.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      locationId: LOCATION,
      fields: { highlightFacts: ['award-winning espresso'] },
    });

    mockUpdateVoiceConfig.mockResolvedValue({ ok: false, reason: 'location_not_found' });
    expect((await PUT(putRequest({ locationId: LOCATION, tone: 'warm' }))).status).toBe(404);

    // Over the documented limits, rejected before the transaction opens.
    mockSqlBegin.mockClear();
    const tooMany = await PUT(putRequest({
      locationId: LOCATION,
      highlightFacts: Array.from({ length: 21 }, (_, i) => `fact ${i}`),
    }));
    expect(tooMany.status).toBe(400);
    expect(mockSqlBegin).not.toHaveBeenCalled();

    // GET projects the column back.
    mockSqlQuery.mockResolvedValue([{
      id: LOCATION, name: 'Cafe', display_label: null, tone: 'warm',
      products_services: null, avoid_facts: null, highlight_facts: ['espresso'],
      sample_responses: null,
    }]);
    const get = await GET(new NextRequest(`${ORIGIN}/api/settings/voice?locationId=${LOCATION}`));
    expect(await get.json()).toMatchObject({ highlightFacts: ['espresso'] });
  });
});
