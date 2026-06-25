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
});
