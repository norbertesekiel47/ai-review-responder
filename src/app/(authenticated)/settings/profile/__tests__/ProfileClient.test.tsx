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

const POSTAL_ADDRESS: PostalAddressState = {
  address: '77 Rainey St\nAustin, TX 78701',
  attestedAt: '2026-08-01T12:00:00.000Z',
  attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
  // Suppressed server-side once an address is stored; carried through so a
  // panel that re-offered Google's string would be visible here.
  suggestion: null,
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

    render(<ProfileClient postalAddress={POSTAL_ADDRESS} />);

    // The prop's address — not a client fetch, and not the account's primary
    // location's address — is what the panel shows, beside the locked profile.
    expect(screen.getByLabelText('Postal address')).toHaveValue('77 Rainey St\nAustin, TX 78701');
    expect(screen.getByDisplayValue('Acme Cafe')).toBeInTheDocument();
  });

  // S26: the page is named Profile, so the business profile leads; the
  // review-request sender address follows; the danger zone stays terminal.
  it('orders the cards profile → sender address → danger zone', () => {
    mockForm.fetchError = null;
    mockForm.data = LOADED_SETTINGS;

    render(<ProfileClient postalAddress={POSTAL_ADDRESS} />);

    const profile = screen.getByText('Business profile');
    const address = screen.getByText('Sender postal address');
    const danger = screen.getByTestId('delete-data');
    expect(profile.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(address.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the danger zone last when there is no address panel', () => {
    mockForm.fetchError = null;
    mockForm.data = LOADED_SETTINGS;

    render(<ProfileClient postalAddress={null} />);

    const profile = screen.getByText('Business profile');
    const danger = screen.getByTestId('delete-data');
    expect(screen.queryByText('Sender postal address')).not.toBeInTheDocument();
    expect(profile.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
