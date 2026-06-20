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
});
