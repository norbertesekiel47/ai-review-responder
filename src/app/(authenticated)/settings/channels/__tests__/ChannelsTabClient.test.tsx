// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChannelsTabClient, SAVE_BAR_COMMIT_NOTE } from '../ChannelsTabClient';

const { mockForm } = vi.hoisted(() => ({
  mockForm: {
    data: { business: { name: 'Acme', createdAt: '2026-01-01' }, settings: { ownerEmail: 'owner@example.com' } },
    form: { ownerPhone: '', weeklySummaryEnabled: true, monthlyImpactEnabled: false },
    initial: null,
    fetchError: null,
    saveError: null,
    saving: false,
    savedFlash: false,
    dirty: false,
    dirtyCount: 0,
    set: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  },
}));

vi.mock('@/hooks/useSettingsForm', () => ({ useSettingsForm: () => mockForm }));
vi.mock('../ChannelsClient', () => ({ ChannelsClient: () => <div data-testid="channels" /> }));
vi.mock('@/components/dashboard/settings/PerLocationOverridePanel', () => ({
  PerLocationOverridePanel: () => null,
}));

const props = {
  initialEnrollments: [],
  initialAvailability: { telegram: false, whatsapp: false },
  ownerEmailFallback: 'owner@example.com',
  canAddOverrides: false,
  perLocationOverrides: [],
  locationOptions: [],
  verifiedOrgChannels: [],
};

// S13: one page, two commit models — each save-bar section says so in its header.
describe('ChannelsTabClient commit-model labels', () => {
  it('labels both save-bar sections with the Save-button note', () => {
    render(<ChannelsTabClient {...props} />);
    const sections = screen
      .getAllByText(SAVE_BAR_COMMIT_NOTE)
      .map((note) => note.closest('.set-section')?.textContent ?? '');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('Reports & summaries');
    expect(sections[1]).toContain('Contact details');
  });
});
