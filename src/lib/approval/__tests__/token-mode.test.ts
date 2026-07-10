// Direct unit coverage for token-mode approve/edit/regenerate (launch-audit
// part1, P2 test gap: previously tested only indirectly via service.test.ts).
// Collaborators (locks/audit/outbox helpers) are mocked; the pure helpers
// (sanitize, levenshtein) run real.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockVerifyDevice,
  mockLockPendingResponse,
  mockConsumeLink,
  mockRevokeSiblings,
  mockInsertAuditLog,
  mockEnqueuePublish,
  mockEnqueueGenerate,
  mockFindActiveReviewRun,
  mockRecordOutcome,
} = vi.hoisted(() => ({
  mockVerifyDevice: vi.fn(),
  mockLockPendingResponse: vi.fn(),
  mockConsumeLink: vi.fn(),
  mockRevokeSiblings: vi.fn(),
  mockInsertAuditLog: vi.fn(),
  mockEnqueuePublish: vi.fn(),
  mockEnqueueGenerate: vi.fn(),
  mockFindActiveReviewRun: vi.fn(),
  mockRecordOutcome: vi.fn(),
}));

vi.mock('../locks', () => ({
  verifyDevice: mockVerifyDevice,
  lockPendingResponse: mockLockPendingResponse,
  consumeLink: mockConsumeLink,
  revokeSiblings: mockRevokeSiblings,
}));
vi.mock('../audit', () => ({
  insertAuditLog: mockInsertAuditLog,
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

import { approve, edit, regenerate } from '../token-mode';
import { EmptyEditedResponseError } from '../errors';
import type { ApprovalLink } from '../types';

type TxCall = { text: string; values: unknown[] };

function mkTx(returnQueue: unknown[][] = []) {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve(returnQueue.shift() ?? []);
  }) as never;
  return { tx, calls };
}

// Lock-order anchor rows (WS4 §2.8): the UNLOCKED responses pre-read, then
// the reviews FOR UPDATE — fed to approve/edit queues; regenerate takes none.
const ANCHOR_ROWS: unknown[][] = [[{ review_id: 'rev-1' }], [{ id: 'rev-1' }]];

const LINK: ApprovalLink = {
  id: 'link-1',
  response_id: 'resp-1',
  business_id: 'biz-1',
  token_hash: 'hash-abc',
  channel: 'email',
  expires_at: new Date('2026-12-31T00:00:00Z'),
  consumed_at: null,
  revoked_at: null,
  device_cookie_hash: 'device-hash',
  created_at: new Date('2026-06-01T00:00:00Z'),
};

const AUDIT = {
  tokenHash: 'hash-abc',
  deviceCookieHash: 'device-hash',
  ipAddress: '203.0.113.7',
};

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

describe('token-mode approve', () => {
  it('verifies device, locks BEFORE consuming, marks approved, revokes siblings, enqueues publish, audits', async () => {
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
    await approve(tx, LINK, 'device-hash', AUDIT, 'corr-1');

    expect(mockVerifyDevice).toHaveBeenCalledWith(LINK, 'device-hash');
    // Lock-before-consume ordering: a non-pending response throws inside the
    // lock, rolling back BEFORE the link is consumed — no false success.
    // (?? defaults make the assertion fail if either mock was never called.)
    const lockOrder =
      mockLockPendingResponse.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const consumeOrder = mockConsumeLink.mock.invocationCallOrder[0] ?? -1;
    expect(lockOrder).toBeLessThan(consumeOrder);
    const update = calls.find((c) => c.text.includes("status = 'approved'"));
    expect(update).toBeDefined();
    expect(update!.values).toContain('resp-1');
    expect(update!.values).toContain('biz-1');
    expect(mockRevokeSiblings).toHaveBeenCalledWith(tx, 'resp-1', 'link-1');
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'approve', AUDIT, undefined,
      { responseTextAtApproval: 'draft text' },
    );
  });

  it("records exactly one 'reply_approved_no_edit' outcome, anchored — pre-read then reviews FOR UPDATE — before the response lock", async () => {
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

    await approve(tx, LINK, 'device-hash', AUDIT, 'corr-1');

    const [preRead, reviewLock] = calls;
    expect(preRead!.text).toContain('SELECT review_id FROM responses');
    expect(preRead!.text).not.toContain('FOR UPDATE');
    expect(preRead!.values).toEqual(['resp-1', 'biz-1']);
    expect(reviewLock!.text).toContain('FROM reviews');
    expect(reviewLock!.text).toContain('FOR UPDATE');
    expect(reviewLock!.values).toEqual(['rev-1', 'biz-1']);
    expect(statementsBeforeResponseLock).toBe(2);

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
    await approve(tx, LINK, 'device-hash', AUDIT, 'corr-1');

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).toHaveBeenCalled();
    expect(mockInsertAuditLog).toHaveBeenCalled();
  });

  it('propagates lock failure WITHOUT consuming the link or enqueueing publish', async () => {
    mockLockPendingResponse.mockRejectedValueOnce(new Error('not pending'));
    const { tx } = mkTx([...ANCHOR_ROWS]);
    await expect(approve(tx, LINK, 'device-hash', AUDIT)).rejects.toThrow('not pending');
    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('propagates device verification failure before any DB work', async () => {
    mockVerifyDevice.mockImplementationOnce(() => {
      throw new Error('device mismatch');
    });
    const { tx } = mkTx();
    await expect(approve(tx, LINK, 'other-device', AUDIT)).rejects.toThrow('device mismatch');
    expect(mockLockPendingResponse).not.toHaveBeenCalled();
    expect(mockConsumeLink).not.toHaveBeenCalled();
  });
});

describe('token-mode edit', () => {
  it('rejects empty edited text before any lock or consume', async () => {
    const { tx } = mkTx();
    await expect(edit(tx, LINK, '   ', 'device-hash', AUDIT)).rejects.toThrow(
      EmptyEditedResponseError,
    );
    expect(mockLockPendingResponse).not.toHaveBeenCalled();
    expect(mockConsumeLink).not.toHaveBeenCalled();
  });

  it('stores sanitized edited text with edit distance and enqueues publish', async () => {
    const { tx, calls } = mkTx([...ANCHOR_ROWS]);
    await edit(tx, LINK, 'better text', 'device-hash', AUDIT, 'corr-2');

    const update = calls.find((c) => c.text.includes("status = 'edited'"));
    expect(update).toBeDefined();
    expect(update!.text).toContain('edit_distance');
    expect(update!.values).toContain('better text');
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      correlationId: 'corr-2',
    });
    // edit distance is recorded in the audit metadata
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      tx, 'resp-1', 'biz-1', 'edit', AUDIT,
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

    await edit(tx, LINK, 'better text', 'device-hash', AUDIT, 'corr-2');

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
    await edit(tx, LINK, 'better text', 'device-hash', AUDIT);

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).toHaveBeenCalled();
    expect(mockInsertAuditLog).toHaveBeenCalled();
  });
});

describe('token-mode regenerate', () => {
  it('supersedes the response and enqueues generate_response with version+1 (no publish)', async () => {
    const { tx, calls } = mkTx();
    await regenerate(tx, LINK, 'device-hash', AUDIT, 'corr-3');

    expect(calls.some((c) => c.text.includes("status = 'superseded'"))).toBe(true);
    expect(mockEnqueueGenerate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ reviewId: 'rev-1', businessId: 'biz-1', version: 2 }),
    );
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
    expect(mockInsertAuditLog).toHaveBeenCalledWith(tx, 'resp-1', 'biz-1', 'regenerate', AUDIT);
    // Regenerate is not an owner verdict: no anchor, no outcome (WS4 §2.8).
    expect(calls.some((c) => c.text.includes('FROM reviews'))).toBe(false);
    expect(mockFindActiveReviewRun).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});
