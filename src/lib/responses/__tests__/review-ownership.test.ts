import { describe, expect, it } from 'vitest';
import { proveReviewOwnership } from '../review-ownership';

describe('proveReviewOwnership', () => {
  it('returns a business only for an active location owned by the account', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve([{ business_id: 'business-1' }]);
    }) as never;

    await expect(proveReviewOwnership(db, 'review-1', 'account-1')).resolves.toBe('business-1');
    expect(calls[0]?.text).toContain('JOIN businesses b ON b.id = rv.business_id');
    expect(calls[0]?.text).toContain('b.account_id = ?::uuid');
    expect(calls[0]?.text).toContain('b.archived_at IS NULL');
  });

  it('returns null when the ownership query finds no row', async () => {
    const db = (() => Promise.resolve([])) as never;
    await expect(proveReviewOwnership(db, 'review-1', 'account-1')).resolves.toBeNull();
  });
});
