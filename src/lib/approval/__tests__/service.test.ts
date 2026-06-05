import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

// Mock db/server so imports from service.ts resolve without requiring a
// live Postgres/Supabase connection. `jsonb` passes the value through —
// the tests inspect the raw payload object via the mock tx call args.
vi.mock('@/lib/db/server', () => ({
  sql: () => Promise.resolve([]),
  jsonb: (v: unknown) => v,
}));

import {
  lockValidLink,
  establishApprovalSession,
  approve,
  approveBySession,
  edit,
  editBySession,
  regenerate,
} from '../service';
import type { ApprovalLink, AuditContext, SessionAuditContext } from '../service';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
} from '../errors';

// ── Helpers ──────────────────────────────────────────────────────────────

const RAW_TOKEN = 'test-raw-token-uuid';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

function validLink(overrides: Partial<ApprovalLink> = {}): ApprovalLink {
  return {
    id: 'link-1',
    response_id: 'resp-1',
    business_id: 'biz-1',
    token_hash: TOKEN_HASH,
    channel: 'email',
    expires_at: new Date(Date.now() + 86_400_000),
    consumed_at: null,
    revoked_at: null,
    device_cookie_hash: null,
    created_at: new Date(),
    ...overrides,
  };
}

const AUDIT: AuditContext = {
  tokenHash: TOKEN_HASH,
  deviceCookieHash: 'device-hash-abc',
  ipAddress: '127.0.0.1',
};

const SESSION_AUDIT: SessionAuditContext = {
  actorUserId: 'user-1',
  ipAddress: '127.0.0.1',
};

/**
 * Creates a mock tagged template function that returns values from a queue
 * in order. Each call to the mock shifts the next value off the queue.
 */
function createMockTx(returnQueue: unknown[]) {
  const queue = [...returnQueue];
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = queue.shift() ?? [];
    return Promise.resolve(result);
  });
  return fn as any;
}

// ── lockValidLink ────────────────────────────────────────────────────────

describe('lockValidLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns link row when token is valid', async () => {
    const link = validLink();
    const tx = createMockTx([[link]]);

    const result = await lockValidLink(tx, RAW_TOKEN);

    expect(result).toEqual(link);
    expect(tx).toHaveBeenCalledOnce();
  });

  it('throws InvalidTokenError when token is unknown', async () => {
    const tx = createMockTx([[]]);

    await expect(lockValidLink(tx, RAW_TOKEN)).rejects.toThrow(InvalidTokenError);
  });

  it('throws ExpiredTokenError when link is expired', async () => {
    const link = validLink({ expires_at: new Date(Date.now() - 1000) });
    const tx = createMockTx([[link]]);

    await expect(lockValidLink(tx, RAW_TOKEN)).rejects.toThrow(ExpiredTokenError);
  });

  it('throws ConsumedTokenError when link is already consumed', async () => {
    const link = validLink({ consumed_at: new Date() });
    const tx = createMockTx([[link]]);

    await expect(lockValidLink(tx, RAW_TOKEN)).rejects.toThrow(ConsumedTokenError);
  });

  it('throws RevokedTokenError when link is revoked', async () => {
    const link = validLink({ revoked_at: new Date() });
    const tx = createMockTx([[link]]);

    await expect(lockValidLink(tx, RAW_TOKEN)).rejects.toThrow(RevokedTokenError);
  });
});

// ── establishApprovalSession ─────────────────────────────────────────────

describe('establishApprovalSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('binds device cookie on first visit', async () => {
    const tx = createMockTx([
      // SELECT device_cookie_hash
      [{ device_cookie_hash: null, response_id: 'resp-1', business_id: 'biz-1' }],
      // UPDATE approval_links SET device_cookie_hash
      [],
      // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
      [{ account_id: 'acc-1' }],
      // INSERT audit log
      [],
    ]);

    await establishApprovalSession(tx, 'link-1', 'device-hash-abc', AUDIT);

    expect(tx).toHaveBeenCalledTimes(4);
  });

  it('throws DeviceConflictError on different device', async () => {
    const tx = createMockTx([
      [{ device_cookie_hash: 'different-device-hash', response_id: 'resp-1', business_id: 'biz-1' }],
    ]);

    await expect(
      establishApprovalSession(tx, 'link-1', 'device-hash-abc', AUDIT),
    ).rejects.toThrow(DeviceConflictError);
  });
});

// ── approve ──────────────────────────────────────────────────────────────

