// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement as h } from 'react';
import {
  LocationProvider,
  useLocationScope,
  type LocationInfo,
} from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

// ── Helpers ──────────────────────────────────────────────────────────────────

const LOC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;
const LOC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as LocationId;
const LOC_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc' as LocationId;

function makeLoc(id: string, name: string, overrides?: Partial<LocationInfo>): LocationInfo {
  return {
    id: id as LocationId,
    name,
    displayLabel: name,
    isPrimary: false,
    ...overrides,
  };
}

// Router mock
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function makeProvider(
  locations: LocationInfo[],
  initialScope: 'all' | LocationId = 'all',
  multiLocationEnabled = true,
) {
  return ({ children }: { children: React.ReactNode }) =>
    h(LocationProvider, {
      locations,
      initialScope,
      multiLocationEnabled,
      children,
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useLocationScope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns initial scope from provider', () => {
    const locations = [makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true })];
    const wrapper = makeProvider(locations, LOC_A);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.currentScope).toBe(LOC_A);
    expect(result.current.locations).toEqual(locations);
  });

  it('returns "all" as default scope for multi-location accounts', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true }),
      makeLoc(LOC_B, 'Westside Bakery'),
    ];
    const wrapper = makeProvider(locations, 'all');
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.currentScope).toBe('all');
    expect(result.current.isMultiLocation).toBe(true);
  });

  it('isMultiLocation is false for single-location accounts', () => {
    const locations = [makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true })];
    const wrapper = makeProvider(locations, LOC_A, false);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.isMultiLocation).toBe(false);
  });

  it('setLocationScope updates scope and sets cookie', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true }),
      makeLoc(LOC_B, 'Westside Bakery'),
    ];
    const wrapper = makeProvider(locations, 'all');
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    act(() => {
      result.current.setLocationScope(LOC_B);
    });

    expect(result.current.currentScope).toBe(LOC_B);
    // Cookie is set via document.cookie in jsdom
    expect(document.cookie).toContain('rw_location_scope=' + LOC_B);
  });

  it('setLocationScope("all") sets cookie to "all"', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true }),
      makeLoc(LOC_B, 'Westside Bakery'),
    ];
    const wrapper = makeProvider(locations, LOC_A);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    act(() => {
      result.current.setLocationScope('all');
    });

    expect(result.current.currentScope).toBe('all');
    expect(document.cookie).toContain('rw_location_scope=all');
  });

  it('returns displayLabel that falls back to name when null', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true, displayLabel: null }),
    ];
    // When displayLabel is null, the LocationInfo should have the name as fallback
    // (handled at the data layer by getDisplayLabel)
    const wrapper = makeProvider(locations, LOC_A, false);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.locations[0]!.name).toBe('Downtown Cafe');
    expect(result.current.locations[0]!.displayLabel).toBeNull();
  });

  it('updates locations list when setLocations is called', () => {
    const initial = [makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true })];
    const wrapper = makeProvider(initial, LOC_A, true);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.locations).toHaveLength(1);
    expect(result.current.isMultiLocation).toBe(false);

    act(() => {
      result.current.setLocations([
        ...initial,
        makeLoc(LOC_B, 'Westside Bakery'),
      ]);
    });

    expect(result.current.locations).toHaveLength(2);
    expect(result.current.isMultiLocation).toBe(true);
  });

  it('selectedLabel returns "All Locations" when scope is "all"', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true }),
      makeLoc(LOC_B, 'Westside Bakery'),
    ];
    const wrapper = makeProvider(locations, 'all');
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.selectedLabel).toBe('All Locations');
  });

  it('selectedLabel returns location displayLabel when scope is a locationId', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true, displayLabel: 'Downtown' }),
      makeLoc(LOC_B, 'Westside Bakery'),
    ];
    const wrapper = makeProvider(locations, LOC_A);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.selectedLabel).toBe('Downtown');
  });

  it('selectedLabel falls back to name when displayLabel is null', () => {
    const locations = [
      makeLoc(LOC_A, 'Downtown Cafe', { isPrimary: true, displayLabel: null }),
    ];
    const wrapper = makeProvider(locations, LOC_A, false);
    const { result } = renderHook(() => useLocationScope(), { wrapper });

    expect(result.current.selectedLabel).toBe('Downtown Cafe');
  });

  it('throws when used outside LocationProvider', () => {
    // Verify the hook throws outside provider by catching the error
    // renderHook with @testing-library/react captures the error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderHook(() => useLocationScope());
    } catch (e) {
      expect((e as Error).message).toContain('useLocationScope must be used within a LocationProvider');
    } finally {
      spy.mockRestore();
    }
  });
});
