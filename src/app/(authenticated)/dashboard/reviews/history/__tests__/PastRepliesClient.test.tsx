// @vitest-environment jsdom
//
// #678 rewrote this surface into the **Reviews list**: two sections
// (`Unanswered` / `Answered`) over every review for the location, instead of the
// activation-split gap/historical buckets. The three regression guards that
// pinned the old bucketing (`hasHistoricalSection` for orphan-only hist rows and
// the two orphan-count reconciliations) are DELETED with the behaviour they
// guarded — orphans now arrive from the single row source, land in `Unanswered`
// by row state, and are already inside the `NOT EXISTS` unanswered denominator,
// so there is no count to reconcile.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PastRepliesClient } from '../PastRepliesClient';

// EditReplyDrawer uses useRouter — mock next/navigation for all tests.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

type ListRow = Parameters<typeof PastRepliesClient>[0]['answeredRows'][number];

function row(overrides: Partial<ListRow> = {}): ListRow {
  return {
    review_id: 'review-1',
    review_text: 'A thoughtful review',
    review_date: '2026-05-01T10:00:00Z',
    reviewer_name: 'Alex',
    star_rating: 5,
    response_id: 'response-1',
    approved_text: 'A thoughtful reply',
    approval_method: null,
    posted_at: '2026-05-02T10:00:00Z',
    external_reply_ingested_at: null,
    reply_state: 'posted',
    row_action: 'regenerate',
    canEdit: true,
    review_content_hash: 'hash-abc',
    version: 1,
    failed_response_id: null,
    failed_posting_error: null,
    ...overrides,
  };
}

/** An orphan: repost failed, no live Google reply — groups under Unanswered. */
function orphanRow(overrides: Partial<ListRow> = {}): ListRow {
  return row({
    review_id: 'orphan-review-1',
    response_id: 'fail-resp-orphan-1',
    approved_text: null,
    posted_at: null,
    version: null,
    reply_state: 'orphan',
    row_action: 'recover',
    canEdit: true,
    failed_response_id: 'fail-resp-orphan-1',
    failed_posting_error: 'post_after_delete_failed_http_400',
    ...overrides,
  });
}

const baseProps = {
  unansweredRows: [],
  answeredRows: [row()],
  unansweredTotal: 0,
  answeredTotal: 1,
  avgStarRating: 5,
  regenBudgets: {},
  page: 1,
  totalPages: 1,
};

