// Direct unit coverage for the transitions.ts UPDATE owners (#1367): each
// mode (token/session/callback) used to hand-copy the same status/
// approval_method/approved_at/approved_text/posting_error column list.
// These tests pin the exact SQL + bind values each transition emits so a
// future edit to one mode's copy would have shown up here first.
import { describe, it, expect } from 'vitest';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { markResponseApproved, markResponseEdited, markResponseSuperseded } from '../transitions';

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
    expect(update!.values).toEqual(['owner', 'better text', 'better text', 7, 'resp-1', 'biz-1']);
  });
});

describe('markResponseSuperseded', () => {
  it('sets status=superseded and touches no other column', async () => {
    const { tx, calls } = mkTx();
    await markResponseSuperseded(tx, { responseId: 'resp-1', businessId: 'biz-1' });

    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update!.text).toContain("status = 'superseded'");
    expect(update!.text).not.toContain('approval_method');
    expect(update!.text).not.toContain('posting_error');
    expect(update!.values).toEqual(['resp-1', 'biz-1']);
  });
});
