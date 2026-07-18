// Pure property tests for the reconcile rotation helpers (T1: nextCursor).
// House style: fast-check invariant coverage (mirrors sentiment.test.ts).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { nextCursor } from '../billing-reconciliation/reconcile-progress';

// A non-empty list of accounts with distinct ids, plus a dispatched count in
// [1, length] (nextCursor is only called when dispatched > 0).
const claimedRotation = fc
  .array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 })
  .map((ids) => ids.map((id, i) => ({ id: `${i}-${id}` }))) // guarantee distinct ids
  .chain((accounts) =>
    fc
      .integer({ min: 1, max: accounts.length })
      .map((dispatched) => ({ accounts, dispatched })),
  );

describe('nextCursor — keyset advance/reset invariants', () => {
  it('returns the last CLAIMED id on a partial cycle', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        fc.pre(dispatched < accounts.length); // partial only
        expect(nextCursor(dispatched, accounts)).toBe(accounts[dispatched - 1]!.id);
      }),
    );
  });

  it('returns null at rotation end (a fully-drained batch wraps to the top)', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        fc.pre(dispatched === accounts.length); // drained only
        expect(nextCursor(dispatched, accounts)).toBeNull();
      }),
    );
  });

  it('never returns an id past the claim frontier', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        const result = nextCursor(dispatched, accounts);
        if (result === null) return;
        const idx = accounts.findIndex((a) => a.id === result);
        expect(idx).toBe(dispatched - 1);
        expect(idx).toBeLessThan(accounts.length);
      }),
    );
  });
});
