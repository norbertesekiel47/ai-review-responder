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

// S25: the card wears the stylesheet's destructive treatment, so it cannot be
// mistaken for its neighbours.
it('renders as a danger-zone card', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: null } };
  const { container } = render(<DeleteDataPanel />);
  const card = container.firstElementChild;
  expect(card).toHaveClass('set-section', 'danger');
  // No amber in the Console palette: the icon well is the blush/rose role.
  expect(card?.querySelector('.set-section-icon')).toHaveClass('rose');
  expect(card?.querySelector('.set-section-icon.amber')).toBeNull();
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
