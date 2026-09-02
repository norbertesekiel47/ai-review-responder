// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EndImpersonationButton } from '../EndImpersonationButton';

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

describe('EndImpersonationButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ends the impersonation session, returns to admin overview, and refreshes so the shell banner drops', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<EndImpersonationButton />);

    await user.click(screen.getByRole('button', { name: /end session/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/impersonation/end',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pushMock).toHaveBeenCalledWith('/admin/overview');
    // The banner is server-rendered from the cookie; a push to the page the
    // admin is already on is a no-op, so the refresh is what removes it.
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('renders API errors without navigating', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_impersonation_session' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    render(<EndImpersonationButton />);

    await user.click(screen.getByRole('button', { name: /end session/i }));

    expect(await screen.findByText('invalid_impersonation_session')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('renders the inverse, compact variant for the banner', () => {
    render(<EndImpersonationButton tone="inverse" compact />);
    const button = screen.getByRole('button', { name: /end session/i });
    expect(button.className).toContain('bg-white');
    expect(button.className).toContain('text-xs');
  });
});
