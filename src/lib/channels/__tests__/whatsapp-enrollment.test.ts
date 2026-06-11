import { describe, it, expect } from 'vitest';
import { startWhatsAppEnrollment, cancelWhatsAppEnrollment } from '../whatsapp-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '../unique-violation';

/** Tagged-template mock: returns queued result arrays in call order, records SQL text. */
function makeTx(results: unknown[][]) {
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    calls.push(strings.join('?'));
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
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    calls.push(strings.join('?'));
    const idx = callIndex++;
    if (idx === throwAt) return Promise.reject(error);
    return Promise.resolve(results.shift() ?? []);
  };
  return { tx, calls };
}

const TS = new Date('2026-05-22T00:00:00Z');

describe('startWhatsAppEnrollment', () => {
  it('inserts a pending row when none exists → ok', async () => {
    const { tx, calls } = makeTx([[] /* SELECT FOR UPDATE */, [] /* INSERT */]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'ok' });
    expect(calls.some((c) => c.includes('INSERT INTO channel_enrollments'))).toBe(true);
    // INSERT must write both business_id and account_id
    const insertCall = calls.find((c) => c.includes('INSERT INTO channel_enrollments'))!;
    expect(insertCall).toContain('business_id');
    expect(insertCall).toContain('account_id');
  });

  it('returns already_verified when a verified row exists', async () => {
    const { tx } = makeTx([[{ id: 'e1', status: 'verified' }]]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'already_verified' });
  });

  it('updates an existing pending row → ok', async () => {
    const { tx, calls } = makeTx([[{ id: 'e1', status: 'pending_verification' }], []]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'ok' });
    expect(calls.some((c) => c.includes('UPDATE channel_enrollments'))).toBe(true);
  });

  it('SELECT uses account_id + location_id IS NULL predicate', async () => {
    const { tx, calls } = makeTx([[], []]);
    await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    const selectCall = calls[0];
    expect(selectCall).toContain('account_id');
    expect(selectCall).toContain('location_id IS NULL');
  });
});

describe('startWhatsAppEnrollment — 23505 unique-violation classification', () => {
  // The SELECT FOR UPDATE is call 0; the INSERT or UPDATE is call 1.
  // We pass an empty SELECT result so the code takes the INSERT branch (call index 1).

  it('throws MultipleMobileChannelsError on 23505 + one_mobile_per_scope constraint', async () => {
    const pgError = { code: '23505', constraint_name: 'channel_enrollments_one_mobile_per_scope' };
    // SELECT returns [] → no existing row → INSERT path → INSERT throws (call index 1).
    const { tx } = makeTxWithThrowAt([], 1, pgError);
    await expect(
      startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS),
    ).rejects.toBeInstanceOf(MultipleMobileChannelsError);
  });

  it('throws MultipleMobileChannelsError on 23505 + legacy one_mobile_per_biz constraint', async () => {
    const pgError = { code: '23505', constraint_name: 'channel_enrollments_one_mobile_per_biz' };
    const { tx } = makeTxWithThrowAt([], 1, pgError);
    await expect(
      startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS),
    ).rejects.toBeInstanceOf(MultipleMobileChannelsError);
  });

  it('throws EnrollmentDatabaseError on 23505 + non-mobile constraint', async () => {
    const pgError = { code: '23505', constraint_name: 'channel_enrollments_account_channel_scope_uniq' };
    const { tx } = makeTxWithThrowAt([], 1, pgError);
    await expect(
      startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS),
    ).rejects.toBeInstanceOf(EnrollmentDatabaseError);
  });
});

describe('cancelWhatsAppEnrollment', () => {
  it('returns ok when a pending row is flipped', async () => {
    const { tx, calls } = makeTx([[{ id: 'e1' }]]);
    expect(await cancelWhatsAppEnrollment(tx, 'acct-1')).toEqual({ kind: 'ok' });
    const sql = calls[0];
    expect(sql).toContain('account_id');
    expect(sql).toContain('location_id IS NULL');
    expect(sql).toContain('channel');
    expect(sql).toContain('pending_verification');
    expect(sql).toContain('archived_at IS NULL');
  });
  it('returns not_found when nothing matched', async () => {
    const { tx } = makeTx([[]]);
    expect(await cancelWhatsAppEnrollment(tx, 'acct-1')).toEqual({ kind: 'not_found' });
  });
});
