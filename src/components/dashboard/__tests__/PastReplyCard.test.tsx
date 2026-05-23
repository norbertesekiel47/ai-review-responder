// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PastReplyCard } from '../PastReplyCard';
import type { PastReplyRow } from '../PastReplyCard';

function makeRow(overrides: Partial<PastReplyRow> = {}): PastReplyRow {
  return {
    review_id: 'review-1',
    review_text: 'Great food!',
    review_date: '2026-04-01T10:00:00Z',
    reviewer_name: 'Jordan',
    star_rating: 5,
    response_id: 'response-1',
    approved_text: 'Thank you for visiting!',
    posted_at: '2026-04-02T10:00:00Z',
    external_reply_ingested_at: null,
    review_content_hash: 'hash-abc',
    version: 1,
    canEdit: true,
    failed_response_id: null,
    failed_posting_error: null,
    ...overrides,
  };
}

describe('PastReplyCard', () => {
  // ── Flag-off read-only ────────────────────────────────────────────────────

  it('renders without Edit CTA, lock badge, or recovery button when editRepliesEnabled is false', () => {
    render(
      <PastReplyCard
        row={makeRow()}
        isImported={false}
        editRepliesEnabled={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('renders without Edit CTA when editRepliesEnabled is omitted (default off)', () => {
    render(<PastReplyCard row={makeRow()} isImported={false} />);

    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  // ── canEdit=true → Edit CTA ───────────────────────────────────────────────

  it('shows Edit CTA when canEdit=true and editRepliesEnabled=true', () => {
    render(
      <PastReplyCard
        row={makeRow({ canEdit: true })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByRole('button', { name: /edit reply/i })).toBeInTheDocument();
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
  });

  it('calls onEditClick with the row when Edit CTA is clicked', async () => {
    const user = userEvent.setup();
    const onEditClick = vi.fn();
    const row = makeRow({ canEdit: true });

    render(
      <PastReplyCard
        row={row}
        isImported={false}
        editRepliesEnabled={true}
        onEditClick={onEditClick}
      />,
    );

    await user.click(screen.getByRole('button', { name: /edit reply/i }));

    expect(onEditClick).toHaveBeenCalledOnce();
    expect(onEditClick).toHaveBeenCalledWith(row);
  });

  // ── canEdit=false → lock badge ────────────────────────────────────────────

  it('shows lock badge (not Edit CTA) when canEdit=false and editRepliesEnabled=true', () => {
    render(
      <PastReplyCard
        row={makeRow({ canEdit: false })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/premium feature/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  // ── Recovery branch ───────────────────────────────────────────────────────

  it('shows recovery button when failed_response_id is present and editRepliesEnabled=true', () => {
    render(
      <PastReplyCard
        row={makeRow({
          failed_response_id: 'fail-1',
          failed_posting_error: 'delete_failed_timeout',
        })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
    // Edit CTA should NOT be shown alongside the recovery button.
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  it('recovery button takes precedence over canEdit Edit CTA', () => {
    // A row can be both canEdit=true AND have a failed sibling — recovery wins.
    render(
      <PastReplyCard
        row={makeRow({
          canEdit: true,
          failed_response_id: 'fail-2',
          failed_posting_error: 'post_after_delete_failed_timeout',
        })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  it('calls onRecoveryClick with the row when recovery button is clicked', async () => {
    const user = userEvent.setup();
    const onRecoveryClick = vi.fn();
    const row = makeRow({
      failed_response_id: 'fail-3',
      failed_posting_error: 'delete_failed_auth',
    });

    render(
      <PastReplyCard
        row={row}
        isImported={false}
        editRepliesEnabled={true}
        onRecoveryClick={onRecoveryClick}
      />,
    );

    await user.click(screen.getByRole('button', { name: /needs attention/i }));

    expect(onRecoveryClick).toHaveBeenCalledOnce();
    expect(onRecoveryClick).toHaveBeenCalledWith(row);
  });

  it('does NOT show recovery button when failed_response_id is null even with editRepliesEnabled', () => {
    render(
      <PastReplyCard
        row={makeRow({ failed_response_id: null, canEdit: true })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    // Should show Edit CTA instead.
    expect(screen.getByRole('button', { name: /edit reply/i })).toBeInTheDocument();
  });

  // ── Orphan-only recovery card (spec §5: no posted sibling) ───────────────
  //
  // An orphan-only row is a review where DELETE succeeded but POST failed
  // (post_after_delete_failed_* marker). page.tsx maps it with:
  //   - response_id = failed_response_id (the failed row's id)
  //   - posted_at = null
  //   - approved_text = superseded sibling text (may be null)
  //   - canEdit = true (always, so recovery is never locked behind premium)
  //
  // The card MUST render the recovery affordance and MUST NOT show a premium lock.

  it('orphan-only: renders recovery button when posted_at is null and failed_response_id is present', () => {
    // Simulates the orphanCardRow shape emitted by page.tsx for a
    // post_after_delete_failed_http_400 failure with no posted sibling.
    const orphanRow = makeRow({
      response_id: 'fail-resp-999',
      approved_text: null,       // no superseded sibling text
      posted_at: null,           // no posted reply
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,             // orphanCardRow always sets this
      failed_response_id: 'fail-resp-999',
      failed_posting_error: 'post_after_delete_failed_http_400',
    });

    render(
      <PastReplyCard
        row={orphanRow}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    // Recovery affordance must be present.
    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
    // Edit CTA must NOT appear alongside the recovery button.
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
    // Premium lock must NOT appear (canEdit=true + recovery branch wins).
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
  });

  it('orphan-only: renders gracefully when approved_text (superseded context) is null', () => {
    const orphanRow = makeRow({
      response_id: 'fail-resp-000',
      approved_text: null,
      posted_at: null,
      canEdit: true,
      failed_response_id: 'fail-resp-000',
      failed_posting_error: 'post_after_delete_failed_timeout',
    });

    // Must not throw; the "(no reply text)" fallback should appear in the reply panel.
    render(
      <PastReplyCard
        row={orphanRow}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/no reply text/i)).toBeInTheDocument();
  });

  it('orphan-only: recovery button is NOT blocked by premium lock even when canEdit=true and flag is on', () => {
    // Explicit assertion that the recovery branch (failed_response_id present)
    // takes priority over any lock-vs-edit decision, per spec §5.
    const orphanRow = makeRow({
      response_id: 'fail-resp-111',
      posted_at: null,
      approved_text: 'Original reply text',
      canEdit: true,
      failed_response_id: 'fail-resp-111',
      failed_posting_error: 'post_after_delete_failed_retry_exhausted',
    });

    render(
      <PastReplyCard
        row={orphanRow}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByRole('button', { name: /needs attention/i })).toBeInTheDocument();
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
  });

  // ── Fix 3: orphan recovery rows must not show "Posted via RepWorth" badge ──
  //
  // An orphan row (failed_response_id present + posted_at null) was never
  // successfully posted, so "Posted via RepWorth" is misleading. Both
  // provenance badges must be suppressed; "Pending recovery" must appear instead.

  it('orphan recovery row: does NOT show "Posted via RepWorth" badge', () => {
    const orphanRow = makeRow({
      response_id: 'fail-resp-badge-1',
      posted_at: null,
      external_reply_ingested_at: null,
      canEdit: true,
      failed_response_id: 'fail-resp-badge-1',
      failed_posting_error: 'post_after_delete_failed_http_400',
    });

    render(
      <PastReplyCard
        row={orphanRow}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    // Neither provenance badge should appear.
    expect(screen.queryByText(/posted via repworth/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^imported$/i)).not.toBeInTheDocument();
    // Neutral recovery label must appear instead.
    expect(screen.getByText(/pending recovery/i)).toBeInTheDocument();
  });

  it('orphan recovery row: does NOT show "Imported" badge', () => {
    // isImported=true is irrelevant for orphan rows — badge must still be suppressed.
    const orphanRow = makeRow({
      response_id: 'fail-resp-badge-2',
      posted_at: null,
      // external_reply_ingested_at being set is unusual for an orphan, but we
      // guard the badge by posted_at===null + failed_response_id, not isImported.
      external_reply_ingested_at: '2026-03-01T00:00:00Z',
      canEdit: true,
      failed_response_id: 'fail-resp-badge-2',
      failed_posting_error: 'post_after_delete_failed_timeout',
    });

    render(
      <PastReplyCard
        row={orphanRow}
        isImported={true}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.queryByText(/^imported$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/posted via repworth/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pending recovery/i)).toBeInTheDocument();
  });

  it('normal posted row: still shows "Posted via RepWorth" badge (Fix 3 does not regress)', () => {
    // A row with a real posted_at and no failed_response_id must keep the badge.
    render(
      <PastReplyCard
        row={makeRow({
          posted_at: '2026-04-02T10:00:00Z',
          failed_response_id: null,
        })}
        isImported={false}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/posted via repworth/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending recovery/i)).not.toBeInTheDocument();
  });

  it('normal imported row: still shows "Imported" badge (Fix 3 does not regress)', () => {
    render(
      <PastReplyCard
        row={makeRow({
          posted_at: '2026-04-02T10:00:00Z',
          external_reply_ingested_at: '2026-03-01T00:00:00Z',
          failed_response_id: null,
        })}
        isImported={true}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/^imported$/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending recovery/i)).not.toBeInTheDocument();
  });
});
