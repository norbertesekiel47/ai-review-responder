import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────
//
// Same mocking dialect as the sibling voice settings route test
// (../../__tests__/route.test.ts): tagged-template calls route to
// mockSqlQuery(strings, ...values); mocks are registered before the
// route import.

const { mockRequireRole, mockSqlQuery, mockGetVoiceCorpusStatus } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockGetVoiceCorpusStatus: vi.fn(),
}));

function isTemplate(arg: unknown): arg is TemplateStringsArray {
  return Array.isArray(arg) && Object.prototype.hasOwnProperty.call(arg, 'raw');
}

// ── Mock Auth ───────────────────────────────────────────────────────

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

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const sql = (...args: unknown[]) => {
    if (isTemplate(args[0])) {
      return mockSqlQuery(args[0], ...args.slice(1));
    }
    return { __helper: args[0] };
  };
  return { sql };
});

// ── Mock voice-learning corpus reader ───────────────────────────────

vi.mock('@/lib/responses/voice-learning', () => ({
  getVoiceCorpusStatus: (...args: unknown[]) => mockGetVoiceCorpusStatus(...args),
}));

// Import AFTER mocks
import { GET } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
  };
}

function makeRequest(locationId?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/settings/voice/report-card');
  if (locationId) {
    url.searchParams.set('locationId', locationId);
  }
  return new NextRequest(url.toString());
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/settings/voice/report-card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it("returns 404 for a location outside the caller's account", async () => {
    mockSqlQuery.mockResolvedValueOnce([]); // ownership SELECT finds nothing

    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(404);
    expect(mockGetVoiceCorpusStatus).not.toHaveBeenCalled();
  });

  it('returns activation progress for a location below threshold', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ id: LOCATION_ID }]);
    mockGetVoiceCorpusStatus.mockResolvedValueOnce({ editedCount: 2, examples: [] });

    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      locationId: LOCATION_ID,
      activationThreshold: 5,
      editedCount: 2,
      activated: false,
      traits: [],
    });
  });

  it('returns derived traits for an activated location', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ id: LOCATION_ID }]);
    mockGetVoiceCorpusStatus.mockResolvedValueOnce({
      editedCount: 6,
      examples: [
        { originalDraft: 'Dear Amanda, thank you so much for the wonderful feedback you shared.', editedVersion: 'Hi Amanda — thanks so much!', reviewStarRating: 5 },
        { originalDraft: 'Dear Tom, we appreciate your detailed feedback about the seating.', editedVersion: 'Hi Tom — glad the flat white landed.', reviewStarRating: 4 },
        { originalDraft: 'Dear Rosa, we are so happy to hear our team made your morning.', editedVersion: 'Hi Rosa — the crew says thanks.', reviewStarRating: 5 },
        { originalDraft: 'Dear Priya, thank you for your kind words about our pastries.', editedVersion: 'Hi Priya — the buns sell out by 10am.', reviewStarRating: 5 },
        { originalDraft: 'Dear Derek, we sincerely apologize for the inconvenience caused.', editedVersion: 'Hi Derek — that wait was not okay.', reviewStarRating: 2 },
      ],
    });

    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.activated).toBe(true);
    expect(body.traits.length).toBeGreaterThan(0);
    expect(body.traits.map((t: { key: string }) => t.key)).toContain('greeting');
  });

  it('returns 400 when locationId is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(mockSqlQuery).not.toHaveBeenCalled();
  });
});
