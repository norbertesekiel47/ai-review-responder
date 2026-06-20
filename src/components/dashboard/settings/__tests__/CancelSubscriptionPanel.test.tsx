// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CancelSubscriptionPanel } from '../CancelSubscriptionPanel';
import type { OffboardingStatus } from '@/hooks/useOffboardingStatus';

let mockHook: { status: OffboardingStatus | null; loadError: string | null; setStatus: () => void; refetch: () => void };
const base = { loadError: null, setStatus: vi.fn(), refetch: vi.fn() };
vi.mock('@/hooks/useOffboardingStatus', () => ({ useOffboardingStatus: () => mockHook }));

it('renders nothing when offboarding disabled', () => {
  mockHook = { ...base, status: { enabled: false, activeOffboarding: null } };
  const { container } = render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(container).toBeEmptyDOMElement();
});

it('shows the Cancel subscription button when no offboarding is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: null } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.getByRole('button', { name: /cancel subscription/i })).toBeInTheDocument();
});

it('shows reactivate UI when a cancellation is scheduled', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'cancel_only', status: 'scheduled', accessEndsAt: '2026-07-01T00:00:00Z' } } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.getByRole('button', { name: /keep subscription active/i })).toBeInTheDocument();
});

it('disables cancel when a data deletion is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'delete_data', status: 'pending' } } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument();
  expect(screen.getByText(/deletion is in progress/i)).toBeInTheDocument();
});
