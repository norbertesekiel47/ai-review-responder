// @vitest-environment jsdom
//
// src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx
//
// T1 EVAL suite for #678 — the **Reviews list** surface.
//
// D-D: the card RENDERS what the server derived; it never computes anything.
// Since #727 the row carries two typed facts — the Posted-reply axis
// (`reply_state`), which owns grouping and which reply panel renders, and the
// Action slot (`row_action`), the single affordance the card renders — both
// derived once in `replies-view.ts`, which is where the invariant-adjacent
// risk sits. These titles pin what each cell looks like.
//
// Prop shapes pinned here (Task 7 must match): the card takes the typed
// `reply_state` + `row_action` on the row plus an OPTIONAL `regenBudget` —
// optional because "no entry in the budget map" must mean UNKNOWN, never
// "0 remaining" (F6). The client takes a plain `regenBudgets` RECORD, not a
// Map: it crosses the server→client boundary and a Map does not serialize.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { PastReplyCard } from '@/components/dashboard/reviews/PastReplyCard';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { PastRepliesClient } from '@/app/(authenticated)/dashboard/reviews/history/PastRepliesClient';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import {
  toCardRow,
  type DraftState,
  type ReplyState,
  type ReviewRow,
  type RowAction,
} from '@/lib/past-replies/replies-view';

interface ListRow extends PastReplyRow {
  provenance_badge?: string | null;
}

function makeRow(overrides: Partial<ListRow> = {}): ListRow {
  return {
    review_id: 'review-1',
    review_text: 'Great food!',
    review_date: '2026-04-01T10:00:00Z',
    reviewer_name: 'Jordan',
    star_rating: 5,
    response_id: 'response-1',
    approved_text: null,
    approval_method: null,
    posted_at: null,
    external_reply_ingested_at: null,
    review_content_hash: 'hash-abc',
    version: null,
    canEdit: true,
    failed_response_id: null,
    failed_posting_error: null,
    reply_state: 'none',
    row_action: 'generate',
    provenance_badge: null,
    ...overrides,
  };
}

function answeredRow(overrides: Partial<ListRow> = {}): ListRow {
  return makeRow({
    reply_state: 'posted',
    row_action: 'regenerate',
    approved_text: 'Thank you for visiting!',
    approval_method: APPROVAL_METHOD.OWNER,
    posted_at: '2026-04-02T10:00:00Z',
    version: 1,
    provenance_badge: 'owner_approved',
    ...overrides,
  });
}

afterEach(() => {
  delete process.env.PAST_REPLIES_VIEW_ENABLED;
});

// ── Per-row affordances ──────────────────────────────────────────────────────

