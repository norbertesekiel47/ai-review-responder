import { describe, expect, it } from 'vitest';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import {
  canEdit,
  groupReplies,
  isHistorical,
  parsePageParam,
  toCardRow,
  type ReviewRow,
} from '../replies-view';

const ACTIVATED = '2026-03-01T00:00:00.000Z';

/** An unanswered review: the LEFT JOIN found no posted reply and no sidecars. */
function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    review_id: 'rev-1',
    review_text: 'Great place',
    review_date: new Date('2026-04-01T12:00:00.000Z'),
    response_id: null,
    approved_text: null,
    approval_method: null,
    posted_at: null,
    external_reply_ingested_at: null,
    review_content_hash: 'hash-1',
    version: null,
    star_rating: 5,
    reviewer_name: 'Sam',
    failed_response_id: null,
    failed_posting_error: null,
    draft_response_id: null,
    draft_held: false,
    generation_in_flight: false,
    is_orphan: false,
    orphan_failed_response_id: null,
    orphan_posting_error: null,
    superseded_text: null,
    ...overrides,
  };
}

/** A review with a live posted reply on Google. */
function answeredRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return reviewRow({
    response_id: 'resp-1',
    approved_text: 'Thank you!',
    posted_at: new Date('2026-04-01T13:00:00.000Z'),
    version: 2,
    ...overrides,
  });
}

/** An orphan: the DELETE landed, the re-POST did not, so no live reply exists. */
function orphanRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return reviewRow({
    review_id: 'orph-1',
    review_text: 'Hmm',
    review_date: new Date('2026-04-02T12:00:00.000Z'),
    star_rating: 3,
    reviewer_name: 'Lee',
    review_content_hash: 'hash-o',
    is_orphan: true,
    orphan_failed_response_id: 'fail-1',
    orphan_posting_error: 'post_after_delete_failed_x',
    superseded_text: 'old reply',
    ...overrides,
  });
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

describe('isHistorical (provenance-badge input only)', () => {
  it('treats every review as historical when the account never activated', () => {
    expect(isHistorical(new Date('2030-01-01'), null)).toBe(true);
  });

  it('is true strictly before activation', () => {
    expect(isHistorical(new Date('2026-02-28T23:59:59.999Z'), ACTIVATED)).toBe(true);
  });

  it('is FALSE exactly at activation (the boundary belongs to the subscribed period)', () => {
    expect(isHistorical(new Date(ACTIVATED), ACTIVATED)).toBe(false);
  });

  it('is false after activation', () => {
    expect(isHistorical(new Date('2026-04-01'), ACTIVATED)).toBe(false);
  });
});

describe('canEdit (strict paid-tier gate)', () => {
  it('blocks editing without a paid launch-tier entitlement', () => {
    expect(canEdit(false)).toBe(false);
  });
  it('allows editing on either paid launch tier', () => {
    expect(canEdit(true)).toBe(true);
  });
});

