// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EscalationActions, ReviewActions } from '../ReviewActions';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(init: { ok: boolean; status: number; body: unknown }) {
  return { ok: init.ok, status: init.status, json: async () => init.body };
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

    render(
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

  it('hides Acknowledge once acknowledged but still offers Resolve', async () => {
    const onSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { success: true, status: 'resolved' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
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

  it('surfaces the server error and does not advance on a failed transition', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, status: 409, body: { error: 'Escalation is already resolved' } }),
      ),
    );

    render(
      <EscalationActions
        escalation={{ id: 'esc-3', status: 'escalated', severity: 'low' }}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() => screen.getByText(/already resolved/i));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
