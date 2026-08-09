// @vitest-environment jsdom
//
// src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx
//
// T1 EVAL suite for #678 — the **Reviews list** surface.
//
// D-D: the card RENDERS a row state; it never computes one. All six states
// (`recover` | `regenerate` | `held` | `draft_ready` | `generating` |
// `generate`) are derived once in `replies-view.ts`, which is where the
// invariant-adjacent risk sits. These titles pin what each state looks like.
//
// RED until Task 7: `PastReplyCard` has no Generate/Regenerate affordance
// today, `ReviewsTabs` still gates the tab on `historyEnabled` and labels it
// `History`, and `PastRepliesClient` still takes gapRows/histRows.
//
// Prop shapes pinned here (Task 7 must match): the card takes `row_state` on the
// row plus an OPTIONAL `regenBudget` — optional because "no entry in the budget
// map" must mean UNKNOWN, never "0 remaining" (F6). The client takes a plain
// `regenBudgets` RECORD, not a Map: it crosses the server→client boundary and a
// Map does not serialize.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { PastReplyCard } from '@/components/dashboard/reviews/PastReplyCard';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { PastRepliesClient } from '@/app/(authenticated)/dashboard/reviews/history/PastRepliesClient';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';

interface ListRow extends PastReplyRow {
  row_state: string;
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
    row_state: 'generate',
    provenance_badge: null,
    ...overrides,
  };
}

function answeredRow(overrides: Partial<ListRow> = {}): ListRow {
  return makeRow({
    row_state: 'regenerate',
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
    render(<PastReplyCard row={makeRow({ row_state: 'generate' })} isImported={false} />);

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
        row={makeRow({ row_state: 'draft_ready', response_id: 'draft-1' })}
        isImported={false}
      />,
    );

    const link = screen.getByRole('link', { name: /draft ready/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/dashboard/reviews'));
    expect(screen.queryByRole('button', { name: /^generate$/i })).not.toBeInTheDocument();
  });

  it.todo('keeps the live posted reply and provenance badge visible for an answered row with a held replacement draft');
  it.todo('renders no Regenerate button, no counter, and no held indication for an answered row with a held replacement draft');
  it.todo('renders the live posted reply with Regenerate for an answered row without a held replacement draft');
  it.todo('renders the held panel with no draft text and no affordance for an unanswered review with a held draft');
  it.todo('renders the locked presentation for every cell of the 3x4 cross-product');
  it.todo('keeps the delete-failed recovery control while withdrawing Regenerate for an answered row with a held replacement draft');
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

  it('the Reviews list renders a moderation-held draft as held with no Generate, no draft text, and no cross-link', () => {
    // Round-2 Defect B / D9. Invariant #4 makes the hold absolute: the draft is
    // not the owner's to see or act on until an admin disposition at
    // /admin/flagged releases it. Needs Action does not surface held drafts
    // either, so the `draft_ready` cross-link would lead nowhere.
    render(
      <PastRepliesClient
        unansweredRows={[
          makeRow({
            review_id: 'rev-held',
            row_state: 'held',
            review_text: 'Held-draft review body',
            approved_text: 'SECRET held draft text',
          }),
        ]}
        answeredRows={[]}
        unansweredTotal={1}
        answeredTotal={0}
        avgStarRating={3}
        regenBudgets={{}}
        page={1}
        totalPages={1}
      />,
    );

    expect(screen.getByText(/under review/i)).toBeInTheDocument();
    expect(screen.getByText('Held-draft review body')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET held draft text/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^generate$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve & post/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /draft ready/i })).not.toBeInTheDocument();
  });
});
