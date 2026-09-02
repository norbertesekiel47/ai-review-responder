// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MfaFactor, UseMfaEnrollment } from '@/components/auth/useMfaEnrollment';

const { mockUseMfaEnrollment } = vi.hoisted(() => ({ mockUseMfaEnrollment: vi.fn() }));

vi.mock('@/components/auth/useMfaEnrollment', () => ({
  useMfaEnrollment: mockUseMfaEnrollment,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import {
  CHANGE_PASSWORD_HREF,
  SecurityClient,
  STEP_UP_HREF,
  factorSummary,
  isStepUpRequiredError,
} from '../SecurityClient';

const FACTOR: MfaFactor = {
  id: 'factor-1',
  friendlyName: 'RepWorth',
  factorType: 'totp',
  status: 'verified',
  createdAt: '2026-03-03T10:15:00.000Z',
};

function arrange(overrides: Partial<UseMfaEnrollment> = {}): UseMfaEnrollment {
  const value: UseMfaEnrollment = {
    factors: [FACTOR],
    verifiedFactors: [FACTOR],
    loading: false,
    busy: false,
    error: null,
    notice: null,
    enrollment: null,
    code: '',
    setCode: vi.fn(),
    startEnrollment: vi.fn(async () => {}),
    verifyEnrollment: vi.fn(async () => {}),
    cancelEnrollment: vi.fn(),
    unenrollFactor: vi.fn(async () => {}),
    ...overrides,
  };
  mockUseMfaEnrollment.mockReturnValue(value);
  return value;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SecurityClient factor row (S21)', () => {
  it('describes the factor as "Authenticator app · Added {date}", never TOTP or a raw status', () => {
    arrange();
    render(<SecurityClient />);

    expect(screen.getByText('Authenticator app · Added Mar 3, 2026')).toBeInTheDocument();
    expect(screen.queryByText(/totp/i)).toBeNull();
    expect(screen.queryByText(/·\s*verified/i)).toBeNull();
  });

  it('confirms removal in a SettingsModal before unenrolling', async () => {
    const hook = arrange();
    render(<SecurityClient />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(hook.unenrollFactor).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Remove authenticator app' });
    expect(dialog).toHaveTextContent(/signing in will need only your password/i);

    fireEvent.click(screen.getByRole('button', { name: 'Remove authenticator app' }));
    await waitFor(() => expect(hook.unenrollFactor).toHaveBeenCalledWith('factor-1'));
  });

  it('"Keep it" closes the dialog without unenrolling', () => {
    const hook = arrange();
    render(<SecurityClient />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hook.unenrollFactor).not.toHaveBeenCalled();
  });

  it('links the step-up route when removal was refused for a missing AAL2 session', () => {
    arrange({ error: 'Sign in again with your authenticator before removing this factor.' });
    render(<SecurityClient />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/sign in again with your authenticator/i);
    expect(screen.getByRole('link', { name: 'Verify with your authenticator' })).toHaveAttribute(
      'href',
      STEP_UP_HREF,
    );
    expect(STEP_UP_HREF).toBe('/mfa/challenge?next=/settings/security');
  });

  it('does not attach the step-up link to unrelated errors', () => {
    arrange({ error: 'Could not load MFA factors.' });
    render(<SecurityClient />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Verify with your authenticator' })).toBeNull();
  });
});

describe('SecurityClient copy (S22)', () => {
  it('explains two-step sign-in in plain language and states there are no backup codes', () => {
    arrange();
    render(<SecurityClient />);

    expect(screen.getByText('Two-step sign-in')).toBeInTheDocument();
    expect(screen.getByText(/6-digit code each time you sign in/i)).toBeInTheDocument();
    expect(screen.queryByText(/second factor as a backup/i)).toBeNull();
    expect(screen.getByText(/there are no backup codes/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/help/contact');
  });

  it('offers Change password through the existing reset flow', () => {
    arrange();
    render(<SecurityClient />);

    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute('href', CHANGE_PASSWORD_HREF);
    expect(CHANGE_PASSWORD_HREF).toBe('/forgot-password');
  });

  it('tells an owner with no factor that two-step sign-in is off', () => {
    arrange({ factors: [], verifiedFactors: [] });
    render(<SecurityClient />);

    expect(screen.getByText(/two-step sign-in is off/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add authenticator app' })).toBeEnabled();
  });
});

describe('SecurityClient loading (S35)', () => {
  it('renders the shared SettingsSkeleton instead of plain loading text', () => {
    arrange({ loading: true, factors: [], verifiedFactors: [] });
    render(<SecurityClient />);

    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
    expect(screen.queryByText(/loading security settings/i)).toBeNull();
  });
});

describe('factorSummary / isStepUpRequiredError', () => {
  it('formats the added date and degrades without one', () => {
    expect(factorSummary({ createdAt: '2026-03-03T10:15:00.000Z' })).toBe('Authenticator app · Added Mar 3, 2026');
    expect(factorSummary({ createdAt: null })).toBe('Authenticator app');
    expect(factorSummary({ createdAt: 'not-a-date' })).toBe('Authenticator app');
  });

  it('recognises only the AAL2 refusal', () => {
    expect(isStepUpRequiredError('Sign in again with your authenticator before removing this factor.')).toBe(true);
    expect(isStepUpRequiredError('Could not remove MFA factor.')).toBe(false);
    expect(isStepUpRequiredError(null)).toBe(false);
  });
});
