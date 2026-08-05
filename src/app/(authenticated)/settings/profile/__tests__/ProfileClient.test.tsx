// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileClient } from '../ProfileClient';
import {
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  type PostalAddressState,
} from '@/lib/solicitation/postal-address';

const mockForm = { fetchError: null as string | null, data: null as unknown };
vi.mock('@/hooks/useSettingsForm', () => ({ useSettingsForm: () => mockForm }));
vi.mock('@/components/dashboard/settings/DeleteDataPanel', () => ({
  DeleteDataPanel: () => <div data-testid="delete-data" />,
}));

const LOADED_SETTINGS = {
  business: { name: 'Acme Cafe' },
  settings: { category: 'Cafe', googlePlaceId: 'ChIJ123' },
};

describe('ProfileClient', () => {
  it('renders the skeleton while loading', () => {
    mockForm.data = null;
    mockForm.fetchError = null;
    render(<ProfileClient postalAddress={null} />);
    expect(document.querySelector('.set-section, [class*="skeleton"]')).toBeTruthy();
  });

  it('renders locked profile fields + danger zone once loaded', () => {
    mockForm.fetchError = null;
    mockForm.data = LOADED_SETTINGS;
    render(<ProfileClient postalAddress={null} />);
    expect(screen.getByDisplayValue('Acme Cafe')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ChIJ123')).toBeInTheDocument();
    expect(screen.getByTestId('delete-data')).toBeInTheDocument();
  });

  // #656 T5 — the page server-fetches the Attested postal address state for the
  // COOKIE-RESOLVED active location and passes it as a prop, so ProfileClient
  // renders SolicitationAddressPanel beside ProfilePanel.
  it('the profile page renders the active location postal-address state', () => {
    mockForm.fetchError = null;
    mockForm.data = LOADED_SETTINGS;
    const postalAddress: PostalAddressState = {
      address: '77 Rainey St\nAustin, TX 78701',
      attestedAt: '2026-08-01T12:00:00.000Z',
      attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
      // Suppressed server-side once an address is stored; carried through so a
      // panel that re-offered Google's string would be visible here.
      suggestion: null,
    };

    render(<ProfileClient postalAddress={postalAddress} />);

    // The prop's address — not a client fetch, and not the account's primary
    // location's address — is what the panel shows, beside the locked profile.
    expect(screen.getByLabelText('Postal address')).toHaveValue('77 Rainey St\nAustin, TX 78701');
    expect(screen.getByDisplayValue('Acme Cafe')).toBeInTheDocument();
  });
});
