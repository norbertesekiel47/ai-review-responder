// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';

const {
  mockUseDashboardData,
  mockSetLocationScope,
  mockRouterReplace,
  mockSearchParams,
} = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
  mockSetLocationScope: vi.fn(),
  mockRouterReplace: vi.fn(),
  mockSearchParams: { value: new URLSearchParams() },
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: PRIMARY_LOCATION_ID,
    setLocationScope: mockSetLocationScope,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

import ConnectPage from '../page';

describe('/dashboard/connect target location', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.value = new URLSearchParams(`locationId=${SECONDARY_LOCATION_ID}`);
    mockUseDashboardData.mockReturnValue({
      data: {
        zernioConnection: {
          status: 'none',
          queuedReconnectCount: 0,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'connect_pending' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  });

  it('uses the locationId query param for dashboard data and connect/start', async () => {
    const user = userEvent.setup();

    render(<ConnectPage />);

    expect(mockUseDashboardData).toHaveBeenCalledWith(
      SECONDARY_LOCATION_ID,
      expect.any(Object),
    );
    expect(mockSetLocationScope).toHaveBeenCalledWith(SECONDARY_LOCATION_ID);

    await user.click(screen.getByRole('button', { name: /connect google business/i }));

    expect(fetch).toHaveBeenCalledWith(
      '/api/zernio/connect/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ locationId: SECONDARY_LOCATION_ID }),
      }),
    );
  });

  it('passes the selected location to connect/cancel for pending flows', async () => {
    const user = userEvent.setup();
    mockUseDashboardData.mockReturnValue({
      data: {
        zernioConnection: {
          status: 'pending',
          pendingFlow: { status: 'oauth_in_progress' },
          queuedReconnectCount: 0,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    render(<ConnectPage />);
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(fetch).toHaveBeenCalledWith(
      '/api/zernio/connect/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ locationId: SECONDARY_LOCATION_ID }),
      }),
    );
  });

  it('shows manual connection link when redirect is started', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ authUrl: 'https://zernio.example/connect' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    render(<ConnectPage />);

    await user.click(screen.getByRole('button', { name: /connect google business/i }));

    const manualLink = await screen.findByRole('link', {
      name: /open connection manually/i,
    });
    expect(manualLink).toHaveAttribute('href', 'https://zernio.example/connect');
  });

  it('shows billing copy when connect/start is blocked by read-only billing state', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'past_due_read_only' }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    render(<ConnectPage />);

    await user.click(screen.getByRole('button', { name: /connect google business/i }));

    expect(await screen.findByText(/update billing before connecting google business/i))
      .toBeInTheDocument();
  });

  it('hides direct connect actions when the account is read-only', () => {
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: {
          status: 'none',
          queuedReconnectCount: 0,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });

    render(<ConnectPage />);

    expect(screen.queryByRole('button', { name: /connect google business/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/update billing/i).length).toBeGreaterThan(0);
  });

  it('hides direct reconnect actions when the account is read-only', () => {
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: {
          status: 'disconnected',
          queuedReconnectCount: 1,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });

    render(<ConnectPage />);

    expect(screen.queryByRole('button', { name: /reconnect google business/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/update billing/i).length).toBeGreaterThan(0);
  });

  it('hides direct pending-flow controls when the account is read-only', () => {
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: {
          status: 'pending',
          pendingFlow: { status: 'oauth_in_progress' },
          queuedReconnectCount: 0,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });

    render(<ConnectPage />);

    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing/i)).toBeInTheDocument();
  });

  it('hides direct stale pending-flow controls when the account is read-only', () => {
    mockSearchParams.value = new URLSearchParams(
      `locationId=${SECONDARY_LOCATION_ID}&error=state_expired`,
    );
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: {
          status: 'pending',
          pendingFlow: { status: 'oauth_in_progress' },
          queuedReconnectCount: 0,
          hasUnresolvedIncident: false,
        },
      },
      error: null,
      refresh: vi.fn(),
    });

    render(<ConnectPage />);

    expect(screen.queryByRole('button', { name: /clear attempt/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing/i)).toBeInTheDocument();
  });
});
