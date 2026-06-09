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

  it('confirms delete-data offboarding with password reauth, type-to-confirm, and reason code only', async () => {
    const onAccountRefetch = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        enabled: true,
        activeOffboarding: null,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        offboarding: { id: 'off_delete_1', mode: 'delete_data', status: 'pending' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AccountOffboardingPanel accountTimeZone="UTC" onAccountRefetch={onAccountRefetch} />);

    expect(await screen.findByText('Cancel RepWorth')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete data' }));

    expect(screen.getByText(/stops review processing immediately/i)).toBeInTheDocument();
    expect(screen.getByText(/cancels billing and disconnects Google publishing/i)).toBeInTheDocument();
    expect(screen.getByText(/30-day deletion window/i)).toBeInTheDocument();
    expect(screen.getByText(/retain records we are legally required to keep/i)).toBeInTheDocument();
    expect(screen.getByText(/current billing period is forfeited and non-refundable/i)).toBeInTheDocument();
    expect(screen.getByText(/no self-serve export/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Switched service'));
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Type DELETE DATA'), 'DELETE DATA');
    await user.click(screen.getByRole('button', { name: 'Confirm delete data' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/account/offboarding/fresh-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/account/offboarding/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-test-key',
      },
      body: JSON.stringify({
        mode: 'delete_data',
        reasonCode: 'switched_service',
        confirmationText: 'DELETE DATA',
      }),
    });
    expect(JSON.stringify(fetchMock.mock.calls[2])).not.toContain('feedback');
    await waitFor(() => expect(onAccountRefetch).toHaveBeenCalled());
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