describe('PastRepliesClient', () => {
  it('uses the current page denominator when a rating filter is active', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[
          row({ review_id: 'a-1', response_id: 'response-1', star_rating: 5 }),
          row({ review_id: 'a-2', response_id: 'response-2', star_rating: 5 }),
          row({ review_id: 'a-3', response_id: 'response-3', star_rating: 1 }),
        ]}
        answeredTotal={47}
        avgStarRating={4.4}
        totalPages={5}
      />,
    );

    expect(screen.getByText('3 of 47')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /filter by rating/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^all$/i })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /5/ }));

    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.queryByText('2 of 47')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^5/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^all$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows first-run copy for a brand-new location with zero reviews and no filter', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        unansweredRows={[]}
        answeredRows={[]}
        unansweredTotal={0}
        answeredTotal={0}
      />,
    );

    expect(screen.getAllByText('No reviews yet')).toHaveLength(2);
    expect(
      screen.getAllByText('Your Google reviews will appear here as they come in.'),
    ).toHaveLength(2);
    expect(screen.queryByText(/match this filter/i)).not.toBeInTheDocument();
  });

  it('shows filter-empty copy (not first-run) when a filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<PastRepliesClient {...baseProps} answeredRows={[row({ star_rating: 5 })]} />);

    // Filter to a rating with no matches → both sections empty out.
    await user.click(screen.getByRole('button', { name: /^1/ }));

    expect(screen.getByText('No replied reviews match this filter')).toBeInTheDocument();
    expect(screen.getByText('No unanswered reviews match this filter')).toBeInTheDocument();
    expect(screen.queryByText('No reviews yet')).not.toBeInTheDocument();
  });

  // ── Grouping ─────────────────────────────────────────────────────────────

  it('renders unanswered rows above answered rows, each under its own heading', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        unansweredRows={[
          row({ review_id: 'u-1', reply_state: 'none', row_action: 'generate', response_id: null, approved_text: null, posted_at: null }),
        ]}
        answeredRows={[row({ review_id: 'a-1' })]}
        unansweredTotal={1}
        answeredTotal={1}
      />,
    );

    const headings = screen
      .getAllByText(/^unanswered$|^answered$/i)
      // The stat-tile labels sit next to an inline icon, so trim the joined text.
      .map((node) => node.textContent?.trim());
    expect(headings).toEqual(['Unanswered', 'Answered', 'Unanswered', 'Answered']);
    // The unanswered row offers Generate; the answered one never does.
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
  });

  // ── Flag-off: read-only (Phase A inertness) ─────────────────────────────

  it('flag-off: no Regenerate CTA, no lock badge, no recovery button', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[
          row({ canEdit: true }),
          row({ review_id: 'r2', response_id: 'rsp2', canEdit: false }),
          row({
            review_id: 'r3',
            response_id: 'rsp3',
            failed_response_id: 'fail-1',
            failed_posting_error: 'delete_failed_auth',
          }),
        ]}
        answeredTotal={3}
        editRepliesEnabled={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  // ── Flag-on: Regenerate CTA for canEdit rows ────────────────────────────

  it('flag-on: Regenerate CTA is present for a canEdit=true row', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[row({ canEdit: true })]}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('flag-on: clicking Regenerate opens the drawer', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[row({ canEdit: true })]}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    // Drawer opens — confirm by the presence of the manual-edit CTA inside the drawer.
    expect(screen.getByRole('button', { name: /edit manually/i })).toBeInTheDocument();
  });

  it('shows the AI disclosure in the initial edit drawer before edit actions', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[row({ canEdit: true })]}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^regenerate this reply$/i }));

    expect(
      screen.getByText('Draft generated by AI. Review carefully before approving.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate with ai/i })).toBeInTheDocument();
  });

  // ── Flag-on: lock badge for !canEdit rows ───────────────────────────────

  it('flag-on: generic edit lock shown for canEdit=false', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[row({ canEdit: false })]}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByText(/editing unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
  });

  // ── Flag-on: recovery affordance ────────────────────────────────────────

  it('flag-on: recovery button shown when failed_response_id is present', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        answeredRows={[
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
        answeredRows={[
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

  // ── Orphan rows (D-G) ────────────────────────────────────────────────────
  //
  // An orphan has no live Google reply, so it groups under `Unanswered` — but
  // it does have a superseded draft, so it renders the recovery card and is
  // never offered Generate (that would race /retry and /restore-original).

  it('orphan row: sits in Unanswered with recovery, no edit lock, and no Generate', () => {
    render(
      <PastRepliesClient
        {...baseProps}
        unansweredRows={[orphanRow()]}
        answeredRows={[]}
        unansweredTotal={1}
        answeredTotal={0}
        editRepliesEnabled={true}
      />,
    );

    expect(screen.getByRole('button', { name: /needs attention/i })).toBeInTheDocument();
    expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^generate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/pending recovery/i)).toBeInTheDocument();
  });

  it('orphan row: clicking recovery button opens drawer in recovery state', async () => {
    const user = userEvent.setup();

    render(
      <PastRepliesClient
        {...baseProps}
        unansweredRows={[
          orphanRow({
            review_id: 'orphan-review-2',
            response_id: 'fail-resp-orphan-2',
            approved_text: 'Original approved text',
            failed_response_id: 'fail-resp-orphan-2',
            failed_posting_error: 'post_after_delete_failed_timeout',
          }),
        ]}
        answeredRows={[]}
        unansweredTotal={1}
        answeredTotal={0}
        editRepliesEnabled={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /needs attention/i }));

    expect(screen.getByRole('button', { name: /retry posting/i })).toBeInTheDocument();
  });

  // ── Regenerate preview: accept-as-is vs edit-further publish paths ────────
  //
  // The regenerate flow: Regenerate → POST /draft (returns outbox_id)
  // → poll /draft-status (returns response_id) → preview. From preview:
  //   - "Update on Google" (accept-as-is) → /publish ONLY, no PATCH
  //     (worker draft keeps edited_text NULL → 'regenerate_as_is').
  //   - "Edit further" → editing → submit → PATCH then /publish
  //     (forces edited_text → 'regenerate_edited').
  describe('regenerate preview publish paths', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const DRAFT_ID = 'draft-resp-1';
    const OUTBOX_ID = 'outbox-1';

    function urlOf(input: RequestInfo | URL): string {
      return typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    }

    function jsonResponse(body: unknown): Response {
      return { ok: true, status: 200, json: async () => body } as Response;
    }

    /** Mock fetch covering /draft (POST), /draft-status (GET), /publish, /draft/:id PATCH. */
    function installFetchMock() {
      const calls: { url: string; method: string }[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (url.includes('/draft-status')) {
          return jsonResponse({ response_id: DRAFT_ID, status: 'pending_approval', response_text: 'AI generated reply' });
        }
        if (url.endsWith('/past-replies/draft') && method === 'POST') {
          return jsonResponse({ outbox_id: OUTBOX_ID });
        }
        if (url.includes('/past-replies/publish')) {
          return jsonResponse({ outbox_id: 'pub-outbox-1' });
        }
        if (url.includes(`/past-replies/draft/${DRAFT_ID}`)) {
          // PATCH returns 204.
          return { ok: true, status: 204, json: async () => ({}) } as Response;
        }
        return jsonResponse({});
      });
      vi.stubGlobal('fetch', fetchMock);
      return { calls };
    }

    async function openPreview(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /^regenerate this reply$/i }));
      await user.click(screen.getByRole('button', { name: /regenerate with ai/i }));
      // Poll fires on a 1500ms timer; advance to the preview state.
      await waitFor(
        () => expect(screen.getByRole('button', { name: /edit further/i })).toBeInTheDocument(),
        { timeout: 3000 },
      );
    }

    it('accept-as-is issues a /publish call and NO PATCH', async () => {
      const user = userEvent.setup();
      const { calls } = installFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await openPreview(user);
      // "Update on Google" in the preview = accept-as-is.
      await user.click(screen.getByRole('button', { name: /update on google/i }));

      await waitFor(() =>
        expect(calls.some((c) => c.url.includes('/past-replies/publish'))).toBe(true),
      );
      // No PATCH to /draft/:id was issued.
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    });

    it('shows the AI disclosure in the regenerated draft preview', async () => {
      const user = userEvent.setup();
      installFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await openPreview(user);

      expect(
        screen.getByText('Draft generated by AI. Review carefully before approving.'),
      ).toBeInTheDocument();
    });

    it('edit-further issues a PATCH then a /publish', async () => {
      const user = userEvent.setup();
      const { calls } = installFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await openPreview(user);
      await user.click(screen.getByRole('button', { name: /edit further/i }));
      expect(
        screen.getByText('Draft generated by AI. Review carefully before approving.'),
      ).toBeInTheDocument();
      // Now in the editing state — submit publishes via PATCH + /publish.
      await user.click(screen.getByRole('button', { name: /update on google/i }));

      await waitFor(() =>
        expect(calls.some((c) => c.url.includes('/past-replies/publish'))).toBe(true),
      );
      const patchCall = calls.find((c) => c.method === 'PATCH');
      const publishCall = calls.find((c) => c.url.includes('/past-replies/publish'));
      expect(patchCall).toBeDefined();
      expect(patchCall!.url).toContain(`/past-replies/draft/${DRAFT_ID}`);
      // PATCH precedes publish.
      expect(calls.indexOf(patchCall!)).toBeLessThan(calls.indexOf(publishCall!));
    });
  });

  // ── Draft conflict: resume or discard a stranded in-progress draft ────────
  //
  // A reload/crash/failed-publish can leave a non-terminal draft. /draft now
  // returns 409 'draft_already_exists' WITH the existing draft. The drawer must
  // offer Resume / Discard rather than dead-ending on an error.
  describe('draft_already_exists resume/discard', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const EXISTING_ID = 'existing-draft-99';

    function installConflictFetchMock(overrides?: { status?: string }) {
      const calls: { url: string; method: string }[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (url.endsWith('/past-replies/draft') && method === 'POST') {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'draft_already_exists',
              existing: {
                response_id: EXISTING_ID,
                text: 'A stranded draft',
                is_edited: true,
                status: overrides?.status ?? 'pending_approval',
              },
            }),
          } as Response;
        }
        // DELETE /draft/:id (discard) → 204.
        return { ok: true, status: 204, json: async () => ({}) } as Response;
      });
      vi.stubGlobal('fetch', fetchMock);
      return { calls };
    }

    async function triggerConflict(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /^regenerate this reply$/i }));
      await user.click(screen.getByRole('button', { name: /edit manually/i }));
      // Submit the manual editor → POST /draft → 409 conflict.
      await user.click(screen.getByRole('button', { name: /update on google/i }));
      // Wait for the conflict panel to render. All three branches contain
      // the existing draft text 'A stranded draft' which is a reliable sentinel.
      await waitFor(() =>
        expect(screen.getByText('A stranded draft')).toBeInTheDocument(),
      );
    }

    it('surfaces Resume/Discard on 409 draft_already_exists instead of an error', async () => {
      const user = userEvent.setup();
      installConflictFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);

      expect(screen.getByRole('button', { name: /^resume$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^discard$/i })).toBeInTheDocument();
      expect(screen.getByText(/unsaved edit in progress/i)).toBeInTheDocument();
    });

    it('Discard issues a DELETE for the existing draft', async () => {
      const user = userEvent.setup();
      const { calls } = installConflictFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);
      await user.click(screen.getByRole('button', { name: /^discard$/i }));

      await waitFor(() =>
        expect(
          calls.some((c) => c.method === 'DELETE' && c.url.includes(`/past-replies/draft/${EXISTING_ID}`)),
        ).toBe(true),
      );
    });

    it('Resume drops into the preview state (publish/edit-further available)', async () => {
      const user = userEvent.setup();
      installConflictFetchMock();
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);
      await user.click(screen.getByRole('button', { name: /^resume$/i }));

      // Preview state shows the stranded draft text + Edit further affordance.
      expect(screen.getByText('A stranded draft')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit further/i })).toBeInTheDocument();
    });

    // ── Non-pending statuses: no Resume/Discard ────────────────────────────
    //
    // For 'approved' / 'edited' (publish already in flight) and
    // 'awaiting_owner_connect' (parked until Google reconnect), Resume/Discard
    // dead-end: /publish rejects non-pending_approval, DELETE is a no-op.
    // The drawer must render informational-only states without those buttons.

    it('approved conflict: shows "already approved" message, NO Resume/Discard buttons', async () => {
      const user = userEvent.setup();
      installConflictFetchMock({ status: 'approved' });
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);

      expect(screen.getByText(/already approved/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^discard$/i })).not.toBeInTheDocument();
    });

    it('edited conflict: shows "already approved" message, NO Resume/Discard buttons', async () => {
      const user = userEvent.setup();
      installConflictFetchMock({ status: 'edited' });
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);

      expect(screen.getByText(/already approved/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^discard$/i })).not.toBeInTheDocument();
    });

    it('awaiting_owner_connect conflict: shows reconnect message, NO Resume/Discard buttons', async () => {
      const user = userEvent.setup();
      installConflictFetchMock({ status: 'awaiting_owner_connect' });
      render(
        <PastRepliesClient {...baseProps} answeredRows={[row({ canEdit: true })]} editRepliesEnabled={true} />,
      );

      await triggerConflict(user);

      expect(screen.getByText(/reconnect required/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^discard$/i })).not.toBeInTheDocument();
    });
  });
});
