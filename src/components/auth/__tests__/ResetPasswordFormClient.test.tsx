// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { routerPush, mockGetUser } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  // Default: a recovery session is present so the owner form renders. Tests
  // that need the expired state override the resolved value per-call. Typed as
  // `user: { id } | null` so both the present and absent shapes are assignable.
  mockGetUser: vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    async () => ({ data: { user: { id: 'auth-1' } } }),
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { getUser: mockGetUser },
  }),
}));

import { ResetPasswordFormClient } from '../ResetPasswordFormClient';

afterEach(() => {
  vi.unstubAllGlobals();
  routerPush.mockClear();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } } });
});

describe('ResetPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island with 16px inputs', async () => {
    const { container } = render(
      <ResetPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    await waitFor(() => {
      expect(container.querySelector('input#new-password')?.className).toContain('text-base');
    });
  });

  it('admin portal keeps gray/blue exactly', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-[#D2E0D3]');
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
});
