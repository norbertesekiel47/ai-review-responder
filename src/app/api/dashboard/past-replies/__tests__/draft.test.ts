import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { NextRequest, NextResponse } from 'next/server';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  mockAssertCanEdit,
  mockValidateOptimistic,
  mockEnforceRegenLimit,
  txQueue,
  txMock,
  beginMock,
  sqlProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();
  const mockAssertCanEdit = vi.fn();
  const mockValidateOptimistic = vi.fn();
  const mockEnforceRegenLimit = vi.fn();

  // Each call to tx`...` returns the next array from the queue.
  const txQueue: unknown[][] = [];
  const txMock = vi.fn(async () => txQueue.shift() ?? []);
  // Enqueue helpers now bind JSONB via `tx.json(x)` (Postgres.js identity JSONB
  // constructor) instead of the module `jsonb` helper. Mirror the module mock's
  // identity passthrough so payloads flow into the tagged-template params as before.
  (txMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  // sql.begin runs the callback synchronously with the tx mock.
  const beginMock = vi.fn(async (cb: (tx: unknown) => Promise<Response>) => cb(txMock));

  // Top-level sql`...`: resolveOwnerScope's subscription_status lookup must
  // return an ACTIVE account; everything else resolves to [].
  const sqlTop = (strings: TemplateStringsArray, ..._args: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('subscription_status')) {
      return Promise.resolve([{ subscription_status: 'active' }]);
    }
    return Promise.resolve([]);
  };
  const sqlProxy = new Proxy(sqlTop, {
    get: (_t, prop) => {
      if (prop === 'begin') return beginMock;
      return undefined;
    },
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    mockAssertCanEdit,
    mockValidateOptimistic,
    mockEnforceRegenLimit,
    txQueue,
    txMock,
    beginMock,
    sqlProxy,
  };
});

// Shared per-owner regenerate limiter. Default: allow (null); a test overrides
// with a 429 NextResponse to exercise the blocked regenerate path.
vi.mock('@/lib/shared/dashboard-regen-rate-limit', () => ({
  enforceDashboardRegenRateLimit: (...args: unknown[]) => mockEnforceRegenLimit(...args),
}));

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: sqlProxy,
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
}));

