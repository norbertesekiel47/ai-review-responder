// src/lib/channels/__tests__/mobile-enrollment.test.ts
//
// Single owner of the mobile-channel enrollment state-machine contract,
// parameterized over channel (the Telegram and WhatsApp paths are the same
// code — only the bound channel value differs).

import { describe, it, expect } from 'vitest';
import {
  startMobileEnrollment,
  cancelMobileEnrollment,
  type MobileChannel,
} from '../mobile-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '../unique-violation';

const CHANNELS: MobileChannel[] = ['telegram', 'whatsapp'];

const TS = new Date('2026-05-22T00:00:00Z');

/** Tagged-template mock: returns queued result arrays in call order, records SQL text + bound values. */
function makeTx(results: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results.shift() ?? []);
  };
  return { tx, calls };
}

/**
 * makeTx variant where the Nth call (0-indexed) throws instead of resolving.
 * Used to simulate Postgres unique-violation errors on INSERT/UPDATE.
 */
function makeTxWithThrowAt(results: unknown[][], throwAt: number, error: unknown) {
  let callIndex = 0;
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const idx = callIndex++;
    if (idx === throwAt) return Promise.reject(error);
    return Promise.resolve(results.shift() ?? []);
  };
  return { tx, calls };
}

describe.each(CHANNELS)('startMobileEnrollment (%s)', (channel) => {
  it('inserts a pending row when none exists → ok; INSERT carries account_id + business_id + bound channel', async () => {
    const { tx, calls } = makeTx([[] /* SELECT FOR UPDATE */, [] /* INSERT */]);
    const result = await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'a'.repeat(64), TS);
    expect(result).toEqual({ kind: 'ok' });

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO channel_enrollments'))!;
    expect(insertCall).toBeDefined();
    expect(insertCall.text).toContain('account_id');
    expect(insertCall.text).toContain('business_id');
    expect(insertCall.values).toContain(channel);
    expect(insertCall.values).toContain('acct-1');
    expect(insertCall.values).toContain('biz-1');
  });

  it.each(['pending_verification', 'unsubscribed', 'disabled'])(
    'updates an existing %s row back to pending with a fresh hash → ok',
    async (status) => {
      const { tx, calls } = makeTx([[{ id: 'row-1', status }], []]);
      const result = await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'b'.repeat(64), TS);
      expect(result).toEqual({ kind: 'ok' });
      expect(calls).toHaveLength(2); // SELECT + UPDATE, no INSERT
      expect(calls[1]!.text).toContain('UPDATE channel_enrollments');
      expect(calls[1]!.text).toMatch(/status\s+= 'pending_verification'/);
      expect(calls[1]!.text).toMatch(/disabled_at\s+= NULL/);
      // Tenant scope on the UPDATE branch, pinned the way the INSERT and the
      // SELECT already pin theirs. Defense-in-depth — the row id came from the
      // account-scoped SELECT … FOR UPDATE above — but it was the one sibling
      // with no assertion at all (Pathfinder 2026-08-15 census, group F).
      expect(calls[1]!.text).toContain('account_id =');
      expect(calls[1]!.values).toContain('acct-1');
    },
  );

  it('returns already_verified without mutating when the row is verified', async () => {
    const { tx, calls } = makeTx([[{ id: 'row-1', status: 'verified' }]]);
    const result = await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'c'.repeat(64), TS);
    expect(result).toEqual({ kind: 'already_verified' });
    expect(calls).toHaveLength(1); // only the SELECT, no UPDATE/INSERT
  });

  it('SELECTs the org-default row by account_id + location_id IS NULL with FOR UPDATE and bound channel', async () => {
    const { tx, calls } = makeTx([[], []]);
    await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'd'.repeat(64), TS);
    const selectCall = calls[0]!;
    expect(selectCall.text).toContain('FOR UPDATE');
    expect(selectCall.text).toContain('account_id =');
    expect(selectCall.text).toContain('location_id IS NULL');
    expect(selectCall.text).toContain('archived_at IS NULL');
    expect(selectCall.values).toContain(channel);
  });

  it('does NOT emit pg_advisory_xact_lock SQL (caller responsibility)', async () => {
    const { tx, calls } = makeTx([[], []]);
    await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'e'.repeat(64), TS);
    expect(calls.some((c) => c.text.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it('no enroll/verify path re-enables override rows on reconnect (absence assertion)', async () => {
    // Reconnect = startMobileEnrollment, which only touches the org-default
    // (location_id IS NULL) row. It must NEVER emit an UPDATE that flips an
    // override (location_id IS NOT NULL) row back to verified/pending.
    const { tx, calls } = makeTx([[] /* SELECT */, [] /* INSERT */]);
    await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'f'.repeat(64), TS);
    expect(calls.some((c) => c.text.includes('location_id IS NOT NULL'))).toBe(false);
  });

  describe('23505 unique-violation classification', () => {
    // The SELECT FOR UPDATE is call 0; the INSERT (empty SELECT result) is call 1.

    it('throws MultipleMobileChannelsError on 23505 + one_mobile_per_scope constraint', async () => {
      const pgError = { code: '23505', constraint_name: 'channel_enrollments_one_mobile_per_scope' };
      const { tx } = makeTxWithThrowAt([], 1, pgError);
      await expect(
        startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'hash', TS),
      ).rejects.toBeInstanceOf(MultipleMobileChannelsError);
    });

    it('throws MultipleMobileChannelsError on 23505 + legacy one_mobile_per_biz constraint', async () => {
      const pgError = { code: '23505', constraint_name: 'channel_enrollments_one_mobile_per_biz' };
      const { tx } = makeTxWithThrowAt([], 1, pgError);
      await expect(
        startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'hash', TS),
      ).rejects.toBeInstanceOf(MultipleMobileChannelsError);
    });

    it('throws EnrollmentDatabaseError on 23505 + non-mobile constraint', async () => {
      const pgError = { code: '23505', constraint_name: 'channel_enrollments_account_channel_scope_uniq' };
      const { tx } = makeTxWithThrowAt([], 1, pgError);
      await expect(
        startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'hash', TS),
      ).rejects.toBeInstanceOf(EnrollmentDatabaseError);
    });

    it('rethrows non-23505 errors unchanged', async () => {
      const pgError = Object.assign(new Error('serialization failure'), { code: '40001' });
      const { tx } = makeTxWithThrowAt([], 1, pgError);
      await expect(
        startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'hash', TS),
      ).rejects.toThrow('serialization failure');
    });
  });
});

