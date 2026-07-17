import { describe, expect, it } from 'vitest';
import {
  bucketReplies,
  canEdit,
  isHistorical,
  parsePageParam,
  toCardRow,
  toOrphanCardRow,
  type OrphanRow,
  type ReviewRow,
} from '../replies-view';

const ACTIVATED = '2026-03-01T00:00:00.000Z';

function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    review_id: 'rev-1',
    review_text: 'Great place',
    review_date: new Date('2026-04-01T12:00:00.000Z'),
    response_id: 'resp-1',
    approved_text: 'Thank you!',
    approval_method: null,
    posted_at: new Date('2026-04-01T13:00:00.000Z'),
    external_reply_ingested_at: null,
    review_content_hash: 'hash-1',
    version: 2,
    star_rating: 5,
    reviewer_name: 'Sam',
    failed_response_id: null,
    failed_posting_error: null,
    ...overrides,
  };
}

function orphanRow(overrides: Partial<OrphanRow> = {}): OrphanRow {
  return {
    review_id: 'orph-1',
    review_text: 'Hmm',
    review_date: new Date('2026-04-02T12:00:00.000Z'),
    star_rating: 3,
    reviewer_name: 'Lee',
    review_content_hash: 'hash-o',
    failed_response_id: 'fail-1',
    failed_posting_error: 'post_after_delete_failed_x',
    superseded_text: 'old reply',
    ...overrides,
  };
}

describe('parsePageParam', () => {
  it.each([
    ['undefined', undefined, 1],
    ['empty', '', 1],
    ['zero', '0', 1],
    ['negative', '-5', 1],
    ['non-numeric', 'abc', 1],
    ['valid', '3', 3],
    ['float truncates', '2.9', 2],
    ['leading number', '4xyz', 4],
  ])('%s → %i', (_label, raw, expected) => {
    expect(parsePageParam(raw)).toBe(expected);
  });
});

describe('isHistorical (C-2 predicate)', () => {
  it('treats every review as historical when the account never activated', () => {
    expect(isHistorical(new Date('2030-01-01'), null)).toBe(true);
  });

  it('is true strictly before activation', () => {
    expect(isHistorical(new Date('2026-02-28T23:59:59.999Z'), ACTIVATED)).toBe(true);
  });

  it('is FALSE exactly at activation (boundary belongs to the gap)', () => {
    expect(isHistorical(new Date(ACTIVATED), ACTIVATED)).toBe(false);
  });

  it('is false after activation', () => {
    expect(isHistorical(new Date('2026-04-01'), ACTIVATED)).toBe(false);
  });
});

describe('canEdit (= NOT historical OR paid launch tier)', () => {
  it('blocks editing historical replies without a paid launch-tier entitlement', () => {
    expect(canEdit(false)).toBe(false);
  });
  it('allows editing historical replies on either paid launch tier', () => {
    expect(canEdit(true)).toBe(true);
  });
  it('fails closed for a gap reply without a paid launch-tier entitlement', () => {
    expect(canEdit(false)).toBe(false);
  });
});

describe('toCardRow', () => {
  it('serializes dates to ISO and computes the C-2 canEdit gate', () => {
    const row = toCardRow(reviewRow(), ACTIVATED, false);
    expect(row.review_date).toBe('2026-04-01T12:00:00.000Z');
    expect(row.posted_at).toBe('2026-04-01T13:00:00.000Z');
    expect(row.external_reply_ingested_at).toBeNull();
    expect(row.canEdit).toBe(false); // unsupported tier stays locked even in the gap
    expect(row.version).toBe(2);
  });

  it('nulls a non-numeric version and surfaces a recoverable failed sibling', () => {
    const row = toCardRow(
      reviewRow({ version: null, failed_response_id: 'fail-9', failed_posting_error: 'delete_failed_x' }),
      ACTIVATED,
      false,
    );
    expect(row.version).toBeNull();
    expect(row.failed_response_id).toBe('fail-9');
  });
});

describe('toOrphanCardRow', () => {
  it('keys on the failed response id, carries superseded text, and permits a paid tier', () => {
    const row = toOrphanCardRow(orphanRow(), true);
    expect(row.response_id).toBe('fail-1'); // failed id, not a posted response
    expect(row.approved_text).toBe('old reply');
    expect(row.posted_at).toBeNull();
    expect(row.canEdit).toBe(true);
  });

  it('fails closed for orphan recovery on an unsupported stored tier', () => {
    expect(toOrphanCardRow(orphanRow(), false).canEdit).toBe(false);
  });
});

describe('bucketReplies', () => {
  it('splits by the historical predicate, sorts newest-first, and counts orphans separately', () => {
    const rows = [
      reviewRow({ review_id: 'gap-old', response_id: 'r-a', review_date: new Date('2026-04-01') }),
      reviewRow({ review_id: 'gap-new', response_id: 'r-b', review_date: new Date('2026-05-01') }),
      reviewRow({ review_id: 'hist', response_id: 'r-c', review_date: new Date('2026-01-15') }),
    ];
    const orphans = [
      orphanRow({ review_id: 'orph-gap', failed_response_id: 'f-gap', review_date: new Date('2026-04-15') }),
      orphanRow({ review_id: 'orph-hist', failed_response_id: 'f-hist', review_date: new Date('2026-02-01') }),
    ];

    const result = bucketReplies(rows, orphans, ACTIVATED, false);

    // Gap section: 2 posted + 1 orphan, newest-first.
    expect(result.gapRows.map((r) => r.review_id)).toEqual(['gap-new', 'orph-gap', 'gap-old']);
    // Historical section: 1 posted (pre-activation) + 1 orphan.
    expect(result.histRows.map((r) => r.review_id)).toEqual(['orph-hist', 'hist']);
    expect([...result.gapRows, ...result.histRows].every((r) => !r.canEdit)).toBe(true);
    expect(result.orphanGapCount).toBe(1);
    expect(result.orphanHistCount).toBe(1);
  });

  it('puts every posted row in the historical bucket when the account never activated', () => {
    const result = bucketReplies([reviewRow()], [], null, false);
    expect(result.gapRows).toHaveLength(0);
    expect(result.histRows).toHaveLength(1);
  });
});
