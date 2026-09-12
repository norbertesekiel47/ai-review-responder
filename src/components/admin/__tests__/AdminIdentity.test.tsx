// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminIdentity } from '../AdminIdentity';

const { pushMock, refreshMock, signOutMock } = vi.hoisted(() => ({
  pushMock: vi.fn(), refreshMock: vi.fn(), signOutMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));
vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut: signOutMock } }),
}));

const IDENTITY = { email: 'ops@repworth.com', aal2: true };

describe('AdminIdentity', () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    signOutMock.mockReset().mockResolvedValue({ error: null });
  });

  it('renders no identity controls without a signed-in identity', () => {
    render(<AdminIdentity identity={null} pathname="/admin/impersonate" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the signed-in email and verified step-up state', () => {
    render(<AdminIdentity identity={IDENTITY} pathname="/admin/impersonate" />);
    expect(screen.getByText(IDENTITY.email)).toBeInTheDocument();
    expect(screen.getByText('Step-up verified (AAL2)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Verify' })).toBeNull();
  });

  it('keeps the signed-in fallback when the identity has no email', () => {
    render(<AdminIdentity identity={{ email: null, aal2: true }} pathname={null} />);
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });

  it.each([
    ['/admin/impersonate/session/view', '/mfa/challenge?next=%2Fadmin%2Fimpersonate%2Fsession%2Fview'],
    [null, '/mfa/challenge?next=%2Fadmin'],
  ])('keeps the local MFA return for pathname %s', (pathname, href) => {
    render(<AdminIdentity identity={{ ...IDENTITY, aal2: false }} pathname={pathname} />);
    expect(screen.getByText(/Step-up not verified/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Verify' })).toHaveAttribute('href', href);
  });

  it('signs out once and returns to the local Admin login', async () => {
    const user = userEvent.setup();
    render(<AdminIdentity identity={IDENTITY} pathname="/admin/impersonate" />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith('/admin/login');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
  });

  it.each(['returned', 'thrown'] as const)('reports a %s sign-out error and permits retry', async (mode) => {
    const user = userEvent.setup();
    const failure = new Error('network');
    if (mode === 'returned') signOutMock.mockResolvedValueOnce({ error: failure });
    else signOutMock.mockRejectedValueOnce(failure);
    render(<AdminIdentity identity={IDENTITY} pathname="/admin/impersonate" />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed. You are still signed in.');
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/login'));
    expect(signOutMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
