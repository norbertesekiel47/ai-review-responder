import { describe, it, expect } from 'vitest';
import { startWhatsAppEnrollment, disableWhatsAppEnrollment } from '../whatsapp-enrollment';

/** Tagged-template mock: returns queued result arrays in call order, records SQL text. */
function makeTx(results: unknown[][]) {
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    calls.push(strings.join('?'));
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
});

describe('disableWhatsAppEnrollment', () => {
  it('returns ok when a verified row is flipped', async () => {
    const { tx } = makeTx([[{ id: 'e1' }]]);
    expect(await disableWhatsAppEnrollment(tx, 'biz-1')).toEqual({ kind: 'ok' });
  });
  it('returns not_found when nothing matched', async () => {
    const { tx } = makeTx([[]]);
    expect(await disableWhatsAppEnrollment(tx, 'biz-1')).toEqual({ kind: 'not_found' });
  });
});
