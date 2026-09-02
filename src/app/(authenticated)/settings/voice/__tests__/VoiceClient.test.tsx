// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceClient } from '../VoiceClient';
import type { UseLocationVoiceForm } from '@/hooks/useLocationVoiceForm';

const LOCATION_1 = 'b1111111-0000-0000-0000-000000000001';
const LOCATION_2 = 'b2222222-0000-0000-0000-000000000002';

let mockForm: UseLocationVoiceForm;
vi.mock('@/hooks/useLocationVoiceForm', () => ({
  useLocationVoiceForm: () => mockForm,
}));
vi.mock('@/components/dashboard/settings/BrandVoicePanel', () => ({
  BrandVoicePanel: () => <div data-testid="brand-voice" />,
}));
vi.mock('../VoiceReportCard', () => ({
  VoiceReportCard: () => <div data-testid="report-card" />,
}));
vi.mock('@/components/dashboard/shell/toast/ToastProvider', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function buildForm(overrides: Partial<UseLocationVoiceForm> = {}): UseLocationVoiceForm {
  return {
    locations: [
      { locationId: LOCATION_1, displayName: 'Downtown Cafe', isPrimary: true, tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [] },
      { locationId: LOCATION_2, displayName: 'Westside Bakery', isPrimary: false, tone: 'warm', productsServices: '', avoidFacts: [], sampleResponses: [] },
    ],
    selectedLocationId: LOCATION_1,
    setSelectedLocationId: vi.fn(),
    form: { tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [] },
    dirty: false,
    dirtyCount: 0,
    saving: false,
    saveError: null,
    savedFlash: false,
    set: vi.fn(),
    save: vi.fn(async () => {}),
    discard: vi.fn(),
    loading: false,
    fetchError: null,
    isMultiLocation: true,
    selectedDisplayName: 'Downtown Cafe',
    ...overrides,
  };
}

describe('VoiceClient location switching', () => {
  beforeEach(() => {
    mockForm = buildForm();
  });

  it('switches immediately when the current location has no unsaved edits', async () => {
    const user = userEvent.setup();
    render(<VoiceClient multiLocationEnabled />);

    await user.selectOptions(screen.getByLabelText('Select location for voice configuration'), LOCATION_2);

    expect(mockForm.setSelectedLocationId).toHaveBeenCalledWith(LOCATION_2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // S6: switching used to hide the save bar while the previous location's
  // edits stayed dirty in memory, invisible. The switch is now blocked until
  // the owner saves or discards.
  describe('with unsaved edits on the current location', () => {
    beforeEach(() => {
      mockForm = buildForm({ dirty: true, dirtyCount: 2 });
    });

    it('shows the unsaved pill under the selector', () => {
      render(<VoiceClient multiLocationEnabled />);
      expect(screen.getByText(/Unsaved changes for Downtown Cafe\. Save or discard them before switching\./))
        .toBeInTheDocument();
    });

    it('asks before switching and Keep editing leaves the selection alone', async () => {
      const user = userEvent.setup();
      render(<VoiceClient multiLocationEnabled />);

      await user.selectOptions(screen.getByLabelText('Select location for voice configuration'), LOCATION_2);

      const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
      expect(within(dialog).getByText(/You have 2 unsaved changes for Downtown Cafe\. Switching to Westside Bakery discards them\./))
        .toBeInTheDocument();
      expect(mockForm.setSelectedLocationId).not.toHaveBeenCalled();
      expect(mockForm.discard).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockForm.setSelectedLocationId).not.toHaveBeenCalled();
      // The select is controlled by the hook, so it still shows the current location.
      expect(screen.getByLabelText('Select location for voice configuration')).toHaveValue(LOCATION_1);
    });

    it('Discard and switch discards the current edits, then selects the new location', async () => {
      const user = userEvent.setup();
      render(<VoiceClient multiLocationEnabled />);

      await user.selectOptions(screen.getByLabelText('Select location for voice configuration'), LOCATION_2);
      await user.click(await screen.findByRole('button', { name: 'Discard and switch' }));

      expect(mockForm.discard).toHaveBeenCalledTimes(1);
      expect(mockForm.setSelectedLocationId).toHaveBeenCalledWith(LOCATION_2);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