describe('approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes link, updates response, revokes siblings, inserts outbox and audit', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });

    const tx = createMockTx([
      // lockPendingResponse: SELECT ... FOR UPDATE
      [{ status: 'pending_approval', original_draft_text: 'draft', response_text: 'Approved draft', version: 1, review_id: 'rev-1' }],
      // consumeLink: UPDATE approval_links SET consumed_at
      [],
      // UPDATE responses SET status = 'approved'
      [],
      // revokeSiblings: UPDATE approval_links SET revoked_at
      [],
      // INSERT INTO job_outbox
      [],
      // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
      [{ account_id: 'acc-1' }],
      // insertAuditLog: INSERT INTO approval_audit_log
      [],
    ]);

    await approve(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(7);

    // Verify the outbox INSERT received the correct publish_response payload.
    // The outbox INSERT binds payload via jsonb(payload) — the test mock of
    // db/server returns the OBJECT pass-through, so we look for object args.
    const objectPayloads = tx.mock.calls
      .flat()
      .filter(
        (arg: unknown): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'response_id' in (arg as Record<string, unknown>),
      );

    const payload = objectPayloads.find((p: Record<string, unknown>) => p.business_id === 'biz-1',
    );
    expect(payload).toBeDefined();
    expect(payload!.response_id).toBe('resp-1');
    expect(payload!.business_id).toBe('biz-1');

    // Verify correlation_id propagates into the publish_response outbox payload.
    const publishPayload = objectPayloads.find((p: Record<string, unknown>) => p.response_id === link.response_id && !('satisfaction' in p),
    );
    expect(publishPayload).toBeDefined();
    expect(publishPayload!.correlation_id).toBe('test-correlation-xyz');

    const responseUpdateCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes("SET status = 'approved'"),
    );
    expect(responseUpdateCall).toBeDefined();
    expect(String((responseUpdateCall![0] as TemplateStringsArray).join(''))).toContain('approval_method');
    expect(responseUpdateCall!.flat()).toContain('owner');
  });

  it('writes approved text snapshot to approval_audit_log for approve-as-is', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });
    const responseText = 'Thanks for the thoughtful review.';
    const tx = createMockTx([
      [{ status: 'pending_approval', original_draft_text: 'draft', response_text: responseText, version: 1, review_id: 'rev-1' }],
      [],
      [],
      [],
      [],
      [{ account_id: 'acc-1' }],
      [],
    ]);

    await approve(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    const auditCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes('approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.flat()).toContain(responseText);
  });
});

// ── edit ──────────────────────────────────────────────────────────────────

describe('edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sanitizes edited text before storing it and computing edit distance', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });
    const editedText = '  Modified\t\ttext\u200B\x00  ';
    const sanitizedText = 'Modified text';

    const tx = createMockTx([
      // lockPendingResponse: SELECT ... FOR UPDATE
      [{ status: 'pending_approval', original_draft_text: 'Original text', response_text: 'Original response', version: 1, review_id: 'rev-1' }],
      // consumeLink
      [],
      // UPDATE responses SET status = 'edited'
      [],
      // revokeSiblings
      [],
      // INSERT INTO job_outbox
      [],
      // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
      [{ account_id: 'acc-1' }],
      // insertAuditLog
      [],
    ]);

    await edit(tx, link, editedText, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(7);

    // Verify the edit distance was computed correctly
    const { distance } = await import('fastest-levenshtein');
    const expectedDist = distance('Original text', sanitizedText);

    // The edit distance appears as an interpolated number in one of the tagged template calls
    const allNumArgs = tx.mock.calls
      .flat()
      .filter((arg: unknown): arg is number => typeof arg === 'number');
    expect(allNumArgs).toContain(expectedDist);

    // Verify the outbox INSERT received the correct payload
    const allStringArgs = tx.mock.calls
      .flat()
      .filter((arg: unknown): arg is string => typeof arg === 'string');
    const allObjectArgs = tx.mock.calls
      .flat()
      .filter(
        (arg: unknown): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'response_id' in (arg as Record<string, unknown>),
      );

    const payloadArg = allObjectArgs.find((p: Record<string, unknown>) => 'business_id' in p,
    );
    expect(payloadArg).toBeDefined();
    expect(allStringArgs).toContain(sanitizedText);
    expect(allStringArgs).not.toContain(editedText);

    const responseUpdateCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes("SET status = 'edited'"),
    );
    expect(responseUpdateCall).toBeDefined();
    expect(String((responseUpdateCall![0] as TemplateStringsArray).join(''))).toContain('approval_method');
    expect(responseUpdateCall!.flat()).toContain('owner');
    expect(responseUpdateCall!.filter((arg: unknown) => arg === sanitizedText)).toHaveLength(2);

    const auditCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes('approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![7]).toBe('edit');
    expect(auditCall![10]).toBe(sanitizedText);
    expect(auditCall![10]).not.toBe(editedText);

    // Verify correlation_id propagates into the publish_response outbox payload.
    const publishPayload = allObjectArgs.find((p: Record<string, unknown>) => p.response_id === link.response_id && !('satisfaction' in p),
    );
    expect(publishPayload).toBeDefined();
    expect(publishPayload!.correlation_id).toBe('test-correlation-xyz');
  });
});

