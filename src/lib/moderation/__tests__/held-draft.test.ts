// Direct unit coverage for the held-draft gate (launch-audit part1, P1 test
// gap): a typo in hasOpenFlag's status='open' predicate would silently
// release admin-held drafts to owners. Previously covered only indirectly
// via integration tests.
import { describe, it, expect } from 'vitest';
import { hasOpenFlag, HeldForReviewError } from '../held-draft';

type TxCall = { text: string; values: unknown[] };

/** Minimal tagged-template tx double — enough for hasOpenFlag's single query. */
function mkTx(rows: unknown[]) {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve(rows);
  }) as never;
  return { tx, calls };
}

const RESPONSE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('hasOpenFlag', () => {
  it('returns true when an open flag row exists', async () => {
    const { tx } = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(true);
  });

  it('returns false when no open flag exists', async () => {
    const { tx } = mkTx([]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(false);
  });

  it("filters on status = 'open' and the response id — the predicate that makes the hold binding", async () => {
    const { tx, calls } = mkTx([]);
    await hasOpenFlag(tx, RESPONSE_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("status = 'open'");
    expect(calls[0].text).toContain('FROM flagged_responses');
    expect(calls[0].values).toContain(RESPONSE_ID);
  });
});

describe('HeldForReviewError', () => {
  it('carries the held_for_review message and name', () => {
    const err = new HeldForReviewError();
    expect(err.message).toBe('held_for_review');
    expect(err.name).toBe('HeldForReviewError');
    expect(err).toBeInstanceOf(Error);
  });
});
