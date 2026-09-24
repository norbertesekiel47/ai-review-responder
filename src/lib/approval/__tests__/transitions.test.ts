// Direct unit coverage for transitions.ts's UPDATE owners (#1367, extended
// #1454). Pins the exact SQL text + bind values each transition emits, so a
// change to a column list surfaces here instead of only in the calling site.
import { describe, it, expect } from 'vitest';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import {
  markResponseApproved,
  markResponseEdited,
  markResponseSuperseded,
  markResponseApprovedRecovery,
  markResponseApprovedAutoPolicy,
  markResponseSupersededWithReason,
  markResponseSupersededByExternalReply,
  markResponseSupersededProviderMismatch,
} from '../transitions';

type TxCall = { text: string; values: unknown[] };

function mkTx() {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve([]);
  }) as never;
  return { tx, calls };
}

describe('markResponseApproved', () => {
  it('sets status=approved, the given method, approved_at, approved_text=response_text, clears posting_error', async () => {
    const { tx, calls } = mkTx();
    await markResponseApproved(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      method: APPROVAL_METHOD.OWNER,
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'approved'");
    expect(update!.text).toContain('approval_method');
    expect(update!.text).toContain('approved_at = NOW()');
    expect(update!.text).toContain('approved_text = response_text');
    expect(update!.text).toContain('posting_error = NULL');
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.values).toEqual(['owner', 'resp-1', 'biz-1']);
  });

  it('threads a non-owner method through unchanged (e.g. auto_policy)', async () => {
    const { tx, calls } = mkTx();
    await markResponseApproved(tx, {
      responseId: 'resp-2',
      businessId: 'biz-2',
      method: APPROVAL_METHOD.AUTO_POLICY,
    });

    expect(calls[0]!.values).toEqual(['auto_policy', 'resp-2', 'biz-2']);
  });
});

describe('markResponseEdited', () => {
  it('sets status=edited, approved_text and edited_text to the edited text, edit_distance, clears posting_error', async () => {
    const { tx, calls } = mkTx();
    await markResponseEdited(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      method: APPROVAL_METHOD.OWNER,
      editedText: 'better text',
      editDistance: 7,
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'edited'");
    expect(update!.text).toContain('approval_method');
    expect(update!.text).toContain('approved_at = NOW()');
    expect(update!.text).toContain('approved_text');
    expect(update!.text).toContain('edited_text');
    expect(update!.text).toContain('edit_distance');
    expect(update!.text).toContain('posting_error = NULL');
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.values).toEqual(['owner', 'better text', 'better text', 7, 'resp-1', 'biz-1']);
  });
});

describe('markResponseSuperseded', () => {
  it('sets status=superseded + updated_at, touches no approval/posting_error column', async () => {
    const { tx, calls } = mkTx();
    await markResponseSuperseded(tx, { responseId: 'resp-1', businessId: 'biz-1' });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'superseded'");
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.text).not.toContain('approval_method');
    expect(update!.text).not.toContain('posting_error');
    expect(update!.values).toEqual(['resp-1', 'biz-1']);
  });
});

describe('markResponseApprovedRecovery', () => {
  it('sets status=approved, caller-supplied posting_error, COALESCEd approved_text', async () => {
    const { tx, calls } = mkTx();
    await markResponseApprovedRecovery(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      method: APPROVAL_METHOD.OWNER,
      postingError: null,
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'approved'");
    expect(update!.text).toContain('posting_error');
    expect(update!.text).toContain('approval_method');
    expect(update!.text).toContain('approved_at = NOW()');
    expect(update!.text).toContain('approved_text = COALESCE(approved_text, response_text)');
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.values).toEqual([null, 'owner', 'resp-1', 'biz-1']);
  });

  it('threads a non-null posting_error through (orphan-marker re-install)', async () => {
    const { tx, calls } = mkTx();
    await markResponseApprovedRecovery(tx, {
      responseId: 'resp-2',
      businessId: 'biz-2',
      method: APPROVAL_METHOD.OWNER,
      postingError: 'pending_after_delete_succeeded',
    });

    expect(calls[0]!.values).toEqual([
      'pending_after_delete_succeeded',
      'owner',
      'resp-2',
      'biz-2',
    ]);
  });
});

describe('markResponseApprovedAutoPolicy', () => {
  it('sets status=approved, approval_method=auto_policy, auto_post_scheduled_at, guarded by pending_approval', async () => {
    const { tx, calls } = mkTx();
    await markResponseApprovedAutoPolicy(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      responseText: 'drafted text',
      vetoWindowMinutes: 30,
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'approved'");
    expect(update!.text).toContain('approval_method');
    expect(update!.text).toContain('approved_text');
    expect(update!.text).toContain('approved_at = NOW()');
    expect(update!.text).toContain('auto_post_scheduled_at');
    expect(update!.text).toContain('posting_error = NULL');
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.text).toContain("status = 'pending_approval'");
    expect(update!.text).toContain('RETURNING auto_post_scheduled_at');
    expect(update!.values).toEqual(['auto_policy', 'drafted text', 30, 'resp-1', 'biz-1']);
  });
});

describe('markResponseSupersededWithReason', () => {
  it('without guardStatus: sets status=superseded + posting_error, no status guard', async () => {
    const { tx, calls } = mkTx();
    await markResponseSupersededWithReason(tx, {
      responseId: 'resp-1',
      businessId: 'biz-1',
      postingError: 'review_content_changed_during_park',
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'superseded'");
    expect(update!.text).toContain('posting_error');
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.values).toEqual(['review_content_changed_during_park', 'resp-1', 'biz-1']);
  });

  it('with guardStatus: adds AND status = guardStatus', async () => {
    const { tx, calls } = mkTx();
    await markResponseSupersededWithReason(tx, {
      responseId: 'resp-2',
      businessId: 'biz-2',
      postingError: 'admin_dismissed_awaiting_connect',
      guardStatus: 'awaiting_owner_connect',
    });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain('AND status =');
    expect(update!.values).toEqual([
      'admin_dismissed_awaiting_connect',
      'resp-2',
      'biz-2',
      'awaiting_owner_connect',
    ]);
  });
});

describe('markResponseSupersededByExternalReply', () => {
  it('sets status=superseded, posting_error=already_replied_external, guarded by publishable-status set', async () => {
    const { tx, calls } = mkTx();
    await markResponseSupersededByExternalReply(tx, { responseId: 'resp-1', businessId: 'biz-1' });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'superseded'");
    expect(update!.text).toContain("posting_error = 'already_replied_external'");
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.text).toContain("status IN ('approved', 'edited', 'awaiting_owner_connect')");
    expect(update!.values).toEqual(['resp-1', 'biz-1']);
  });
});

describe('markResponseSupersededProviderMismatch', () => {
  it('sets status=superseded, clears approval-lane columns, guarded by the 4-status set, RETURNING 1', async () => {
    const { tx, calls } = mkTx();
    await markResponseSupersededProviderMismatch(tx, { responseId: 'resp-1', businessId: 'biz-1' });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'superseded'");
    expect(update!.text).toContain('approval_method = NULL');
    expect(update!.text).toContain('approved_text = NULL');
    expect(update!.text).toContain('approved_at = NULL');
    expect(update!.text).toContain('auto_post_scheduled_at = NULL');
    expect(update!.text).toContain("posting_error = 'already_replied_external'");
    expect(update!.text).toContain('updated_at = NOW()');
    expect(update!.text).toContain(
      "status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')",
    );
    expect(update!.text).toContain('RETURNING 1');
    expect(update!.values).toEqual(['resp-1', 'biz-1']);
  });
});