// ── editBySession ────────────────────────────────────────────────────────

describe('approveBySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets owner approval attribution when approving from a session', async () => {
    const tx = createMockTx([
      [{ status: 'pending_approval', original_draft_text: 'Session draft', response_text: 'Session response', version: 1, review_id: 'rev-1' }],
      [],
      [],
      [],
      [{ account_id: 'acc-1' }],
      [],
    ]);

    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'test-correlation-xyz');

    const responseUpdateCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes("SET status = 'approved'"),
    );
    expect(responseUpdateCall).toBeDefined();
    expect(String((responseUpdateCall![0] as TemplateStringsArray).join(''))).toContain('approval_method');
    expect(responseUpdateCall!.flat()).toContain('owner');
  });
});

describe('editBySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sanitizes edited text before storing it and computing edit distance', async () => {
    const editedText = '  Session\t\tedit\u202E\n\n\nSecond line  ';
    const sanitizedText = 'Session edit\n\nSecond line';

    const tx = createMockTx([
      // lockPendingResponse: SELECT ... FOR UPDATE
      [{ status: 'pending_approval', original_draft_text: 'Session draft', response_text: 'Session response', version: 1, review_id: 'rev-1' }],
      // revokeOpenLinksForResponse
      [],
      // UPDATE responses SET status = 'edited'
      [],
      // INSERT INTO job_outbox
      [],
      // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
      [{ account_id: 'acc-1' }],
      // insertAuditLogSession
      [],
    ]);

    await editBySession(tx, 'resp-1', 'biz-1', editedText, SESSION_AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(6);

    const { distance } = await import('fastest-levenshtein');
    const expectedDist = distance('Session draft', sanitizedText);

    const allNumArgs = tx.mock.calls
      .flat()
      .filter((arg: unknown): arg is number => typeof arg === 'number');
    expect(allNumArgs).toContain(expectedDist);

    const allStringArgs = tx.mock.calls
      .flat()
      .filter((arg: unknown): arg is string => typeof arg === 'string');
    expect(allStringArgs).toContain(sanitizedText);
    expect(allStringArgs).not.toContain(editedText);

    const responseUpdateCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes("SET status = 'edited'"),
    );
    expect(responseUpdateCall).toBeDefined();
    expect(String((responseUpdateCall![0] as TemplateStringsArray).join(''))).toContain('approval_method');
    expect(responseUpdateCall!.flat()).toContain('owner');
    expect(responseUpdateCall!.filter((arg: unknown) => arg === sanitizedText)).toHaveLength(2);

    const auditCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes('approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![7]).toBe('edit');
    expect(auditCall![11]).toBe(sanitizedText);
    expect(auditCall![11]).not.toBe(editedText);

    const allObjectArgs = tx.mock.calls
      .flat()
      .filter(
        (arg: unknown): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'response_id' in (arg as Record<string, unknown>),
      );
    const publishPayload = allObjectArgs.find((p: Record<string, unknown>) => p.response_id === 'resp-1' && !('satisfaction' in p),
    );
    expect(publishPayload).toBeDefined();
    expect(publishPayload!.correlation_id).toBe('test-correlation-xyz');
  });
});

// ── regenerate ───────────────────────────────────────────────────────────

describe('regenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes link, supersedes response, inserts generate outbox with version+1', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });

    const tx = createMockTx([
      // lockPendingResponse: SELECT ... FOR UPDATE
      [{ status: 'pending_approval', original_draft_text: 'draft', response_text: 'Regenerate response', version: 1, review_id: 'rev-1' }],
      // consumeLink
      [],
      // revokeSiblings
      [],
      // UPDATE responses SET status = 'superseded'
      [],
      // INSERT INTO job_outbox (generate_response)
      [],
      // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
      [{ account_id: 'acc-1' }],
      // insertAuditLog
      [],
    ]);

    await regenerate(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(7);

    // Verify the outbox INSERT received the correct generate_response payload.
    // Literal SQL strings like 'generate_response' are part of the template, not interpolated.
    // Interpolated values in the outbox INSERT: uuidv7(), current.review_id, JSON payload
    // Payloads are now bound via jsonb(x) — test mock passes objects through.
    const objectPayloads = tx.mock.calls
      .flat()
      .filter(
        (arg: unknown): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'version' in (arg as Record<string, unknown>),
      );

    const parsed = objectPayloads.find((p: Record<string, unknown>) => typeof p.review_id === 'string' && typeof p.version === 'number',
    );
    expect(parsed).toBeDefined();
    expect(parsed!.version).toBe(2);
    expect(parsed!.review_id).toBe('rev-1');
    expect(parsed!.business_id).toBe('biz-1');
    expect(parsed!.origin_lane).toBe('regenerate');

    // Verify correlation_id propagates into the generate_response outbox payload.
    expect(parsed!.correlation_id).toBe('test-correlation-xyz');
  });
});
