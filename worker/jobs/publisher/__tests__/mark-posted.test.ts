import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the outbox enqueue so we can assert the affected-row + auto_policy
// gating without a DB. The helper passes the tx straight through.
const { mockEnqueue } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => 'outbox-1'),
}));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueAutoPostNotice: mockEnqueue,
}));

import { markPostedAndMaybeEnqueueAutoPostNotice } from '../mark-posted';
import { APPROVAL_METHOD } from '../../../../src/lib/auto-approval/types';

// A tx is a tagged-template fn; the helper only issues the one UPDATE ...
// RETURNING and reads its rows, so returning a fixed array models it.
function makeTx(updateResult: unknown[]) {
  return (async () => updateResult) as never;
}
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  mockEnqueue.mockClear();
});

describe('markPostedAndMaybeEnqueueAutoPostNotice', () => {
  it('enqueues the FYI when exactly one auto_policy row transitions to posted', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.AUTO_POLICY }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice({
      tx, responseId: 'resp-1', businessId: 'biz-1', correlationId: 'c1', logger,
    });
    expect(res).toEqual({ transitioned: true, fyiEnqueued: true });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1', businessId: 'biz-1', correlationId: 'c1',
    });
  });

  it('does NOT enqueue for an owner-approved post (the owner clicked Approve)', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice({
      tx, responseId: 'resp-1', businessId: 'biz-1', logger,
    });
    expect(res).toEqual({ transitioned: true, fyiEnqueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when ZERO rows transition (no-op / race retry — already posted)', async () => {
    const tx = makeTx([]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice({
      tx, responseId: 'resp-1', businessId: 'biz-1', logger,
    });
    expect(res).toEqual({ transitioned: false, fyiEnqueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when approval_method is null (ambiguous/legacy)', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: null }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice({
      tx, responseId: 'resp-1', businessId: 'biz-1', logger,
    });
    expect(res.fyiEnqueued).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