vi.mock('@/lib/responses/edit-existing', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/responses/edit-existing')>(
      '@/lib/responses/edit-existing',
    );
  return {
    ...actual,
    assertCanEditReply: (...args: unknown[]) => mockAssertCanEdit(...args),
    validateOptimisticConcurrency: (...args: unknown[]) => mockValidateOptimistic(...args),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
// A second location on the same account — used to verify cookie-based scoping.
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const APP_URL = 'http://localhost:3000';

function ownerUser(overrides?: Partial<{ locationId: string | null; accountId: string | null; id: string }>) {
  return {
    id: overrides?.id ?? 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
    locationId: overrides && 'locationId' in overrides ? overrides.locationId : LOCATION_ID,
  };
}

function makeRequest(opts?: {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  locationScopeCookie?: string;
}): NextRequest {
  const body = opts?.rawBody ?? (opts?.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Default to a same-origin request unless the test asks for otherwise.
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers['Origin'] = origin;
  if (opts?.locationScopeCookie) {
    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
  }
  return new NextRequest(`${APP_URL}/api/dashboard/past-replies/draft`, {
    method: 'POST',
    body,
    headers,
  });
}

function validBody(overrides: Partial<{ mode: 'manual' | 'regenerate'; new_text: string; review_id: string; snapshot: { hash: string; version: number } }> = {}) {
  const mode = overrides.mode ?? 'manual';
  const base = {
    mode,
    review_id: overrides.review_id ?? REVIEW_ID,
    snapshot: overrides.snapshot ?? { hash: 'hash-A', version: 3 },
  };
  if (mode === 'manual') {
    return { ...base, new_text: overrides.new_text ?? 'Updated reply text' };
  }
  return base;
}

function seedTxRows(...rowsets: unknown[][]) {
  txQueue.push(...rowsets);
}

beforeEach(() => {
  vi.clearAllMocks();
  txQueue.length = 0;
  process.env.EDIT_REPLIES_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  // Default: getRequestScope resolves to the primary location.
  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
  // Default: assertCanEditReply succeeds, validateOptimisticConcurrency succeeds.
  mockAssertCanEdit.mockResolvedValue(undefined);
  mockValidateOptimistic.mockResolvedValue(undefined);
  // Default: regenerate limiter allows the request.
  mockEnforceRegenLimit.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.EDIT_REPLIES_ENABLED;
});

async function importPOST() {
  const mod = await import('../draft/route');
  return mod.POST as (req: NextRequest) => Promise<Response>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/dashboard/past-replies/draft', () => {
  it('returns 503 feature_disabled when EDIT_REPLIES_ENABLED is off', async () => {
    process.env.EDIT_REPLIES_ENABLED = 'false';
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('feature_disabled');
  });

  it('returns 401 when no owner session', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(401);
  });

  it('returns 403 cross-origin when wrong Origin header (withSameOrigin)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody(), origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns 403 ForbiddenError when unsupported-tier owner attacks historical review', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { ForbiddenError } = await import('@/lib/responses/edit-existing');
    mockAssertCanEdit.mockRejectedValue(new ForbiddenError());
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('returns 409 review_changed when hash mismatches; body includes current_review_text and current_review_hash', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { ReviewChangedError } = await import('@/lib/responses/edit-existing');
    // tx queue: lock-row, existing-check (empty), pendingGen (empty)
    seedTxRows([{ id: REVIEW_ID }], [], []);
    mockValidateOptimistic.mockRejectedValue(
      new ReviewChangedError({ reviewText: 'Edited content', reviewHash: 'hash-NEW' }),
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('review_changed');
    expect(body.current_review_text).toBe('Edited content');
    expect(body.current_review_hash).toBe('hash-NEW');
  });

  it('returns 409 response_changed when version mismatches', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const { ResponseChangedError } = await import('@/lib/responses/edit-existing');
    seedTxRows([{ id: REVIEW_ID }], [], []);
    mockValidateOptimistic.mockRejectedValue(new ResponseChangedError());
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('response_changed');
  });

  it('returns 409 draft_already_exists with the existing draft including status so the client can branch correctly', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-row, existing-check returns the in-progress draft → 409.
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ response_id: 'existing-draft-1', text: 'Half-written reply', is_edited: true, status: 'pending_approval' }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('draft_already_exists');
    // The conflict payload carries the existing draft for the resume/discard UI.
    expect(body.existing).toEqual({
      response_id: 'existing-draft-1',
      text: 'Half-written reply',
      is_edited: true,
      status: 'pending_approval',
    });
  });

  it('returns 409 draft_already_exists with status=approved when publish is already queued', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ response_id: 'existing-draft-2', text: 'Approved reply', is_edited: false, status: 'approved' }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('draft_already_exists');
    expect(body.existing.status).toBe('approved');
  });

  it('returns 409 draft_already_exists with status=awaiting_owner_connect when Google is disconnected', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ response_id: 'existing-draft-3', text: 'Parked reply', is_edited: false, status: 'awaiting_owner_connect' }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('draft_already_exists');
    expect(body.existing.status).toBe('awaiting_owner_connect');
  });

  it('returns 409 regenerate_in_progress when a generate_response outbox row is pending', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-row, existing-check (empty), pendingGen returns a row
    seedTxRows([{ id: REVIEW_ID }], [], [{ exists: 1 }]);
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody({ mode: 'regenerate' }) }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('regenerate_in_progress');
  });

  it('manual mode happy path → INSERTs response status=pending_approval, edited_text=new_text, returns { response_id }', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue (manual flow):
    //   1. lock-row (returns review id)
    //   2. existing-check (empty)
    //   3. pendingGen-check (empty)
    //   4. version MAX (returns next_version=4)
    //   5. SELECT posted (returns existing posted row)
    //   6. INSERT response (returns empty)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [],
      [],
      [{ next_version: 4 }],
      [{ approved_text: 'Old reply', response_text: 'Old reply', response_language: 'en' }],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody({ new_text: 'Brand new reply' }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.response_id).toBe('string');
    expect(body.response_id).toMatch(/^[0-9a-f-]{36}$/);

    // INSERT call: last tx invocation. Inspect the SQL template + bound parameters.
    const insertCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    expect(insertCall).toBeDefined();
    const templateStrings = insertCall[0] as unknown as TemplateStringsArray;
    const sqlText = templateStrings.join('|');
    expect(sqlText).toContain('INSERT INTO responses');
    // Bound args order matches the route: id, review_id, business_id (locationId), response_text,
    //   approved_text, original_draft_text, edited_text, response_language, version, status (literal).
    const args = insertCall.slice(1);
    expect(args[1]).toBe(REVIEW_ID);            // review_id
    expect(args[2]).toBe(LOCATION_ID);          // business_id (locationId)
    expect(args[3]).toBe('Old reply');          // response_text = before
    expect(args[4]).toBe('Brand new reply');    // approved_text = new_text
    expect(args[5]).toBe('Old reply');          // original_draft_text = before
    expect(args[6]).toBe('Brand new reply');    // edited_text = new_text
    expect(args[7]).toBe('en');                 // response_language
    expect(args[8]).toBe(4);                    // version
    // status='pending_approval' is a literal in the SQL — verify it's there.
    expect(sqlText).toContain("'pending_approval'");
  });

  it('regenerate mode happy path → INSERTs job_outbox topic=generate_response with version=MAX+1 and suppress_notification=true, returns { outbox_id }', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue (regenerate flow):
    //   1. lock-row
    //   2. existing-check (empty)
    //   3. pendingGen-check (empty)
    //   4. version MAX (next_version=2)
    //   5. INSERT outbox (empty)
    seedTxRows(
      [{ id: REVIEW_ID }],
      [],
      [],
      [{ next_version: 2 }],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody({ mode: 'regenerate' }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.outbox_id).toBe('string');
    expect(body.outbox_id).toMatch(/^[0-9a-f-]{36}$/);

    const insertCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    expect(insertCall).toBeDefined();
    const templateStrings = insertCall[0] as unknown as TemplateStringsArray;
    const sqlText = templateStrings.join('|');
    expect(sqlText).toContain('INSERT INTO job_outbox');
    // Bound args: id, topic, aggregate_type, aggregate_id, payload, status.
    const args = insertCall.slice(1);
    expect(args[0]).toBe(body.outbox_id);
    expect(args[1]).toBe('generate_response');
    expect(args[2]).toBe('review');
    expect(args[3]).toBe(REVIEW_ID);
    // payload is jsonb()-wrapped in helper; mock unwraps to identity, so args[4] is payload object.
    const payload = args[4] as unknown as {
      review_id: string;
      business_id: string;
      version: number;
      origin_lane: string;
      suppress_notification: boolean;
    };
    expect(payload.review_id).toBe(REVIEW_ID);
    expect(payload.business_id).toBe(LOCATION_ID);
    expect(payload.version).toBe(2);
    expect(payload.origin_lane).toBe('regenerate');
    expect(payload.suppress_notification).toBe(true);
  });

  it('returns 400 invalid_body when Zod schema fails', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const POST = await importPOST();
    // Missing review_id + missing snapshot → Zod fails.
    const res = await POST(makeRequest({ body: { mode: 'manual', new_text: 'hi' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('REGRESSION: when rw_location_scope cookie points at a non-primary location, DB lookups use that location (not primary)', async () => {
    // The session user's locationId is the PRIMARY location (LOCATION_ID).
    // The cookie selects ALT_LOCATION_ID — getRequestScope returns it.
    mockRequireRole.mockResolvedValue(ownerUser({ locationId: LOCATION_ID }));
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: ALT_LOCATION_ID,
    });
    // tx queue (manual flow):
    //   1. lock-row (review scoped to ALT_LOCATION_ID)
    //   2. existing-check (empty)
    //   3. pendingGen-check (empty)
    //   4. version MAX
    //   5. SELECT posted row
    //   6. INSERT response
    seedTxRows(
      [{ id: REVIEW_ID }],
      [],
      [],
      [{ next_version: 1 }],
      [{ approved_text: 'Old', response_text: 'Old', response_language: 'en' }],
      [],
    );
    const POST = await importPOST();
    const res = await POST(
      makeRequest({
        body: validBody({ new_text: 'New reply for alt location' }),
        locationScopeCookie: ALT_LOCATION_ID,
      }),
    );
    expect(res.status).toBe(200);

    // getRequestScope must have been called with ALT_LOCATION_ID as the cookie value.
    // Leading arg is the sql client resolveOwnerScope threads through (A+ campaign 2a).
    expect(mockGetRequestScope).toHaveBeenCalledWith(sqlProxy, ACCOUNT_ID, ALT_LOCATION_ID);

    // The INSERT must use ALT_LOCATION_ID as business_id — NOT LOCATION_ID.
    const insertCall = txMock.mock.calls.at(-1) as unknown as unknown[];
    const args = insertCall.slice(1);
    expect(args[2]).toBe(ALT_LOCATION_ID); // business_id in INSERT
    expect(args[2]).not.toBe(LOCATION_ID); // explicitly not the primary location
  });

  it('regenerate mode: returns 429 and never opens the tx when the per-owner limit is exceeded', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    mockEnforceRegenLimit.mockResolvedValueOnce(
      NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Cache-Control': 'no-store, private' } }),
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody({ mode: 'regenerate' }) }));
    expect(res.status).toBe(429);
    expect(mockEnforceRegenLimit).toHaveBeenCalledWith(ACCOUNT_ID);
    // Limiter short-circuits before the outbox enqueue tx.
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('manual mode is NOT rate-limited (plain INSERT, not an LLM call)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue (manual flow): lock-row, existing (empty), pendingGen (empty),
    // version MAX, SELECT posted, INSERT response.
    seedTxRows(
      [{ id: REVIEW_ID }],
      [],
      [],
      [{ next_version: 4 }],
      [{ approved_text: 'Old', response_text: 'Old', response_language: 'en' }],
      [],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody({ mode: 'manual', new_text: 'New reply' }) }));
    expect(res.status).toBe(200);
    expect(mockEnforceRegenLimit).not.toHaveBeenCalled();
  });
});

