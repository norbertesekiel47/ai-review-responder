import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAllLocationsForAccount } = vi.hoisted(() => ({
  mockGetAllLocationsForAccount: vi.fn(),
}));

vi.mock('../repo', () => ({
  getAllLocationsForAccount: (...args: unknown[]) => mockGetAllLocationsForAccount(...args),
}));

import { getLocationLabelMap } from '../location-label-map';

function locationRow(overrides: Record<string, unknown>) {
  return {
    id: 'loc-1',
    account_id: 'acct-1',
    name: 'Fallback Name',
    display_label: null,
    is_primary: false,
    archived_at: null,
    google_place_id: null,
    google_place_address: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('getLocationLabelMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds {label, archived} from ONE all-locations query — active and archived, no suffix stamping', async () => {
    mockGetAllLocationsForAccount.mockResolvedValueOnce([
      locationRow({ id: 'loc-active', display_label: 'Downtown', archived_at: null }),
      locationRow({ id: 'loc-archived', display_label: 'Uptown', archived_at: new Date('2026-03-01T00:00:00.000Z') }),
      locationRow({ id: 'loc-name-fallback', name: 'No Label Cafe', display_label: null }),
    ]);

    const labelMap = await getLocationLabelMap('acct-1');

    expect(mockGetAllLocationsForAccount).toHaveBeenCalledTimes(1);
    expect(mockGetAllLocationsForAccount).toHaveBeenCalledWith('acct-1');

    expect(labelMap.get('loc-active')).toEqual({ label: 'Downtown', archived: false });
    // Archived state is a flag — the label never carries an "(archived)" suffix.
    expect(labelMap.get('loc-archived')).toEqual({ label: 'Uptown', archived: true });
    // display_label NULL falls back to name (canonical getDisplayLabel behavior).
    expect(labelMap.get('loc-name-fallback')).toEqual({ label: 'No Label Cafe', archived: false });
  });

  it('returns an empty map for an account with no locations', async () => {
    mockGetAllLocationsForAccount.mockResolvedValueOnce([]);
    const labelMap = await getLocationLabelMap('acct-1');
    expect(labelMap.size).toBe(0);
  });
});
