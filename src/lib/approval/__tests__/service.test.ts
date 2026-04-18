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
  edit,
  regenerate,
} from '../service';
import type { ApprovalLink, AuditContext } from '../service';
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
      // INSERT audit log
      [],
    ]);

    await establishApprovalSession(tx, 'link-1', 'device-hash-abc', AUDIT);

    expect(tx).toHaveBeenCalledTimes(3);
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
      [{ status: 'pending_approval', original_draft_text: 'draft', version: 1, review_id: 'rev-1' }],
      // consumeLink: UPDATE approval_links SET consumed_at
      [],
      // UPDATE responses SET status = 'approved'
      [],
      // revokeSiblings: UPDATE approval_links SET revoked_at
      [],
      // INSERT INTO job_outbox
      [],
      // insertAuditLog: INSERT INTO approval_audit_log
      [],
    ]);

    await approve(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(6);

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
  });
});

// ── edit ──────────────────────────────────────────────────────────────────

describe('edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes edit distance using real levenshtein, updates response with edited text', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });
    const editedText = 'Modified text';

    const tx = createMockTx([
      // lockPendingResponse: SELECT ... FOR UPDATE
      [{ status: 'pending_approval', original_draft_text: 'Original text', version: 1, review_id: 'rev-1' }],
      // consumeLink
      [],
      // UPDATE responses SET status = 'edited'
      [],
      // revokeSiblings
      [],
      // INSERT INTO job_outbox
      [],
      // insertAuditLog
      [],
    ]);

    await edit(tx, link, editedText, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(6);

    // Verify the edit distance was computed correctly
    const { distance } = await import('fastest-levenshtein');
    const expectedDist = distance('Original text', editedText);

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
    expect(allStringArgs).toContain(editedText);

    // Verify correlation_id propagates into the publish_response outbox payload.
    const publishPayload = allObjectArgs.find((p: Record<string, unknown>) => p.response_id === link.response_id && !('satisfaction' in p),
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
      [{ status: 'pending_approval', original_draft_text: 'draft', version: 1, review_id: 'rev-1' }],
      // consumeLink
      [],
      // revokeSiblings
      [],
      // UPDATE responses SET status = 'superseded'
      [],
      // INSERT INTO job_outbox (generate_response)
      [],
      // insertAuditLog
      [],
    ]);

    await regenerate(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    expect(tx).toHaveBeenCalledTimes(6);

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

    // Verify correlation_id propagates into the generate_response outbox payload.
    expect(parsed!.correlation_id).toBe('test-correlation-xyz');
  });
});
