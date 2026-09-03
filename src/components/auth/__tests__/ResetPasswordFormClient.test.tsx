// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { routerPush, mockGetUser, mockListFactors } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  // Default: a recovery session is present so the owner form renders. Tests
  // that need the expired state override the resolved value per-call. Typed as
  // `user: { id } | null` so both the present and absent shapes are assignable.
  mockGetUser: vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    async () => ({ data: { user: { id: 'auth-1' } } }),
  ),
  // Default: no enrolled factor, so every pre-existing test keeps exercising
  // the unchanged no-step-up path. Typed loosely — `normalizeChallengeFactors`
  // accepts `unknown` — so per-test overrides can supply factor rows.
  mockListFactors: vi.fn<
    () => Promise<{
      data: { totp: Array<{ id: string; friendly_name: string; status: string }> };
      error: null;
    }>
  >(async () => ({ data: { totp: [] }, error: null })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getUser: mockGetUser,
      mfa: { listFactors: mockListFactors },
    },
  }),
}));

import { ResetPasswordFormClient } from '../ResetPasswordFormClient';

afterEach(() => {
  vi.unstubAllGlobals();
  routerPush.mockClear();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } } });
  mockListFactors.mockReset();
  mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
});

describe('ResetPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island with the 16px island Field', async () => {
    const { container } = render(
      <ResetPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-rw-sage');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    await waitFor(() => {
      // `.rw-input` is pinned to 16px by auth-island.css.test.ts (A5).
      expect(container.querySelector('input#new-password')?.className).toContain('rw-input');
    });
  });

  describe('reuses the auth island password Field and requirements (A19)', () => {
    it('offers a show/hide toggle on both password fields', async () => {
      render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
      await screen.findByLabelText('New password');

      const toggles = screen.getAllByRole('button', { name: 'Show password' });
      expect(toggles).toHaveLength(2);

      fireEvent.click(toggles[0]!);
      expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
      expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
    });

    it('lists the password requirements before submit and ticks them as they are met', async () => {
      render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
      const input = await screen.findByLabelText('New password');

      const list = screen.getByRole('list', { name: 'Password requirements' });
      // #1090: the list is now exactly the rules `passwordSchema` ENFORCES.
      // 'Upper & lowercase letters' was removed because nothing enforced it —
      // it is scored by `strengthOf` as guidance, and listing it here claimed a
      // rule the server does not apply.
      expect(list).toHaveTextContent('At least 8 characters');
      expect(list).toHaveTextContent('A number');
      expect(list).not.toHaveTextContent('Upper & lowercase letters');
      expect(input).toHaveAttribute('aria-describedby', expect.stringContaining(list.id));
      expect(list.querySelectorAll('li.met')).toHaveLength(0);

      fireEvent.change(input, { target: { value: 'validPass1' } });
      expect(list.querySelectorAll('li.met')).toHaveLength(2);
    });

    it('marks the confirm field invalid on a mismatch without a second alert', async () => {
      render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
      await screen.findByLabelText('New password');
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'nope' } });
      fireEvent.blur(screen.getByLabelText('Confirm password'));

      expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true');
      // Field's own error line is NOT used — the page's LiveRegion owns announcements.
      expect(screen.getByRole('alert')).toHaveTextContent('');
    });
  });

  it('admin portal keeps gray/blue exactly', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
    expect(container.innerHTML).not.toMatch(/bg-rw-sage(?![-\w])/);
  });

  it('owner happy path — submits and pushes to redirectTo on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ redirectTo: '/dashboard' }),
      }),
    );
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'validPass1' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('announces validation errors assertively (owner)', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
    });
  });

  it('shows the expired-link state when no recovery session exists on mount', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    // Heading is unique to the expired state (the copy itself also appears in
    // the assertive LiveRegion, so match the heading specifically).
    expect(
      await screen.findByRole('heading', { name: /reset link expired/i }),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /request a new reset link/i });
    expect(link).toHaveAttribute('href', '/forgot-password');
    // The password form is gone in the expired state.
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('flips to the expired-link state when the server returns 401 on submit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized' }),
      }),
    );
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'validPass1' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    expect(
      await screen.findByRole('heading', { name: /reset link expired/i }),
    ).toBeInTheDocument();
  });

  it('maps server error codes to curated copy — never a raw machine code (owner)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_body' }),
      }),
    );
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'validPass1' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain('invalid_body');
      expect(alert).toHaveTextContent(/doesn't meet the requirements/i);
    });
  });

  it('shows inline "passwords match" feedback on blur (owner)', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'validPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'validPass1' } });
    fireEvent.blur(screen.getByLabelText('Confirm password'));
    expect(await screen.findByText(/passwords match\./i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'nomatch' } });
    expect(await screen.findByText(/passwords don't match\./i)).toBeInTheDocument();
  });

  it('shows no code field when the account has no enrolled factor', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/new password/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull();
  });

  it('reveals the code field when a verified factor exists', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });
  });

  it('verifies the code BEFORE posting the password', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ redirectTo: '/dashboard' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/mfa/challenge');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/mfa/challenge');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/auth/reset-password');
  });

  it('never reaches the reset route when the code is rejected', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'verify_failed' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '000000' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => {
      // The visible, non-live paragraph — the sr-only assertive LiveRegion
      // renders the same copy (same duplication pattern as `error` elsewhere
      // on this page), so scope to the visible node to avoid an ambiguous match.
      expect(
        screen.getByText(/verification code was not accepted/i, { selector: 'p' }),
      ).toBeTruthy();
    });
    // A mistyped code must never spend one of the reset route's 5/hr.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('admin portal also reveals the code field', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });

    render(<ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });
  });

  it('admin portal dead-ends on an expired recovery link', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    render(<ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />);

    await waitFor(() => {
      expect(screen.getByText(/reset link expired/i)).toBeTruthy();
    });
  });

  it('disables the submit button and shows "Verifying…" while the step-up is in flight', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    // Hold the challenge request open so we can observe the busy state before
    // it resolves — this is exactly the window in which an unguarded button
    // would let a second click fire against a stale code.
    let resolveChallenge: (value: unknown) => void = () => {};
    const challengePromise = new Promise((resolve) => {
      resolveChallenge = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(challengePromise);
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    const button = await screen.findByRole('button', { name: /verifying/i });
    expect(button).toBeDisabled();

    // Release the held challenge so the test doesn't leave a dangling promise;
    // the failure shape just ends the attempt cleanly.
    resolveChallenge({ ok: false, status: 400, json: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /update password/i })).not.toBeDisabled();
    });
  });

  it('re-prompts for a code on a 403 mfa_required instead of dead-ending', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'mfa_required' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password1' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    // Still on the code-required surface with a cleared code, not a dead end.
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toHaveValue('');
    });
    expect(routerPush).not.toHaveBeenCalled();
  });
});

// #1090. The form displayed "A number" as a requirement and submitted anyway,
// and `passwordSchema` then accepted the result. The guard now blocks on every
// enforced rule, so the request never leaves the browser.
describe('enforces the displayed password requirements before submit (#1090)', () => {
  it('the reset form blocks submit when the number requirement is unmet', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'abcdefghij' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'abcdefghij' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: /update password/i }).closest('form')!,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Password must contain at least one number',
      );
    });
    // The point of the fix: the reset route is never reached.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still submits a long password that does contain a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ redirectTo: '/dashboard' }) }),
    );
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'abcdefghij1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'abcdefghij1' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: /update password/i }).closest('form')!,
    );
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('lists exactly the enforced rules beneath the field', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await screen.findByLabelText('New password');
    const list = screen.getByLabelText('Password requirements');
    expect(list).toHaveTextContent('At least 8 characters');
    expect(list).toHaveTextContent('A number');
    // Mixed case is guidance scored by strengthOf, never a requirement.
    expect(list).not.toHaveTextContent('Upper & lowercase letters');
  });
});
