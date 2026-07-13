// worker/jobs/publisher/__tests__/edit-publish-candidate-lost.characterization.test.ts
//
// BYTE-EXACT characterization pins for the "candidate-lost" guarded UPDATE shape
// in the edit-publisher error-disposition policy (edit-publish-errors.ts). Two
// dispositions produce this shape: the `mismatch` sub-cases (→ superseded,
// after-DELETE and no-DELETE). The 409 `matches_our_text` disposition no longer
// pins here — it routes through the shared mark-posted checkpoint (WS4 §2.9;
// covered by edit-publish.test.ts), not markCandidateOrThrow.
//
// WHY BYTE-EXACT (mirrors flip-enrollment-status.characterization.test.ts): the
// 2g-2 dedup folded the whitespace-uniform blocks into ONE fragment-composed
// helper (`markCandidateOrThrow` in edit-publish-tx.ts) that takes the SET body
// as a `tx`` fragment. These pins lock the produced SQL `.text` + bound-value
// order character-for-character so the fold is provably behavior-preserving —
// they MUST stay green both before and after the refactor.
//
// NOTE (mismatch-after-delete): that block sits one nesting level deeper
// (`if (postDeleteCommitted)`), so its SQL text carries a 2-space-deeper
// indentation than the other two and is NOT byte-compatible with the shared
// helper; its pin documents the exact current bytes and it stays inline. See the
// task 2g-2 report for the rationale.
//
// Driven through the public `handlePostError` entry with a stubbed
// `verify409InTx`, so the pins exercise the same code path production does. Uses
// the shared createMockSql() harness because it flattens nested `tx`` fragments
// into one recorded `sqlCalls[i].text`/`.values`, exactly matching how
// Postgres.js composes the helper's fragment at runtime.

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockSql, mkTaggedResult, mockWorkerLogger } from '../../../__tests__/helpers/mock-sql';
import { ZernioReplyAlreadyExistsError } from '../../../../src/lib/zernio/errors';
import type { Verify409Disposition } from '../publisher-error-handlers';
import { handlePostError, type EditPublishCatchArgs } from '../edit-publish-errors';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = createMockSql();

function baseArgs(overrides: Partial<EditPublishCatchArgs> = {}): EditPublishCatchArgs {
  return {
    responseId: 'resp-1',
    businessId: 'biz-1',
    reviewId: 'rev-1',
    approvedText: 'Thank you for your kind review!',
    zernioAccountId: 'acct-1',
    zernioLocationId: 'loc-1',
    zernioReviewId: 'zernio-rev-1',
    existingPosted: undefined,
    postDeleteCommitted: false,
    lockedIsOrphanRetry: false,
    correlationId: undefined,
    logger: mockWorkerLogger() as never,
    ...overrides,
  };
}

const stubVerify409 = (disp: Verify409Disposition) => (async () => disp) as never;

const okRow = () => mkTaggedResult([{ '?column?': 1 }]);

const SUPERSEDED_NO_DELETE_UPDATE_TEXT =
  "\n      UPDATE responses\n      SET status = 'superseded', updated_at = NOW()" +
  '\n      WHERE id = ?\n        AND business_id = ?' +
  "\n        AND status IN ('approved', 'edited', 'awaiting_owner_connect')" +
  '\n      RETURNING 1\n    ';

// One nesting level deeper (inside `if (postDeleteCommitted)`) → 2-space-deeper
// indentation. Intentionally NOT folded into the shared helper (byte-different).
const SUPERSEDED_AFTER_DELETE_UPDATE_TEXT =
  "\n        UPDATE responses\n        SET status = 'superseded', updated_at = NOW()" +
  '\n        WHERE id = ?\n          AND business_id = ?' +
  "\n          AND status IN ('approved', 'edited', 'awaiting_owner_connect')" +
  '\n        RETURNING 1\n      ';

beforeEach(() => {
  resetMockSql();
});

// The candidate-lost UPDATE is the only `UPDATE responses` carrying the tenant
// `AND business_id =` guard (the sibling supersede keys on `id` + `status`; the
// exception row is an INSERT). Find-by-content keeps the pin position-independent.
function candidateUpdate() {
  const call = sqlCalls.find(
    (c) => c.text.includes('UPDATE responses') && c.text.includes('AND business_id ='),
  );
  expect(call, 'expected exactly one candidate-lost UPDATE').toBeDefined();
  return call as NonNullable<typeof call>;
}

describe('candidate-lost guarded UPDATE — byte-exact SQL characterization', () => {
  it('409 mismatch (no DELETE) → candidate superseded UPDATE (folded into markCandidateOrThrow)', async () => {
    sqlReturnQueue.push(okRow()); // candidate superseded

    await handlePostError(
      mockSql as never,
      mockSql as never,
      new ZernioReplyAlreadyExistsError({ message: '409' }),
      baseArgs({ existingPosted: undefined, postDeleteCommitted: false }),
      stubVerify409({ disposition: 'mismatch', verifierText: 'z' }),
    );

    const update = candidateUpdate();
    expect(update.text).toBe(SUPERSEDED_NO_DELETE_UPDATE_TEXT);
    expect(update.values).toEqual(['resp-1', 'biz-1']);
  });

  it('409 mismatch (after DELETE) → candidate superseded UPDATE (stays inline, deeper indent)', async () => {
    sqlReturnQueue.push(okRow()); // sibling supersede
    sqlReturnQueue.push(okRow()); // candidate superseded
    sqlReturnQueue.push(mkTaggedResult([])); // exception insert

    await handlePostError(
      mockSql as never,
      mockSql as never,
      new ZernioReplyAlreadyExistsError({ message: '409' }),
      baseArgs({ existingPosted: { id: 'sib-1' }, postDeleteCommitted: true }),
      stubVerify409({ disposition: 'mismatch', verifierText: 'y' }),
    );

    const update = candidateUpdate();
    expect(update.text).toBe(SUPERSEDED_AFTER_DELETE_UPDATE_TEXT);
    expect(update.values).toEqual(['resp-1', 'biz-1']);
  });
});
