// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PastRepliesClient } from '../PastRepliesClient';

// EditReplyDrawer uses useRouter — mock next/navigation for all tests.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function row(overrides: Partial<Parameters<typeof PastRepliesClient>[0]['gapRows'][number]> = {}) {
  return {
    review_id: overrides.review_id ?? 'review-1',
    review_text: overrides.review_text ?? 'A thoughtful review',
    review_date: overrides.review_date ?? '2026-05-01T10:00:00Z',
    reviewer_name: overrides.reviewer_name ?? 'Alex',
    star_rating: overrides.star_rating ?? 5,
    response_id: overrides.response_id ?? 'response-1',
    approved_text: overrides.approved_text ?? 'A thoughtful reply',
    posted_at: overrides.posted_at ?? '2026-05-02T10:00:00Z',
    external_reply_ingested_at: overrides.external_reply_ingested_at ?? null,
    canEdit: overrides.canEdit ?? true,
    review_content_hash: overrides.review_content_hash ?? 'hash-abc',
    version: overrides.version ?? 1,
    failed_response_id: overrides.failed_response_id ?? null,
    failed_posting_error: overrides.failed_posting_error ?? null,
  };
}

const baseProps = {
  gapRows: [row()],
  histRows: [],
  gapTotal: 1,
  histTotal: 0,
  avgStarRating: 5,
  isPremium: false,
  hasHistoricalSection: false,
  page: 1,
  totalPages: 1,
};

