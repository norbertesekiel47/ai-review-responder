// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeleteDataPanel } from '../DeleteDataPanel';
import type { OffboardingStatus } from '@/hooks/useOffboardingStatus';

vi.mock('@/hooks/useOffboardingStatus', () => ({
  useOffboardingStatus: () => mockHook,
}));
vi.mock('../DeleteDataOffboardingModal', () => ({
  DeleteDataOffboardingModal: () => <div data-testid="delete-modal" />,
}));

let mockHook: { status: OffboardingStatus | null; loadError: string | null; setStatus: () => void; refetch: () => void };
const base = { loadError: null, setStatus: vi.fn(), refetch: vi.fn() };

it('renders nothing when offboarding disabled', () => {
  mockHook = { ...base, status: { enabled: false, activeOffboarding: null } };
  const { container } = render(<DeleteDataPanel />);
  expect(container).toBeEmptyDOMElement();
});

it('shows the Delete data button when no offboarding is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: null } };
  render(<DeleteDataPanel />);
  expect(screen.getByRole('button', { name: /delete data/i })).toBeInTheDocument();
});

it('blocks delete when a cancellation is scheduled', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'cancel_only', status: 'scheduled' } } };
  render(<DeleteDataPanel />);
  expect(screen.queryByRole('button', { name: /delete data/i })).not.toBeInTheDocument();
  expect(screen.getByText(/scheduled cancellation/i)).toBeInTheDocument();
});

it('shows in-progress when a deletion is already active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'delete_data', status: 'pending' } } };
  render(<DeleteDataPanel />);
  expect(screen.getByText(/deletion is in progress/i)).toBeInTheDocument();
});
