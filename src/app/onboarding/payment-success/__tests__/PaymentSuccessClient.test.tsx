// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { PaymentSuccessClient } from '../PaymentSuccessClient';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pushMock.mockReset();
});

function stubFetch(body: { subscriptionStatus: string; businessOnboarded: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }),
  );
}

describe('PaymentSuccessClient', () => {
  it('acknowledges payment and routes not-onboarded users to the wizard via an explicit CTA (no auto-redirect)', async () => {
    const user = userEvent.setup();
    stubFetch({ subscriptionStatus: 'active', businessOnboarded: false });

    render(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    // Acknowledgement appears...
    expect(await screen.findByText(/payment confirmed/i)).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /continue setup/i });
    // ...and the user was NOT silently redirected.
    expect(pushMock).not.toHaveBeenCalled();

    await user.click(cta);
    expect(pushMock).toHaveBeenCalledWith('/onboarding/business');
  });

  it('shows the dashboard CTA for already-onboarded active users', async () => {
    const user = userEvent.setup();
    stubFetch({ subscriptionStatus: 'active', businessOnboarded: true });

    render(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    const cta = await screen.findByRole('button', { name: /go to dashboard/i });
    expect(pushMock).not.toHaveBeenCalled();
    await user.click(cta);
    expect(pushMock).toHaveBeenCalledWith('/dashboard');
  });

  it('renders a contact-support mailto link on the 5-minute timeout state', async () => {
    // Simulate the 5-minute timeout by making Date.now() always return a value
    // well past MAX_POLL_DURATION_MS from the moment the component mounts.
    // The first poll() call sets elapsed = Date.now() - startedAt ≈ 0 initially,
    // then on the SECOND call startedAt has already been captured, so we need
    // Date.now() to return different values: first call (startedAt capture) returns
    // a base; subsequent calls return base + 400_000 (> 300_000 cap).
    const base = 1_000_000;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // First call: startedAt initialization; all subsequent: after-fetch checks
      return callCount++ === 0 ? base : base + 400_000;
    });
    // Always-pending status so the poll loop doesn't activate.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ subscriptionStatus: 'incomplete', businessOnboarded: false }),
      }),
    );

    render(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    // The first poll completes immediately (fetch mock resolves as microtask).
    // After fetch resolves, setElapsed(400_000) fires, and the loop returns
    // (400_000 > MAX_POLL_DURATION_MS). findByRole waits for React to flush.
    const link = await screen.findByRole('link', { name: /contact support/i });
    expect(link).toHaveAttribute('href', 'mailto:support@repworth.net');
  });

  it('routes to login on a 401 (session expired) — unchanged behavior', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );

    render(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        '/login?error=session_expired&from=/onboarding/payment-success',
      ),
    );
  });
});
