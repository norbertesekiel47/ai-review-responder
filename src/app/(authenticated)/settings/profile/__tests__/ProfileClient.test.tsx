// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileClient } from '../ProfileClient';

const mockForm = { fetchError: null as string | null, data: null as unknown };
vi.mock('@/hooks/useSettingsForm', () => ({ useSettingsForm: () => mockForm }));
vi.mock('@/components/dashboard/settings/DeleteDataPanel', () => ({
  DeleteDataPanel: () => <div data-testid="delete-data" />,
}));

describe('ProfileClient', () => {
  it('renders the skeleton while loading', () => {
    mockForm.data = null;
    mockForm.fetchError = null;
    render(<ProfileClient />);
    expect(document.querySelector('.set-section, [class*="skeleton"]')).toBeTruthy();
  });

  it('renders locked profile fields + danger zone once loaded', () => {
    mockForm.fetchError = null;
    mockForm.data = {
      business: { name: 'Acme Cafe' },
      settings: { category: 'Cafe', googlePlaceId: 'ChIJ123' },
    };
    render(<ProfileClient />);
    expect(screen.getByDisplayValue('Acme Cafe')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ChIJ123')).toBeInTheDocument();
    expect(screen.getByTestId('delete-data')).toBeInTheDocument();
  });

  // #656 T5 — the page server-fetches the Attested postal address state for the
  // COOKIE-RESOLVED active location and passes it as a prop, so ProfileClient
  // renders SolicitationAddressPanel beside ProfilePanel. Pending placeholder
  // written by T1 (the eval task).
  it.todo('the profile page renders the active location postal-address state');
});