describe.each(CHANNELS)('cancelMobileEnrollment (%s)', (channel) => {
  it('returns ok when a pending row is flipped; SQL pins + bound channel', async () => {
    const { tx, calls } = makeTx([[{ id: 'row-1' }]]);
    expect(await cancelMobileEnrollment(tx, channel, 'acct-1')).toEqual({ kind: 'ok' });

    const update = calls[0]!;
    expect(update.text).toContain("status = 'disabled'");
    expect(update.text).toContain('disabled_at = NOW()');
    expect(update.text).toContain('verification_token_hash = NULL');
    expect(update.text).toContain('verification_token_expires_at = NULL');
    expect(update.text).toContain('account_id =');
    expect(update.text).toContain('location_id IS NULL');
    expect(update.text).toContain("status = 'pending_verification'");
    expect(update.text).toContain('archived_at IS NULL');
    expect(update.values).toContain(channel);
    expect(update.values).toContain('acct-1');
  });

  it('returns not_found when nothing matched', async () => {
    const { tx } = makeTx([[]]);
    expect(await cancelMobileEnrollment(tx, channel, 'acct-1')).toEqual({ kind: 'not_found' });
  });

  it('is a single statement — does NOT open sql.begin (caller owns the tx + advisory lock)', async () => {
    const { tx, calls } = makeTx([[{ id: 'row-1' }]]);
    // tx has no `begin` — if the helper called sql.begin this would throw.
    await expect(cancelMobileEnrollment(tx, channel, 'acct-1')).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('after cancel, a subsequent start on the same account succeeds (disabled → pending branch)', async () => {
    const { tx, calls } = makeTx([
      [{ id: 'row-1', status: 'disabled' }], // SELECT sees the row left by cancel
      [], // UPDATE back to pending_verification
    ]);
    const result = await startMobileEnrollment(tx, channel, 'biz-1', 'acct-1', 'g'.repeat(64), TS);
    expect(result).toEqual({ kind: 'ok' });
    expect(calls).toHaveLength(2); // SELECT + UPDATE (existing-row branch)
  });
});
