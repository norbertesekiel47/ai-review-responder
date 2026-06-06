// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountOffboardingPanel } from '@/components/dashboard/settings/AccountOffboardingPanel';

describe('AccountOffboardingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'idem-test-key') });
  });

  it('confirms cancel-only offboarding with a reason code and stable idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        enabled: true,
        activeOffboarding: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        offboarding: { id: 'off_1', mode: 'cancel_only', status: 'pending' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AccountOffboardingPanel accountTimeZone="UTC" onAccountRefetch={vi.fn()} />);

    expect(await screen.findByText('Cancel RepWorth')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await user.click(screen.getByLabelText('Too expensive'));
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/offboarding/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-test-key',
      },
      body: JSON.stringify({ mode: 'cancel_only', reasonCode: 'too_expensive' }),
    });
  });

  it('shows scheduled access end in the account timezone and reactivates with an idempotency key', async () => {
    const onAccountRefetch = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        enabled: true,
        activeOffboarding: {
          id: 'off_1',
          mode: 'cancel_only',
          status: 'scheduled',
          accessEndsAt: '2026-07-10T17:30:00.000Z',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        offboarding: { id: 'off_1', mode: 'cancel_only', status: 'reactivated' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AccountOffboardingPanel accountTimeZone="America/New_York" onAccountRefetch={onAccountRefetch} />);

    expect(await screen.findByText(/Access stays active until Jul 10, 2026, 1:30 PM EDT/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep subscription active' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/offboarding/reactivate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-test-key',
      },
    });
    await waitFor(() => expect(onAccountRefetch).toHaveBeenCalled());
  });

  it('does not render when the server reports offboarding disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      enabled: false,
      activeOffboarding: null,
    })));

    const { container } = render(<AccountOffboardingPanel accountTimeZone="UTC" onAccountRefetch={vi.fn()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}