describe('PastReplyCard row states', () => {
  it('PastReplyCard renders Generate for a never-replied review', () => {
    render(<PastReplyCard row={makeRow()} isImported={false} />);

    expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
  });

  it('PastReplyCard renders Regenerate with the remaining regeneration count for an answered review', () => {
    render(
      <PastReplyCard
        row={answeredRow()}
        isImported={false}
        editRepliesEnabled
        regenBudget={{ used: 1, limit: 3, remaining: 2 }}
      />,
    );

    const button = screen.getByRole('button', { name: /regenerate/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(screen.getByText(/1 of 3 today/i)).toBeInTheDocument();
  });

  it('PastReplyCard disables Regenerate at three of three today', () => {
    render(
      <PastReplyCard
        row={answeredRow()}
        isImported={false}
        editRepliesEnabled
        regenBudget={{ used: 3, limit: 3, remaining: 0 }}
      />,
    );

    expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
    expect(screen.getByText(/3 of 3 today/i)).toBeInTheDocument();
  });

  it('PastReplyCard leaves Regenerate enabled and hides the counter when the budget map has no entry', () => {
    // F6: a missing entry means UNKNOWN, never 0 remaining. Inverting this would
    // disable every Regenerate button during an Upstash outage — the batched
    // peek fails open to an EMPTY map precisely so nothing is disabled.
    render(
      <PastReplyCard row={answeredRow()} isImported={false} editRepliesEnabled />,
    );

    expect(screen.getByRole('button', { name: /regenerate/i })).toBeEnabled();
    expect(screen.queryByText(/of 3 today/i)).not.toBeInTheDocument();
  });

  it('PastReplyCard renders a Draft ready cross-link and no Generate for a review with a pending draft', () => {
    // S2: the review appears in BOTH surfaces — here as a cross-link to the
    // Needs Action queue, never as a second LLM spend the partial unique index
    // (023+026+029) would reject.
    render(
      <PastReplyCard
        row={makeRow({ reply_state: 'none', row_action: 'draft_ready', response_id: 'draft-1' })}
        isImported={false}
      />,
    );

    const link = screen.getByRole('link', { name: /draft ready/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/dashboard/reviews'));
    expect(screen.queryByRole('button', { name: /^generate$/i })).not.toBeInTheDocument();
  });

  it('keeps the live posted reply and provenance badge visible for an answered row with a held replacement draft', () => {
    // posted×held: the live reply the owner is entitled to see stays visible;
    // only the Action slot is withdrawn.
    render(
      <PastReplyCard
        row={answeredRow({ row_action: 'none' })}
        isImported={false}
        editRepliesEnabled
      />,
    );

    expect(screen.getByText('Thank you for visiting!')).toBeInTheDocument();
    expect(screen.getByText('You approved')).toBeInTheDocument();
  });

  it('renders no Regenerate button, no counter, and no held indication for an answered row with a held replacement draft', () => {
    // posted×held: the withdrawal is SILENT (invariant #4) — no button, no
    // counter, no lock, no held indication. Explaining the hold would be the
    // notification the invariant forbids: held, not notified.
    const first = render(
      <PastReplyCard
        row={answeredRow({ row_action: 'none' })}
        isImported={false}
        editRepliesEnabled
        regenBudget={{ used: 1, limit: 3, remaining: 2 }}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument(); // NO buttons of ANY name
    expect(screen.queryByText(/of 3 today/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reply on hold/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/under review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();

    first.unmount();

    // Same cell, canEdit=false and no budget — the lock must not resurrect.
    render(
      <PastReplyCard
        row={answeredRow({ row_action: 'none', canEdit: false })}
        isImported={false}
        editRepliesEnabled
      />,
    );

    expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the live posted reply with Regenerate for an answered row without a held replacement draft', () => {
    // The posted×(none|generating|ready) baseline the silent withdrawal is
    // measured against.
    render(
      <PastReplyCard row={answeredRow()} isImported={false} editRepliesEnabled />,
    );

    expect(screen.getByText('Thank you for visiting!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('renders the held panel with no draft text and no affordance for an unanswered review with a held draft', () => {
    // none×held: today's held posture, reconstructed from the two wire fields
    // (none, none) — the held value itself never crosses the wire. No draft
    // text, no affordance, no cross-link; the owner's only path back is an
    // admin disposition at /admin/flagged.
    render(
      <PastReplyCard
        row={makeRow({ row_action: 'none', response_id: null, approved_text: null })}
        isImported={false}
      />,
    );

    expect(screen.getByText(/reply on hold/i)).toBeInTheDocument();
    expect(screen.getByText(/under review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /draft ready/i })).not.toBeInTheDocument();
  });

  // ── The 3x4 cross-product oracle ───────────────────────────────────────────

  /**
   * Derivation facts that produce exactly the (reply, draft) cell — a local
   * duplicate of the model suite's 10-line builder (replies-view.test.ts), not
   * a cross-test-file import.
   */
  function factsFor(reply: ReplyState, draft: DraftState) {
    return {
      response_id: reply === 'posted' ? 'resp-1' : null,
      is_orphan: reply === 'orphan',
      draft_response_id: draft === 'ready' || draft === 'held' ? 'draft-1' : null,
      draft_held: draft === 'held',
      generation_in_flight: draft === 'generating',
    };
  }

  /** Completes the remaining `ReviewRow` fields around the derivation facts. */
  function buildReviewRow(facts: ReturnType<typeof factsFor>): ReviewRow {
    return {
      review_id: 'rev-cell',
      review_text: 'Cross-product review',
      review_date: new Date('2026-04-01T12:00:00.000Z'),
      approved_text: facts.response_id !== null ? 'Live posted reply' : null,
      approval_method: null,
      posted_at: facts.response_id !== null ? new Date('2026-04-02T12:00:00.000Z') : null,
      external_reply_ingested_at: null,
      review_content_hash: 'hash-cell',
      version: facts.response_id !== null ? 1 : null,
      star_rating: 4,
      reviewer_name: 'Casey',
      failed_response_id: null,
      failed_posting_error: null,
      orphan_failed_response_id: facts.is_orphan ? 'fail-cell' : null,
      orphan_posting_error: facts.is_orphan ? 'post_after_delete_failed_x' : null,
      superseded_text: facts.is_orphan ? 'superseded reply' : null,
      ...facts,
    };
  }

  /** Proves the given affordance — and ONLY it — rendered. */
  function assertOnlyAffordance(action: RowAction) {
    switch (action) {
      case 'generate':
        // The InlineGeneratePanel Generate button, and nothing else. Anchored
        // matcher: /generate/i would also match "Regenerate".
        expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        break;
      case 'generating':
        // The in-flight indicator, no actionable Generate.
        expect(screen.getByRole('status')).toHaveTextContent(/generating/i);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        break;
      case 'draft_ready':
        // The Needs Action cross-link, no button.
        expect(screen.getByRole('link', { name: /draft ready/i })).toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        break;
      case 'regenerate':
        expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        break;
      case 'recover':
        expect(screen.getByRole('button', { name: /needs attention/i })).toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        break;
      case 'none':
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        break;
      default: {
        const unreachable: never = action;
        throw new Error(`unhandled action: ${String(unreachable)}`);
      }
    }
  }

  it('renders the locked presentation for every cell of the 3x4 cross-product', () => {
    // The end-to-end oracle: raw facts → toCardRow → render → the sole
    // permitted affordance.
    const CELLS: Array<[ReplyState, DraftState, RowAction]> = [
      ['none', 'none', 'generate'],
      ['none', 'generating', 'generating'],
      ['none', 'ready', 'draft_ready'],
      ['none', 'held', 'none'],
      ['posted', 'none', 'regenerate'],
      ['posted', 'generating', 'regenerate'],
      ['posted', 'ready', 'regenerate'],
      ['posted', 'held', 'none'],
      ['orphan', 'none', 'recover'],
      ['orphan', 'generating', 'recover'],
      ['orphan', 'ready', 'recover'],
      ['orphan', 'held', 'recover'],
    ];
    for (const [reply, draft, action] of CELLS) {
      const row = toCardRow(buildReviewRow(factsFor(reply, draft)), null, true);
      expect(row.reply_state).toBe(reply);
      expect(row.row_action).toBe(action);
      const { unmount } = render(
        <PastReplyCard row={row} isImported={false} editRepliesEnabled />,
      );
      assertOnlyAffordance(action);
      unmount();
    }
  });

  it('keeps the delete-failed recovery control while withdrawing Regenerate for an answered row with a held replacement draft', () => {
    // Recovery addresses the failed response, not the held draft (#726 owns the
    // server-side hold checks) — it is the ONLY control on the card.
    render(
      <PastReplyCard
        row={answeredRow({
          row_action: 'none',
          failed_response_id: 'fail-1',
          failed_posting_error: 'delete_failed_boom',
        })}
        isImported={false}
        editRepliesEnabled
      />,
    );

    expect(screen.getByRole('button', { name: /needs attention/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/reply on hold|under review/i)).not.toBeInTheDocument();
  });
});

// ── Tab bar ──────────────────────────────────────────────────────────────────

describe('ReviewsTabs', () => {
  it('ReviewsTabs renders the All Reviews tab unconditionally', () => {
    // PAST_REPLIES_VIEW_ENABLED is retired (S4), so there is no flag left to
    // gate the tab on and no `historyEnabled` prop to pass.
    render(<ReviewsTabs active="history" />);

    expect(screen.getByRole('link', { name: /all reviews/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /needs action/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^history$/i })).not.toBeInTheDocument();
  });
});

// ── The list surface ─────────────────────────────────────────────────────────

describe('Reviews list surface', () => {
  it('the Reviews list renders without PAST_REPLIES_VIEW_ENABLED set', () => {
    delete process.env.PAST_REPLIES_VIEW_ENABLED;

    render(
      <PastRepliesClient
        unansweredRows={[makeRow({ review_id: 'rev-unanswered' })]}
        answeredRows={[answeredRow({ review_id: 'rev-answered' })]}
        unansweredTotal={1}
        answeredTotal={1}
        avgStarRating={4}
        regenBudgets={{}}
        page={1}
        totalPages={1}
      />,
    );

    // getAllByText, not getByText: `Unanswered` and `Answered` each appear
    // TWICE by design — once as a stat tile, once as its section heading — and
    // both fixtures carry the same review body, so the single-match form threw
    // "multiple elements" for every assertion rather than failing on behaviour.
    // Anchored patterns keep `/^answered$/` from matching `Unanswered`.
    // (Repaired, not relaxed: the counts below are stricter than the originals.
    // See deviations D16.)
    expect(screen.getAllByText(/^unanswered$/i)).toHaveLength(2);
    expect(screen.getAllByText(/^answered$/i)).toHaveLength(2);
    expect(screen.getAllByText('Great food!')).toHaveLength(2);
  });
});
