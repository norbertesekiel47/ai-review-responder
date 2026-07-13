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
  mockFindActiveReviewRun,
  mockRecordOutcome,
} = vi.hoisted(() => ({
  mockLockPendingResponse: vi.fn(),
  mockRevokeOpenLinks: vi.fn(),
  mockInsertAuditLog: vi.fn(),
  mockInsertAuditLogSession: vi.fn(),
  mockEnqueuePublish: vi.fn(),
  mockEnqueueGenerate: vi.fn(),
  mockFindActiveReviewRun: vi.fn(),
  mockRecordOutcome: vi.fn(),
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
// outcomes.ts runs REAL (its anchor statements are pinned below); only the
// run-spine writers behind it are mocked, mirroring veto.test.ts.
vi.mock('@/lib/agents/run-spine', () => ({
  findActiveReviewRun: mockFindActiveReviewRun,
  recordOutcome: mockRecordOutcome,
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

// Lock-order anchor rows (WS4 §2.8): the UNLOCKED responses pre-read, then
// the reviews FOR UPDATE — fed to approve/edit queues; regenerate takes none.
const ANCHOR_ROWS: unknown[][] = [[{ review_id: 'rev-1' }], [{ id: 'rev-1' }]];

beforeEach(() => {
  vi.clearAllMocks();
  mockLockPendingResponse.mockResolvedValue({
    response_text: 'draft text',
    original_draft_text: 'draft text',
    review_id: 'rev-1',
    version: 1,
  });
  mockFindActiveReviewRun.mockResolvedValue({ id: 'run-1', account_id: 'acct-1' });
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
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
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

  it("records exactly one 'reply_approved_no_edit' outcome attributed 'reply' on the running run", async () => {
    const { tx } = mkTx([...ANCHOR_ROWS]);
    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'corr-1');

    expect(mockFindActiveReviewRun).toHaveBeenCalledWith(tx, 'rev-1');
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(tx, {
      runId: 'run-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_approved_no_edit',
    });
  });

  it('skips the outcome when no run is running, and the approve still succeeds', async () => {
    mockFindActiveReviewRun.mockResolvedValue(null);
    const { tx } = mkTx([...ANCHOR_ROWS]);
    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'corr-1');

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).toHaveBeenCalled();
    expect(mockInsertAuditLogSession).toHaveBeenCalled();
  });

  it('takes the anchor — UNLOCKED pre-read, then reviews FOR UPDATE — BEFORE the response lock (veto.ts lock order)', async () => {
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
    let statementsBeforeResponseLock = -1;
    mockLockPendingResponse.mockImplementation(async () => {
      statementsBeforeResponseLock = calls.length;
      return {
        response_text: 'draft text',
        original_draft_text: 'draft text',
        review_id: 'rev-1',
        version: 1,
      };
    });

    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT);

    const [preRead, reviewLock] = calls;
    expect(preRead!.text).toContain('SELECT review_id FROM responses');
    expect(preRead!.text).not.toContain('FOR UPDATE');
    expect(preRead!.values).toEqual(['resp-1', 'biz-1']);
    expect(reviewLock!.text).toContain('FROM reviews');
    expect(reviewLock!.text).toContain('FOR UPDATE');
    expect(reviewLock!.values).toEqual(['rev-1', 'biz-1']);
    expect(statementsBeforeResponseLock).toBe(2);
  });

  it('propagates lock failure without enqueueing or auditing', async () => {
    mockLockPendingResponse.mockRejectedValueOnce(new Error('not pending'));
    const { tx } = mkTx([...ANCHOR_ROWS]);
    await expect(
      approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT),
    ).rejects.toThrow('not pending');
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
    expect(mockInsertAuditLogSession).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
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
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
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

  it("records exactly one 'reply_edited_by_owner' outcome, anchored before the response lock", async () => {
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
    let statementsBeforeResponseLock = -1;
    mockLockPendingResponse.mockImplementation(async () => {
      statementsBeforeResponseLock = calls.length;
      return {
        response_text: 'draft text',
        original_draft_text: 'draft text',
        review_id: 'rev-1',
        version: 1,
      };
    });

    await editBySession(tx, 'resp-1', 'biz-1', 'better text', SESSION_AUDIT, 'corr-2');

    const [preRead, reviewLock] = calls;
    expect(preRead!.text).toContain('SELECT review_id FROM responses');
    expect(preRead!.text).not.toContain('FOR UPDATE');
    expect(reviewLock!.text).toContain('FROM reviews');
    expect(reviewLock!.text).toContain('FOR UPDATE');
    expect(statementsBeforeResponseLock).toBe(2);

    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(tx, {
      runId: 'run-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_edited_by_owner',
    });
  });

  it('skips the outcome when no run is running, and the edit still succeeds', async () => {
    mockFindActiveReviewRun.mockResolvedValue(null);
    const { tx } = mkTx([...ANCHOR_ROWS]);
    await editBySession(tx, 'resp-1', 'biz-1', 'better text', SESSION_AUDIT);

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).toHaveBeenCalled();
    expect(mockInsertAuditLogSession).toHaveBeenCalled();
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
    // Regenerate is not an owner verdict: no anchor, no outcome (WS4 §2.8).
    expect(calls.some((c) => c.text.includes('FROM reviews'))).toBe(false);
    expect(mockFindActiveReviewRun).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});
