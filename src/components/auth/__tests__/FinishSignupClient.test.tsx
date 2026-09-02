// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinishSignupClient } from '../FinishSignupClient';

const { routerPush, routerRefresh, signOut } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
  signOut: vi.fn<() => Promise<{ error: { message: string } | null }>>(async () => ({ error: null })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut } }),
}));

describe('FinishSignupClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    routerPush.mockClear();
    routerRefresh.mockClear();
    signOut.mockReset();
    signOut.mockResolvedValue({ error: null });
  });

  it('renders visible (non-sr-only) labels for each editable field', () => {
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    for (const text of [/^your name$/i, /phone/i]) {
      const label = screen.getByText(text);
      expect(label.className).not.toContain('sr-only');
    }
  });

  it('renders the account email as text with a "Not you? Sign out" exit (A17)', () => {
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('owner@example.com')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not you? Sign out' })).toBeInTheDocument();
  });

  it('signs out and returns to /signup when the owner says it is not them (A17)', async () => {
    const user = userEvent.setup();
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    await user.click(screen.getByRole('button', { name: 'Not you? Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith('/signup');
  });

  it('keeps the owner on the page with a plain message when sign-out fails (A17)', async () => {
    const user = userEvent.setup();
    signOut.mockResolvedValue({ error: { message: 'boom' } });
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    await user.click(screen.getByRole('button', { name: 'Not you? Sign out' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't sign you out/i);
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Not you? Sign out' })).not.toBeDisabled();
  });

  it('renders the branded island, not gray/blue', () => {
    const { container } = render(
      <FinishSignupClient defaultEmail="a@b.co" defaultName="Ada" />,
    );
    expect(container.innerHTML).toContain('bg-rw-sage');
    expect(container.innerHTML).not.toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    const name = container.querySelector('input#finish-name');
    expect(name).not.toBeNull();
    expect(name!.className).toContain('text-base');
  });

  it('maps a server error code to curated copy and announces it once (assertive live region)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        // Raw machine code from the route — must NOT reach the UI verbatim.
        json: async () => ({ error: 'invalid_body' }),
      })) as unknown as typeof fetch,
    );

    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      // Exactly one announcing region (the assertive LiveRegion); the visible
      // copy is aria-hidden, so no double announcement.
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/some details don't look right/i);
      expect(alert.textContent).not.toContain('invalid_body');
    });
  });

  it('never renders a raw machine error code, even for an unknown code', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'token_expired' }),
      })) as unknown as typeof fetch,
    );

    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain('token_expired');
      expect(alert).toHaveTextContent(/something went wrong/i);
    });
  });
});