// ── #726 moderation-held draft gate ─────────────────────────────────
//
// A moderation-held draft (invariant #4) "surfaces neither its text nor any
// button". When the existing-draft branch resolves a held draft, the route
// must refuse with the owner-visible vocabulary `held_for_review` and never
// echo the draft payload. src/lib/moderation/held-draft.ts is the semantic
// owner of "is this draft held" — the REAL hasOpenFlag executes its
// flagged_responses query against the tx queue mock (consuming one entry,
// binding the response id), so it is deliberately NOT mocked here.

// Unique sentinels: heldness refusals assert these appear NOWHERE in the
// serialized body — a leak of either is an invariant #4 violation.
const SENTINEL_HELD_ID = 'SENTINEL_HELD_ID_5f2c8d4ab1e04973';
const SENTINEL_HELD_TEXT = 'SENTINEL_HELD_TEXT_e07b61c92a3f4d58';

describe('POST /api/dashboard/past-replies/draft — moderation-held draft gate (#726)', () => {
  const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');

  it('returns 409 held_for_review without the existing draft payload when the existing draft has an open moderation flag', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    // tx queue: lock-review, existing-draft (held sentinels),
    // hasOpenFlag → [{ one: 1 }] (open flag exists).
    seedTxRows(
      [{ id: REVIEW_ID }],
      [{ response_id: SENTINEL_HELD_ID, text: SENTINEL_HELD_TEXT, is_edited: false, status: 'pending_approval' }],
      [{ one: 1 }],
    );
    const POST = await importPOST();
    const res = await POST(makeRequest({ body: validBody() }));
    expect(res.status).toBe(409);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SENTINEL_HELD_ID);
    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
    // Exactly the safe shape — no `existing` payload.
    expect(body).toEqual({ error: 'held_for_review' });

    const txCalls: unknown[][] = txMock.mock.calls;
    // The existing-draft SELECT must take the response row lock the
    // held-draft.ts contract requires (hasOpenFlag is in-tx, post-lock).
    const existingSelect = txCalls.find((call) => {
      const text = joinTemplate(call);
      return text.includes('FROM responses') && text.includes('status = ANY');
    });
    expect(existingSelect).toBeDefined();
    expect(joinTemplate(existingSelect as unknown[])).toContain('FOR UPDATE');
    // hasOpenFlag executed against flagged_responses, binding the held draft's id.
    const flagCall = txCalls.find((call) => joinTemplate(call).includes('flagged_responses'));
    expect(flagCall).toBeDefined();
    expect((flagCall as unknown[]).slice(1)).toContain(SENTINEL_HELD_ID);
  });

  it('invariants: no non-terminal status ever leaks existing draft text or response id while an open flag exists', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());
    const POST = await importPOST();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NON_TERMINAL_STATUSES), async (status) => {
        // Fresh queues per run: lock-review, existing draft at this
        // non-terminal status (held sentinels), hasOpenFlag → open.
        txQueue.length = 0;
        seedTxRows(
          [{ id: REVIEW_ID }],
          [{ response_id: SENTINEL_HELD_ID, text: SENTINEL_HELD_TEXT, is_edited: false, status }],
          [{ one: 1 }],
        );
        const res = await POST(makeRequest({ body: validBody() }));
        expect(res.status).toBe(409);
        const body = await res.json();
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(SENTINEL_HELD_ID);
        expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
        // Exact refusal body per run — nothing but the vocabulary.
        expect(body).toEqual({ error: 'held_for_review' });
      }),
    );
  });
});
