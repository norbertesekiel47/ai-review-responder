// Direct unit coverage for session-mode (dashboard) approval + the
// establishApprovalSession device binding (launch-audit part1, P2 test gap:
// previously tested only indirectly via service.test.ts). Collaborators
// (locks/audit/outbox helpers) are mocked; pure helpers run real.
//
// The tx double uses a LOCAL per-test return queue (one result per
// tagged-template call) — never module-level shared state (the bounced-skip
// flake, PR #158, was caused by exactly that).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockLockPendingResponse,
  mockRevokeOpenLinks,
  mockInsertAuditLog,
  mockInsertAuditLogSession,
  mockEnqueuePublish,
  mockEnqueueGenerate,
} = vi.hoisted(() => ({
  mockLockPendingResponse: vi.fn(),
  mockRevokeOpenLinks: vi.fn(),
  mockInsertAuditLog: vi.fn(),
  mockInsertAuditLogSession: vi.fn(),
  mockEnqueuePublish: vi.fn(),
  mockEnqueueGenerate: vi.fn(),
}));

vi.mock('../locks', () => ({
  lockPendingResponse: mockLockPendingResponse,
  revokeOpenLinksForResponse: mockRevokeOpenLinks,
}));
vi.mock('../audit', () => ({
  insertAuditLog: mockInsertAuditLog,
  insertAuditLogSession: mockInsertAuditLogSession,
}));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueuePublishResponse: mockEnqueuePublish,
  enqueueGenerateResponse: mockEnqueueGenerate,
}));

import {
  establishApprovalSession,
  approveBySession,
  editBySession,
  regenerateBySession,
} from '../session-mode';
import {
  InvalidTokenError,
  DeviceConflictError,
  EmptyEditedResponseError,
} from '../errors';

type TxCall = { text: string; values: unknown[] };

/** Tagged-template tx double with a local per-call return queue. */
function mkTx(returnQueue: unknown[][] = []) {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve(returnQueue.shift() ?? []);
  }) as never;
  return { tx, calls };
}

const SESSION_AUDIT = { actorUserId: 'user-1', ipAddress: '203.0.113.7' };

beforeEach(() => {
  vi.clearAllMocks();
  mockLockPendingResponse.mockResolvedValue({
    response_text: 'draft text',
    original_draft_text: 'draft text',
    review_id: 'rev-1',
    version: 1,
  });
});

describe('establishApprovalSession', () => {
  const TOKEN_AUDIT = {
    tokenHash: 'hash-abc',
    deviceCookieHash: 'device-hash',
    ipAddress: '203.0.113.7',
  };

  it('binds the device cookie on first visit and writes a session_bind audit', async () => {
    const { tx, calls } = mkTx([
      [{ device_cookie_hash: null, response_id: 'resp-1', business_id: 'biz-1' }],
    ]);
    await establishApprovalSession(tx, 'link-1', 'device-hash', TOKEN_AUDIT);

    const update = calls.find((c) => c.text.includes('SET device_cookie_hash'));
    expect(update).toBeDefined();
    expect(update!.values).toContain('device-hash');
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'session_bind', TOKEN_AUDIT,
    );
  });

  it('no-ops (no UPDATE) when the same device returns', async () => {
    const { tx, calls } = mkTx([
      [{ device_cookie_hash: 'device-hash', response_id: 'resp-1', business_id: 'biz-1' }],
    ]);
    await establishApprovalSession(tx, 'link-1', 'device-hash', TOKEN_AUDIT);

    expect(calls.some((c) => c.text.includes('SET device_cookie_hash'))).toBe(false);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'session_bind', TOKEN_AUDIT,
    );
  });

  it('throws DeviceConflictError for a different device, without auditing', async () => {
    const { tx } = mkTx([
      [{ device_cookie_hash: 'other-device', response_id: 'resp-1', business_id: 'biz-1' }],
    ]);
    await expect(
      establishApprovalSession(tx, 'link-1', 'device-hash', TOKEN_AUDIT),
    ).rejects.toThrow(DeviceConflictError);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('throws InvalidTokenError when the link row is gone', async () => {
    const { tx } = mkTx([[]]);
    await expect(
      establishApprovalSession(tx, 'link-1', 'device-hash', TOKEN_AUDIT),
    ).rejects.toThrow(InvalidTokenError);
  });
});

describe('approveBySession', () => {
  it('locks, revokes open links, marks approved, enqueues publish, writes session audit', async () => {
    const { tx, calls } = mkTx();
    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'corr-1');

    expect(mockLockPendingResponse).toHaveBeenCalledWith(tx, 'resp-1');
    expect(mockRevokeOpenLinks).toHaveBeenCalledWith(tx, 'resp-1');
    const update = calls.find((c) => c.text.includes("status = 'approved'"));
    expect(update).toBeDefined();
    expect(update!.values).toContain('resp-1');
    expect(update!.values).toContain('biz-1');
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });
    expect(mockInsertAuditLogSession).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'approve', SESSION_AUDIT, undefined,
      { responseTextAtApproval: 'draft text' },
    );
  });

  it('propagates lock failure without enqueueing or auditing', async () => {
    mockLockPendingResponse.mockRejectedValueOnce(new Error('not pending'));
    const { tx } = mkTx();
    await expect(
      approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT),
    ).rejects.toThrow('not pending');
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
    expect(mockInsertAuditLogSession).not.toHaveBeenCalled();
  });
});

describe('editBySession', () => {
  it('rejects empty edited text before any lock', async () => {
    const { tx } = mkTx();
    await expect(
      editBySession(tx, 'resp-1', 'biz-1', '   ', SESSION_AUDIT),
    ).rejects.toThrow(EmptyEditedResponseError);
    expect(mockLockPendingResponse).not.toHaveBeenCalled();
  });

  it('stores sanitized edited text with edit distance and enqueues publish', async () => {
    const { tx, calls } = mkTx();
    await editBySession(tx, 'resp-1', 'biz-1', 'better text', SESSION_AUDIT, 'corr-2');

    const update = calls.find((c) => c.text.includes("status = 'edited'"));
    expect(update).toBeDefined();
    expect(update!.text).toContain('edit_distance');
    expect(update!.values).toContain('better text');
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-2',
    });
    expect(mockInsertAuditLogSession).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'edit', SESSION_AUDIT,
      { edit_distance: expect.any(Number) },
      { responseTextAtApproval: 'better text' },
    );
  });
});

describe('regenerateBySession', () => {
  it('supersedes the response and enqueues generate_response with version+1 (no publish)', async () => {
    const { tx, calls } = mkTx();
    await regenerateBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'corr-3');

    expect(mockRevokeOpenLinks).toHaveBeenCalledWith(tx, 'resp-1');
    expect(calls.some((c) => c.text.includes("status = 'superseded'"))).toBe(true);
    expect(mockEnqueueGenerate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ reviewId: 'rev-1', businessId: 'biz-1', version: 2 }),
    );
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
    expect(mockInsertAuditLogSession).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'regenerate', SESSION_AUDIT,
    );
  });
});