describe('PastRepliesClient', () => {
  it('uses the current page denominator when an active-period filter is active', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        gapRows={[
          row({ review_id: 'gap-1', response_id: 'response-1', star_rating: 5 }),
          row({ review_id: 'gap-2', response_id: 'response-2', star_rating: 5 }),
          row({ review_id: 'gap-3', response_id: 'response-3', star_rating: 1 }),
        ]}
        histRows={[]}
        gapTotal={47}
        histTotal={0}
        avgStarRating={4.4}
        isPremium
        hasHistoricalSection={false}
        page={1}
        totalPages={5}
      />,
    );

    expect(screen.getByText('3 of 47')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /5/ }));

    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.queryByText('2 of 47')).not.toBeInTheDocument();
  });

  // ── Flag-off: read-only (Phase A inertness) ─────────────────────────────

  it('flag-off: no Edit CTA, no lock badge, no recovery button', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[
          row({ canEdit: true }),
          row({ review_id: 'r2', response_id: 'rsp2', canEdit: false }),
          row({
            review_id: 'r3',
            response_id: 'rsp3',
            failed_response_id: 'fail-1',
            failed_posting_error: 'delete_failed_auth',
          }),
        ]}
        gapTotal={3}
        editRepliesEnabled={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  // ── Flag-on: Edit CTA for canEdit rows ──────────────────────────────────

  it('flag-on: Edit CTA is present for a canEdit=true row', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[row({ canEdit: true })]}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByRole('button', { name: /edit reply/i })).toBeInTheDocument();
  });

  it('flag-on: clicking Edit CTA opens the drawer', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[row({ canEdit: true })]}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /edit reply/i }));

    // Drawer opens — confirm by the presence of the manual-edit CTA inside the drawer.
    expect(screen.getByRole('button', { name: /edit manually/i })).toBeInTheDocument();
  });

  // ── Flag-on: lock badge for !canEdit rows ───────────────────────────────

  it('flag-on: lock badge shown for canEdit=false (historical + non-premium)', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[row({ canEdit: false })]}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/premium feature/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  // ── Flag-on: recovery affordance ────────────────────────────────────────

  it('flag-on: recovery button shown when failed_response_id is present', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[
          row({
            failed_response_id: 'fail-abc',
            failed_posting_error: 'delete_failed_timeout',
          }),
        ]}
        editRepliesEnabled={true}
      />,
    );

    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
  });

  it('flag-on: clicking recovery button opens drawer in recovery state', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[
          row({
            failed_response_id: 'fail-abc',
            failed_posting_error: 'delete_failed_timeout',
            canEdit: true,
          }),
        ]}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /needs attention/i }));

    // Drawer opens in recovery state — retry button should be visible.
    expect(screen.getByRole('button', { name: /retry posting/i })).toBeInTheDocument();
  });

  // ── Orphan-only rows (spec §5: no posted sibling) ───────────────────────
  //
  // page.tsx emits orphan rows via orphanCardRow: response_id = failed_response_id,
  // posted_at = null, approved_text = superseded text or null, canEdit = true.
  // They are merged into gapRows / histRows before being passed to this client.
  // The client must render them as recovery cards, NOT drop them, and NOT show
  // a premium lock (canEdit=true + recovery branch wins).

  it('orphan-only gap row: recovery button visible, no premium lock, not dropped', () => {
    // Simulates an orphan row merged into gapRows by page.tsx.
    const orphanRow = row({
      review_id: 'orphan-review-1',
      response_id: 'fail-resp-orphan-1',  // = failed_response_id
      approved_text: null,                  // no superseded text
      posted_at: null,
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,                        // always true for orphans
      failed_response_id: 'fail-resp-orphan-1',
      failed_posting_error: 'post_after_delete_failed_http_400',
    });

    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[orphanRow]}
        gapTotal={1}
        editRepliesEnabled={true}
      />,
    );

    // Recovery affordance must be visible.
    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
    // Premium lock must NOT appear.
    expect(screen.queryByText(/premium feature/i)).not.toBeInTheDocument();
    // Edit CTA must NOT appear alongside the recovery button.
    expect(screen.queryByRole('button', { name: /edit reply/i })).not.toBeInTheDocument();
  });

  it('orphan-only: clicking recovery button opens drawer in recovery state', async () => {
    const user = userEvent.setup();

    const orphanRow = row({
      review_id: 'orphan-review-2',
      response_id: 'fail-resp-orphan-2',
      approved_text: 'Original approved text',
      posted_at: null,
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,
      failed_response_id: 'fail-resp-orphan-2',
      failed_posting_error: 'post_after_delete_failed_timeout',
    });

    render(
      <PastRepliesClient
        {...baseProps}
        gapRows={[orphanRow]}
        gapTotal={1}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /needs attention/i }));

    // Drawer opens in recovery state.
    expect(screen.getByRole('button', { name: /retry posting/i })).toBeInTheDocument();
  });

  // ── Fix 1 regression guard: historical section renders for orphan-only rows ──
  //
  // Before this fix: hasHistoricalSection={histTotal > 0} gated the section on
  // posted count only. A premium user editing a historical reply that orphans
  // (DELETE OK + POST fail) produces an orphan histRow but histTotal stays 0 →
  // the section was hidden and the recovery card silently vanished.
  // After fix: hasHistoricalSection = histTotal > 0 || orphanHistRows.length > 0.

  it('historical section renders when only orphan hist rows exist (histTotal=0)', () => {
    // Simulates the scenario where a premium user's edit orphaned a historical
    // reply: histTotal=0 (no posted hist rows), but a hist orphan is merged in.
    const orphanHistRow = row({
      review_id: 'hist-orphan-review-1',
      response_id: 'hist-fail-resp-1',
      approved_text: null,
      posted_at: null,
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,
      failed_response_id: 'hist-fail-resp-1',
      failed_posting_error: 'post_after_delete_failed_http_400',
    });

    render(
      <PastRepliesClient
        gapRows={[]}
        histRows={[orphanHistRow]}
        gapTotal={0}
        histTotal={0}          // posted-only count: 0
        avgStarRating={null}
        isPremium={true}
        hasHistoricalSection={true}  // page.tsx now passes true when orphanHistRows.length > 0
        page={1}
        totalPages={1}
        editRepliesEnabled={true}
      />,
    );

    // Section heading must be visible.
    expect(screen.getByText(/from before you joined/i)).toBeInTheDocument();
    // Recovery affordance must be visible inside that section.
    expect(
      screen.getByRole('button', { name: /needs attention/i }),
    ).toBeInTheDocument();
  });

  // ── Fix 2: section header count includes orphan rows (no "N of M" with N > M) ──

  it('gap section header count includes orphan rows when hasGapOrphans=true', () => {
    // 2 posted gap rows (gapTotal=2) + 1 orphan gap row merged in (gapRows.length=3).
    // Without fix: header shows "3 of 2". After fix: "3 of 3".
    const orphanGapRow = row({
      review_id: 'gap-orphan-review-1',
      response_id: 'gap-fail-resp-1',
      approved_text: null,
      posted_at: null,
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,
      failed_response_id: 'gap-fail-resp-1',
      failed_posting_error: 'post_after_delete_failed_timeout',
    });

    render(
      <PastRepliesClient
        gapRows={[
          row({ review_id: 'gap-posted-1', response_id: 'rsp-1' }),
          row({ review_id: 'gap-posted-2', response_id: 'rsp-2' }),
          orphanGapRow,
        ]}
        histRows={[]}
        gapTotal={2}           // posted-only count
        histTotal={0}
        avgStarRating={4}
        isPremium={false}
        hasHistoricalSection={false}
        hasGapOrphans={true}   // signals that gapRows includes orphan rows
        page={1}
        totalPages={1}
        editRepliesEnabled={true}
      />,
    );

    // Header must show "3 of 3", not "3 of 2".
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
    expect(screen.queryByText('3 of 2')).not.toBeInTheDocument();
  });

  it('hist section header count includes orphan rows when histTotal is partial', () => {
    // 1 posted hist row (histTotal=1) + 1 orphan hist row merged in (histRows.length=2).
    // Without fix: header shows "2 of 1". After fix: "2 of 2".
    const orphanHistRow = row({
      review_id: 'hist-orphan-review-2',
      response_id: 'hist-fail-resp-2',
      approved_text: null,
      posted_at: null,
      external_reply_ingested_at: null,
      version: null,
      canEdit: true,
      failed_response_id: 'hist-fail-resp-2',
      failed_posting_error: 'post_after_delete_failed_http_400',
    });

    render(
      <PastRepliesClient
        gapRows={[]}
        histRows={[
          row({ review_id: 'hist-posted-1', response_id: 'rsp-hist-1' }),
          orphanHistRow,
        ]}
        gapTotal={0}
        histTotal={1}          // posted-only count
        avgStarRating={null}
        isPremium={true}
        hasHistoricalSection={true}
        page={1}
        totalPages={1}
        editRepliesEnabled={true}
      />,
    );

    // Header must show "2 of 2", not "2 of 1".
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.queryByText('2 of 1')).not.toBeInTheDocument();
  });
});