describe('toCardRow', () => {
  it('serializes dates to ISO and computes the paid-tier canEdit gate', () => {
    const row = toCardRow(answeredRow(), ACTIVATED, false);
    expect(row.review_date).toBe('2026-04-01T12:00:00.000Z');
    expect(row.posted_at).toBe('2026-04-01T13:00:00.000Z');
    expect(row.external_reply_ingested_at).toBeNull();
    expect(row.canEdit).toBe(false); // unsupported tier stays locked
    expect(row.version).toBe(2);
  });

  it('nulls a non-numeric version and surfaces a recoverable failed sibling', () => {
    const row = toCardRow(
      answeredRow({
        version: null,
        failed_response_id: 'fail-9',
        failed_posting_error: 'delete_failed_x',
      }),
      ACTIVATED,
      false,
    );
    expect(row.version).toBeNull();
    expect(row.failed_response_id).toBe('fail-9');
  });

  it('carries the derived row state and provenance badge the card renders', () => {
    // D-D / D-E: the card renders both, it never computes either.
    const answered = toCardRow(
      answeredRow({ approval_method: APPROVAL_METHOD.AUTO_POLICY }),
      ACTIVATED,
      true,
    );
    expect(answered.row_state).toBe('regenerate');
    expect(answered.provenance_badge).toBe('auto_approved');

    const unanswered = toCardRow(reviewRow(), ACTIVATED, true);
    expect(unanswered.row_state).toBe('generate');
    expect(unanswered.provenance_badge).toBeNull();
  });

  it('maps an orphan from the orphan_* sidecars and nulls the response-level fields', () => {
    // Round-2 Defect A: PastReplyCard offers recovery only when
    // `!!row.failed_response_id && row.posted_at === null` (PastReplyCard.tsx:157).
    const row = toCardRow(orphanRow(), ACTIVATED, true);
    expect(row.row_state).toBe('recover');
    expect(row.failed_response_id).toBe('fail-1');
    expect(row.response_id).toBe('fail-1'); // failed id, not a posted response
    expect(row.failed_posting_error).toBe('post_after_delete_failed_x');
    expect(row.approved_text).toBe('old reply');
    expect(row.posted_at).toBeNull();
    expect(row.approval_method).toBeNull();
    expect(row.version).toBeNull();
    expect(row.canEdit).toBe(true);
  });

  it('fails closed for orphan recovery on an unsupported stored tier', () => {
    expect(toCardRow(orphanRow(), ACTIVATED, false).canEdit).toBe(false);
  });
});

describe('groupReplies', () => {
  it('groups by row state — only a live posted reply is Answered — and sorts each newest-first', () => {
    const grouped = groupReplies(
      [
        answeredRow({ review_id: 'ans-old', review_date: new Date('2026-04-01') }),
        answeredRow({ review_id: 'ans-new', review_date: new Date('2026-05-01') }),
        reviewRow({ review_id: 'un-old', review_date: new Date('2026-01-15') }),
        reviewRow({ review_id: 'un-new', review_date: new Date('2026-06-01') }),
      ],
      ACTIVATED,
      false,
    );

    expect(grouped.answeredRows.map((r) => r.review_id)).toEqual(['ans-new', 'ans-old']);
    expect(grouped.unansweredRows.map((r) => r.review_id)).toEqual(['un-new', 'un-old']);
    expect([...grouped.unansweredRows, ...grouped.answeredRows].every((r) => !r.canEdit)).toBe(true);
  });

  it('groups orphan, held, draft-ready and generating rows under Unanswered', () => {
    // D-G + D9: none of these has a live Google reply, and none may offer
    // Generate — the state, not the activation boundary, decides the group.
    const grouped = groupReplies(
      [
        orphanRow({ review_id: 'orph', review_date: new Date('2026-04-04') }),
        reviewRow({ review_id: 'held', draft_response_id: 'd-1', draft_held: true, review_date: new Date('2026-04-03') }),
        reviewRow({ review_id: 'draft', draft_response_id: 'd-2', review_date: new Date('2026-04-02') }),
        reviewRow({ review_id: 'gen', generation_in_flight: true, review_date: new Date('2026-04-01') }),
      ],
      ACTIVATED,
      true,
    );

    expect(grouped.answeredRows).toHaveLength(0);
    expect(grouped.unansweredRows.map((r) => r.row_state)).toEqual([
      'recover',
      'held',
      'draft_ready',
      'generating',
    ]);
  });

  it('does not bucket on the activation boundary — a pre-activation posted reply is still Answered', () => {
    // The gap/historical split is gone: activation survives only as a badge input.
    const grouped = groupReplies(
      [answeredRow({ review_id: 'pre-activation', review_date: new Date('2026-01-15') })],
      ACTIVATED,
      false,
    );

    expect(grouped.answeredRows.map((r) => r.review_id)).toEqual(['pre-activation']);
    expect(grouped.unansweredRows).toHaveLength(0);
  });
});
