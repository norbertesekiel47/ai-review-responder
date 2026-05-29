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
