import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import {
  canEdit,
  deriveAxes,
  deriveRowAction,
  groupReplies,
  isHistorical,
  parsePageParam,
  toCardRow,
  type DraftState,
  type ReplyState,
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

const REPLY_STATES = ['none', 'posted', 'orphan'] as const;
const DRAFT_STATES = ['none', 'generating', 'ready', 'held'] as const;
const ROW_ACTIONS = [
  'generate', 'generating', 'draft_ready', 'regenerate', 'recover', 'none',
] as const;
// Every action that would surface or spend a draft. 'recover' is deliberately
// absent: it addresses the orphan incident, not the draft (#723 table).
const DRAFT_AFFORDANCES = ['generate', 'generating', 'draft_ready', 'regenerate'] as const;

/** Derivation facts that produce exactly the (reply, draft) cell. */
function factsFor(reply: ReplyState, draft: DraftState) {
  return {
    response_id: reply === 'posted' ? 'resp-1' : null,
    is_orphan: reply === 'orphan',
    draft_response_id: draft === 'ready' || draft === 'held' ? 'draft-1' : null,
    draft_held: draft === 'held',
    generation_in_flight: draft === 'generating',
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
    expect(answered.reply_state).toBe('posted');
    expect(answered.row_action).toBe('regenerate');
    expect(answered.provenance_badge).toBe('auto_approved');

    const unanswered = toCardRow(reviewRow(), ACTIVATED, true);
    expect(unanswered.reply_state).toBe('none');
    expect(unanswered.row_action).toBe('generate');
    expect(unanswered.provenance_badge).toBeNull();
  });

  it('maps an orphan from the orphan_* sidecars and nulls the response-level fields', () => {
    // Round-2 Defect A: PastReplyCard offers recovery only when
    // `!!row.failed_response_id && row.posted_at === null` (PastReplyCard.tsx:157).
    const row = toCardRow(orphanRow(), ACTIVATED, true);
    expect(row.reply_state).toBe('orphan');
    expect(row.row_action).toBe('recover');
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

  // ── #731 item 1: the orphan/live reply-facts split ──────────────────────────
  //
  // These six titles are the contract the split must preserve. They go through
  // `toCardRow` — the module's interface — and never reach the two private
  // mappers directly: testing past the interface would pin the refactor's
  // shape instead of its behaviour.

  it('toCardRow maps an orphan row from the orphan_* LATERALs and never from resp.*', () => {
    // resp.* is populated with sentinels an orphan must NOT surface. In
    // production `is_orphan` already encodes `resp.id IS NULL` (load-replies
    // F3), so this row is impossible; it is constructed precisely so a mapper
    // that reads the wrong side fails loudly rather than coincidentally.
    const card = toCardRow(
      orphanRow({
        response_id: 'LIVE-resp-must-not-leak',
        approved_text: 'LIVE-text-must-not-leak',
        approval_method: APPROVAL_METHOD.OWNER,
        posted_at: new Date('2026-04-03T10:00:00.000Z'),
        version: 9,
        failed_response_id: 'SIDECAR-must-not-leak',
        failed_posting_error: 'delete_failed_must_not_leak',
      }),
      ACTIVATED,
      true,
    );

    expect(card.reply_state).toBe('orphan');
    // Every field comes from the orphan_* side.
    expect(card.response_id).toBe('fail-1');
    expect(card.approved_text).toBe('old reply');
    expect(card.failed_response_id).toBe('fail-1');
    expect(card.failed_posting_error).toBe('post_after_delete_failed_x');
    // ...and nothing from resp.* or fail_sidecar leaks through.
    expect(JSON.stringify(card)).not.toContain('must-not-leak');
  });

  it('toCardRow keeps failed_response_id populated on an orphan row so recovery stays reachable', () => {
    // #678 round-2 Defect A: the deleted `toOrphanCardRow` dropped this field,
    // and because AnsweredControls + RecoveryControl gate the recovery ACTIONS
    // on it (not on the badge), recovery went silently unreachable. This is the
    // regression pin for re-splitting the function.
    const card = toCardRow(orphanRow(), ACTIVATED, true);

    expect(card.failed_response_id).toBe('fail-1');
    expect(card.failed_response_id).not.toBeNull();
    expect(card.row_action).toBe('recover');
  });

  it('toCardRow maps a posted row from resp.* and still carries its own delete_failed_* sidecar', () => {
    const card = toCardRow(
      answeredRow({
        failed_response_id: 'sidecar-1',
        failed_posting_error: 'delete_failed_transient',
      }),
      ACTIVATED,
      true,
    );

    expect(card.reply_state).toBe('posted');
    expect(card.response_id).toBe('resp-1');
    expect(card.approved_text).toBe('Thank you!');
    expect(card.posted_at).toBe('2026-04-01T13:00:00.000Z');
    expect(card.version).toBe(2);
    // The sidecar badge on a still-live Google reply — NOT an orphan marker.
    expect(card.failed_response_id).toBe('sidecar-1');
    expect(card.failed_posting_error).toBe('delete_failed_transient');
  });

  it('toCardRow nulls posted_at, approval_method and version on an orphan row', () => {
    const card = toCardRow(
      orphanRow({
        posted_at: new Date('2026-04-03T10:00:00.000Z'),
        approval_method: APPROVAL_METHOD.AUTO_POLICY,
        version: 4,
      }),
      ACTIVATED,
      true,
    );

    // An orphan has no live posted reply, so there is no posting time, no
    // approval provenance and no optimistic-concurrency version to offer.
    expect(card.posted_at).toBeNull();
    expect(card.approval_method).toBeNull();
    expect(card.version).toBeNull();
  });

  it('toCardRow derives provenance_badge from the dispatched approval_method, not the raw row', () => {
    const card = toCardRow(
      orphanRow({ approval_method: APPROVAL_METHOD.AUTO_POLICY }),
      ACTIVATED,
      true,
    );

    // Reading r.approval_method here would badge an orphan `auto_approved` for
    // a reply that is not on Google at all.
    expect(card.approval_method).toBeNull();
    expect(card.provenance_badge).toBeNull();
  });

  it('toCardRow maps a never-replied row with no reply facts and no recovery affordance', () => {
    const card = toCardRow(reviewRow(), ACTIVATED, true);

    expect(card.reply_state).toBe('none');
    expect(card.row_action).toBe('generate');
    // response_id null IS the unanswered predicate (the LEFT JOIN found nothing).
    expect(card.response_id).toBeNull();
    expect(card.approved_text).toBeNull();
    expect(card.approval_method).toBeNull();
    expect(card.posted_at).toBeNull();
    expect(card.version).toBeNull();
    expect(card.failed_response_id).toBeNull();
    expect(card.failed_posting_error).toBeNull();
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
    // The held row projects the withdrawn Action slot ('none') — a held draft
    // never projects an affordance of its own (invariant #4).
    expect(grouped.unansweredRows.map((r) => r.row_action)).toEqual([
      'recover',
      'none',
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

describe('the two-axis model invariants (#727)', () => {
  const anyReply = fc.constantFrom(...REPLY_STATES);

  it('never offers a draft affordance for a held draft in any reply state (invariant #4)', () => {
    fc.assert(
      fc.property(anyReply, (reply) => {
        const action = deriveRowAction(reply, 'held');
        expect(DRAFT_AFFORDANCES).not.toContain(action);
        expect(action).toBe(reply === 'orphan' ? 'recover' : 'none');
      }),
    );
  });

  it('derives a defined action for every cell of the 3x4 cross-product', () => {
    for (const reply of REPLY_STATES) {
      for (const draft of DRAFT_STATES) {
        expect(ROW_ACTIONS).toContain(deriveRowAction(reply, draft));
      }
    }
  });
});

describe('deriveAxes (#727)', () => {
  it('maps every cell of the 3x4 cross-product onto the two axes', () => {
    for (const reply of REPLY_STATES) {
      for (const draft of DRAFT_STATES) {
        expect(deriveAxes(factsFor(reply, draft))).toEqual({ reply, draft });
      }
    }
  });

  it('a settled ready or held response outranks an in-flight generation', () => {
    // draft_response_id + generation_in_flight can coexist (the outbox row has
    // not been reaped yet) — the settled response row is the fact that wins.
    expect(deriveAxes({ ...factsFor('none', 'ready'), generation_in_flight: true }).draft).toBe('ready');
    expect(deriveAxes({ ...factsFor('none', 'held'), generation_in_flight: true }).draft).toBe('held');
    expect(deriveAxes({ ...factsFor('posted', 'held'), generation_in_flight: true }).draft).toBe('held');
    expect(deriveAxes({ ...factsFor('orphan', 'ready'), generation_in_flight: true }).draft).toBe('ready');
  });
});

describe('deriveRowAction cells (#727)', () => {
  it('withdraws Regenerate from an answered row whose replacement draft is moderation-held (posted x held)', () => {
    expect(deriveRowAction('posted', 'held')).toBe('none');
  });

  it('keeps Regenerate for an answered row with a pending or in-flight replacement (posted x ready, posted x generating)', () => {
    expect(deriveRowAction('posted', 'none')).toBe('regenerate');
    expect(deriveRowAction('posted', 'ready')).toBe('regenerate');
    expect(deriveRowAction('posted', 'generating')).toBe('regenerate');
  });

  it('dominates recovery over every draft state on an orphan row', () => {
    for (const draft of DRAFT_STATES) {
      expect(deriveRowAction('orphan', draft)).toBe('recover');
    }
  });
});

it('groups by the posted-reply axis — the Answered set is exactly the rows with a live posted reply', () => {
  // ALL 12 cells, so a predicate that wrongly ejects posted×generating or
  // posted×ready from Answered — or admits a none/orphan cell — fails here.
  const rows = REPLY_STATES.flatMap((reply) =>
    DRAFT_STATES.map((draft) =>
      reviewRow({
        review_id: `r-${reply}-${draft}`,
        ...factsFor(reply, draft),
        orphan_failed_response_id: reply === 'orphan' ? 'f-1' : null,
      }),
    ),
  );
  const { unansweredRows, answeredRows } = groupReplies(rows, null, true);
  expect(answeredRows.map((r) => r.review_id).sort()).toEqual(
    DRAFT_STATES.map((d) => `r-posted-${d}`).sort(),
  );
  expect(unansweredRows).toHaveLength(8);
  expect(answeredRows.length + unansweredRows.length).toBe(12);
});

it('never carries draft state or held onto the wire shape', () => {
  const LIVE_TEXT = 'live posted reply text';
  const card = toCardRow(
    reviewRow({
      response_id: 'resp-1',
      approved_text: LIVE_TEXT,
      draft_response_id: 'd-1',
      draft_held: true,
    }),
    null,
    true,
  );
  // EXACT allowlist, not a blacklist: any new wire key — an alias like
  // `has_held_draft`, a nested draft object — fails until deliberately added
  // here. The old six-valued enum is deleted (#727 Task 3): the wire carries
  // only the Posted-reply axis and the Action slot, so held-ness is
  // structurally unrepresentable on this shape.
  expect(Object.keys(card).sort()).toEqual(
    [
      'approval_method', 'approved_text', 'canEdit', 'external_reply_ingested_at',
      'failed_posting_error', 'failed_response_id', 'posted_at',
      'provenance_badge', 'reply_state', 'response_id', 'review_content_hash',
      'review_date', 'review_id', 'review_text', 'reviewer_name', 'row_action',
      'star_rating', 'version',
    ],
  );
  // The value surface: the LIVE reply is what crosses. (The held draft's TEXT
  // structurally cannot appear here — ReviewRow never selects it; the
  // serialized-value pin lives in the integration suite where the text exists.)
  expect(card.approved_text).toBe(LIVE_TEXT);
});
