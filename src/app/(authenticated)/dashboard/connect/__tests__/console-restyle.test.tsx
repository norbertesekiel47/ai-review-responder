// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';

const { mockUseDashboardData, mockSearchParams } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
  mockSearchParams: { value: new URLSearchParams() },
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: PRIMARY_LOCATION_ID,
    setLocationScope: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => mockSearchParams.value,
}));

import ConnectPage from '../page';

const WARM_SELECTOR = '[class*="amber"], [class*="orange"], [class*="yellow"]';

function activeData(zernio: Record<string, unknown>) {
  return { data: { zernioConnection: zernio }, error: null, refresh: vi.fn() };
}

describe('/dashboard/connect Console restyle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.value = new URLSearchParams();
  });

  const states: Array<[string, ReturnType<typeof activeData>]> = [
    ['connect (none)', activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['reconnect (disconnected)', activeData({ status: 'disconnected', queuedReconnectCount: 2, hasUnresolvedIncident: false, lastDisconnectReason: 'revoked' })],
    ['pending', activeData({ status: 'pending', pendingFlow: { status: 'oauth_in_progress' }, queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['finalizing', activeData({ status: 'pending', pendingFlow: { status: 'finalizing' }, queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['finalize_unknown', activeData({ status: 'finalize_unknown', queuedReconnectCount: 0, hasUnresolvedIncident: false })],
  ];

  it.each(states)('renders %s with no amber/orange/yellow classes', (_label, value) => {
    mockUseDashboardData.mockReturnValue(value);
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('renders the read-only billing state with no warm classes', () => {
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: { status: 'disconnected', queuedReconnectCount: 1, hasUnresolvedIncident: false, lastDisconnectReason: 'revoked' },
      },
      error: null,
      refresh: vi.fn(),
    });
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('renders the page-load error with no warm classes', () => {
    mockUseDashboardData.mockReturnValue({ data: null, error: 'boom', refresh: vi.fn() });
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('uses Console .btn primitives for the connect CTA', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { getByRole } = render(<ConnectPage />);
    expect(getByRole('button', { name: /connect google business/i })).toHaveClass('btn', 'btn-primary');
  });

  it('uses Console .btn-secondary for the pending cancel control', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'pending', pendingFlow: { status: 'oauth_in_progress' }, queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { getByRole } = render(<ConnectPage />);
    expect(getByRole('button', { name: /^cancel$/i })).toHaveClass('btn', 'btn-secondary');
  });

  it('uses Console .btn-secondary for the interrupted clear-attempt control', () => {
    mockSearchParams.value = new URLSearchParams('error=state_expired');
    mockUseDashboardData.mockReturnValue(activeData({ status: 'pending', pendingFlow: { status: 'oauth_in_progress' }, queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { getByRole } = render(<ConnectPage />);
    expect(getByRole('button', { name: /clear attempt/i })).toHaveClass('btn', 'btn-secondary');
  });

  it('wraps view content in a Console .card', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { container } = render(<ConnectPage />);
    expect(container.querySelector('.content .card')).not.toBeNull();
  });
});
