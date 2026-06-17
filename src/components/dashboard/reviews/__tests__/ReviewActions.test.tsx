// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewActions } from '../ReviewActions';

afterEach(() => vi.unstubAllGlobals());

function regenResponse(init: { ok: boolean; status: number; body: unknown }) {
  return { ok: init.ok, status: init.status, json: async () => init.body };
}

describe('ReviewActions regenerate cap (issue #335)', () => {
  it('surfaces the friendly daily-limit message and does not advance on a 429 regen_limit_reached', async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        regenResponse({
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
        regenResponse({ ok: true, status: 200, body: { success: true, message: 'ok' } }),
      ),
    );

    render(<ReviewActions reviewId="rev-1" responseText="hi" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    await waitFor(() => screen.getByText(/new draft requested/i));
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
