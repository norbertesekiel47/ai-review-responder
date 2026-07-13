// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { EscalationActions, ReviewActions } from '../ReviewActions';
import { DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY } from '@/components/dashboard/NeedsAttentionList';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(init: { ok: boolean; status: number; body: unknown }) {
  return { ok: init.ok, status: init.status, json: async () => init.body };
}

/** EscalationActions reads the query client to sync the needs-attention list. */
function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe('ReviewActions regenerate cap (issue #335)', () => {
  it('surfaces the friendly daily-limit message and does not advance on a 429 regen_limit_reached', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: false,
          status: 429,
          body: {
            error: 'regen_limit_reached',
            message: 'Daily regenerate limit reached for this review — you can try again tomorrow.',
            remaining: 0,
            limit: 3,
          },
        }),
      ),
    );

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    // The cap message renders verbatim (not the raw "regen_limit_reached" code).
    await waitFor(() => screen.getByText(/daily regenerate limit reached/i));
    expect(screen.queryByText(/regen_limit_reached/i)).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the success message and advances on a normal regenerate', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, status: 200, body: { success: true, message: 'ok' } }),
      ),
    );

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    await waitFor(() => screen.getByText(/new draft requested/i));
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});

describe('ReviewActions approve and save-edit', () => {
  it('POSTs approve and shows the success message', async () => {
    const onSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, message: 'ok' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => screen.getByText('Approved!'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/reviews/rev-1/approve',
      { method: 'POST' },
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('surfaces the server error on a failed approve and resets on Try again', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, status: 409, body: { error: 'Response is not pending' } }),
      ),
    );

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => screen.getByText(/not pending/i));
    expect(onSuccess).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
  });

  it('falls back to a generic Failed (status) message when the error body is unparseable', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => { throw new Error('not json'); },
      }),
    );

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => screen.getByText('Failed (500)'));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('POSTs the edited text and shows the edited-approval success message', async () => {
    const onSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, message: 'ok' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ReviewActions reviewId="rev-2" responseText="original" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/edit reply text/i), {
      target: { value: 'better reply' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save & approve/i }));

    await waitFor(() => screen.getByText(/approved with edits/i));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/reviews/rev-2/edit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editedText: 'better reply' }),
      },
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('surfaces the server error on a failed save-edit', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, status: 400, body: { error: 'Edited response must not be empty' } }),
      ),
    );

    render(<ReviewActions reviewId="rev-2" responseText="original" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /save & approve/i }));

    await waitFor(() => screen.getByText(/must not be empty/i));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('Cancel restores the original text and returns to the action buttons', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ReviewActions reviewId="rev-2" responseText="original" onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/edit reply text/i), {
      target: { value: 'scrapped edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();

    // Re-entering edit mode starts from the original response text again.
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByLabelText(/edit reply text/i)).toHaveValue('original');
  });
});

describe('EscalationActions (WS3)', () => {
  it('ReviewActions renders draft actions only — escalation buttons live in EscalationActions', () => {
    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  it('POSTs acknowledge to the escalation endpoint and returns to idle on 200', async () => {
    const onSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, status: 'acknowledged' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithQueryClient(
      <EscalationActions
        escalation={{ id: 'esc-1', status: 'escalated', severity: 'high' }}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/escalations/esc-1/acknowledge',
      { method: 'POST' },
    );
    // Back to idle, not a terminal success panel: the refreshed badge is the
    // confirmation, and Resolve stays reachable after the Acknowledge.
    expect(screen.getByRole('button', { name: /resolve/i })).toBeEnabled();
  });

  it('invalidates the needs-attention query on a successful transition', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, status: 'resolved' } }),
    ));

    const { queryClient } = renderWithQueryClient(
      <EscalationActions
        escalation={{ id: 'esc-1', status: 'acknowledged', severity: 'high' }}
        onSuccess={onSuccess}
      />,
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY,
    });
  });

  it('hides Acknowledge once acknowledged but still offers Resolve', async () => {
    const onSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, status: 'resolved' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithQueryClient(
      <EscalationActions
        escalation={{ id: 'esc-2', status: 'acknowledged', severity: 'medium' }}
        onSuccess={onSuccess}
      />,
    );

    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/escalations/esc-2/resolve',
      { method: 'POST' },
    );
    // Idle again — the buttons stay available after the transition.
    expect(screen.getByRole('button', { name: /resolve/i })).toBeEnabled();
  });

  it('treats a 409 already-transitioned race as a refresh, not an error', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, status: 409, body: { error: 'Escalation is already resolved' } }),
      ),
    );

    renderWithQueryClient(
      <EscalationActions
        escalation={{ id: 'esc-3', status: 'escalated', severity: 'low' }}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    // Mirrors TimelineEscalationActions: the benign two-tab race refreshes the
    // feed so the settled escalation replaces the stale card.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(screen.queryByText(/already resolved/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeEnabled();
  });

  it('surfaces the server error and does not advance on a failed transition', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, status: 500, body: { error: 'Escalation transition failed' } }),
      ),
    );

    renderWithQueryClient(
      <EscalationActions
        escalation={{ id: 'esc-3', status: 'escalated', severity: 'low' }}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() => screen.getByText(/transition failed/i));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
