// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { redirectAfterServerSessionCookie } from '../CheckEmailClient.helpers';
import { CheckEmailClient } from '../CheckEmailClient';
import { EMAIL_OTP_LENGTH, EMAIL_OTP_PATTERN } from '@/lib/shared/schemas';

// Mock next/navigation's useSearchParams
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

import { useSearchParams } from 'next/navigation';

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Helper unit tests (pre-existing, kept verbatim)
// ---------------------------------------------------------------------------

describe('redirectAfterServerSessionCookie', () => {
  it('uses a full document navigation to the verified onboarding target', () => {
    const assign = vi.fn();

    redirectAfterServerSessionCookie('/onboarding/start', assign);

    expect(assign).toHaveBeenCalledWith('/onboarding/start');
  });

  it('falls back to the paywall for unsafe or missing targets', () => {
    const assign = vi.fn();

    redirectAfterServerSessionCookie('//evil.example', assign);
    redirectAfterServerSessionCookie(undefined, assign);

    expect(assign).toHaveBeenNthCalledWith(1, '/onboarding/pay');
    expect(assign).toHaveBeenNthCalledWith(2, '/onboarding/pay');
  });
});

// ---------------------------------------------------------------------------
// Presentational / a11y tests (new)
// ---------------------------------------------------------------------------

describe('CheckEmailClient branding + a11y', () => {
  it('renders the branded island, not gray', () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'email' ? 'a@b.co' : null),
    });

    const { container } = render(<CheckEmailClient />);
    expect(container.innerHTML).toContain('bg-rw-sage');
    expect(container.innerHTML).not.toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-blue-600');
  });

  it('drives the OTP input contract from EMAIL_OTP_LENGTH (numeric, 16px)', () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'email' ? 'a@b.co' : null),
    });

    const { container } = render(<CheckEmailClient />);
    const input = container.querySelector('input#verify-code');
    expect(input).not.toBeNull();
    // Length is the single source of truth — assert against the constant, not a
    // hardcoded literal, so the input can never silently drift from it.
    expect(input!.getAttribute('pattern')).toBe(EMAIL_OTP_PATTERN);
    expect(input!.getAttribute('pattern')).toBe(`\\d{${EMAIL_OTP_LENGTH}}`);
    expect(input!.getAttribute('minlength')).toBe(String(EMAIL_OTP_LENGTH));
    expect(input!.getAttribute('maxlength')).toBe(String(EMAIL_OTP_LENGTH));
    expect(EMAIL_OTP_LENGTH).toBe(6);
    expect(input!.getAttribute('inputmode')).toBe('numeric');
    expect(input!.className).toContain('text-base');
  });

  it('points the back link at /login when the owner arrived from login (A1)', () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'from' ? 'login' : null),
    });

    render(<CheckEmailClient />);
    const back = screen.getByRole('link', { name: /back to log in/i });
    expect(back).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: /change email/i })).toBeNull();
  });

  it('points the back link at /signup for the self-serve path (A1)', () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'email' ? 'a@b.co' : null),
    });

    render(<CheckEmailClient />);
    expect(screen.getByRole('link', { name: /go back and change email/i })).toHaveAttribute(
      'href',
      '/signup',
    );
  });

  it('announces verify errors via role=alert live region', async () => {
    // No email in searchParams → submit triggers the no-email guard (no fetch needed)
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: () => null,
    });

    render(<CheckEmailClient />);
    fireEvent.submit(
      screen.getByRole('button', { name: /verify and continue/i }).closest('form')!,
    );
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((el) => /no email on this page/i.test(el.textContent ?? ''))).toBe(true);
    });
  });

  it('renders a visible label for the code field (A22)', () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'email' ? 'a@b.co' : null),
    });

    render(<CheckEmailClient />);
    const label = screen.getByText('Confirmation code');
    expect(label.tagName).toBe('LABEL');
    expect(label.className).not.toContain('sr-only');
    expect(screen.getByLabelText('Confirmation code')).not.toBeDisabled();
    // The always-mounted LiveRegions are empty; no notice is showing.
    for (const region of screen.getAllByRole('alert')) {
      expect(region).toHaveTextContent('');
    }
  });

  it('shows the start-again notice immediately when no email is known, and disables verify (A22)', async () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({ get: () => null });

    render(<CheckEmailClient />);

    // Visible notice (a <p>), present BEFORE any submit — the LiveRegions are
    // separate, always-mounted sr-only regions.
    const notice = await screen.findByText(/no email on this page/i, { selector: 'p' });
    expect(notice).toHaveAttribute('role', 'alert');
    expect(screen.getByLabelText('Confirmation code')).toBeDisabled();
    expect(screen.getByRole('button', { name: /verify and continue/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /go back and change email/i })).toHaveAttribute(
      'href',
      '/signup',
    );
  });

  it('points the missing-email notice back to log in for the login path (A22)', async () => {
    (useSearchParams as ReturnType<typeof vi.fn>).mockReturnValue({
      get: (key: string) => (key === 'from' ? 'login' : null),
    });

    render(<CheckEmailClient />);

    expect(
      await screen.findByText(/go back to log in and try again/i, { selector: 'p' }),
    ).toBeInTheDocument();
  });
});
