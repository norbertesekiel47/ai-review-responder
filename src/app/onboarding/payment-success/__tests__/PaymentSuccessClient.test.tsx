// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { PaymentSuccessClient } from '../PaymentSuccessClient';

// PaymentSuccessClient uses useQuery; in production it inherits the QueryClient
// from the root layout's RootProviders. Tests render it in isolation, so they
// must supply their own client.
function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

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

    renderWithClient(<PaymentSuccessClient checkoutSessionId="cs_test" />);

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

    renderWithClient(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    const cta = await screen.findByRole('button', { name: /go to dashboard/i });
    expect(pushMock).not.toHaveBeenCalled();
    await user.click(cta);
    expect(pushMock).toHaveBeenCalledWith('/dashboard');
  });

  it('renders a contact-support mailto link once the poll attempt cap is exhausted', async () => {
    vi.useFakeTimers();
    // Always-pending status so the poll never activates and burns through every
    // retry attempt until the cap, switching to the "Still processing…" state.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ subscriptionStatus: 'incomplete', businessOnboarded: false }),
      }),
    );

    renderWithClient(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    // Drive every scheduled retry. The cadence is fixed (2s per attempt) over a
    // bounded attempt cap; stepping past each retry delay exhausts the cap and
    // switches to the "Still processing…" state. Step per-attempt so each
    // retry's resolve + re-render + reschedule flushes. Assert synchronously
    // after the flush — findByRole's waitFor polls on real timers, which never
    // advance under fake timers (deadlock).
    await act(async () => {
      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }
    });

    const link = screen.getByRole('link', { name: /contact support/i });
    expect(link).toHaveAttribute('href', 'mailto:support@repworth.net');
  }, 30_000);

  it('routes to login on a 401 (session expired) — unchanged behavior', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );

    renderWithClient(<PaymentSuccessClient checkoutSessionId="cs_test" />);

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        '/login?error=session_expired&from=/onboarding/payment-success',
      ),
    );
  });
});
