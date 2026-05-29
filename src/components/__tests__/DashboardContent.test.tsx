// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseDashboardData } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: null, setLocationScope: vi.fn() }),
}));
vi.mock('@/components/dashboard/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));
vi.mock('@/components/dashboard/TopBar', () => ({ TopBar: () => null }));

import { DashboardContent } from '../DashboardContent';

describe('DashboardContent announcements (P1 #18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('announces a load error assertively', () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: 'Dashboard failed to load',
      loading: false,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    render(<DashboardContent />);

    expect(screen.getByRole('alert')).toHaveTextContent('Dashboard failed to load');
  });

  it('announces the loading state politely', () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    render(<DashboardContent />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading your dashboard');
  });
});
