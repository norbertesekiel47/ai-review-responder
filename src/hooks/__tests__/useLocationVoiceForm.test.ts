// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ── Mock fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ── Test data ─────────────────────────────────────────────────────────

const LOCATION_ID_1 = 'b1111111-0000-0000-0000-000000000001';
const LOCATION_ID_2 = 'b2222222-0000-0000-0000-000000000002';

const MOCK_LOCATIONS = [
  {
    locationId: LOCATION_ID_1,
    displayName: 'Downtown Cafe',
    isPrimary: true,
    tone: 'professional',
    productsServices: 'Coffee and pastries',
    avoidFacts: ['No discounts on weekends'],
    sampleResponses: ['Thanks for the kind words!'],
  },
  {
    locationId: LOCATION_ID_2,
    displayName: 'Westside Bakery',
    isPrimary: false,
    tone: 'warm, friendly',
    productsServices: 'Baked goods',
    avoidFacts: [],
    sampleResponses: [],
  },
];

// ── Tests for utility functions ─────────────────────────────────────────

describe('useLocationVoiceForm utilities', () => {
  describe('configToForm', () => {
    it('converts location config to form state', async () => {
      const { configToForm } = await import('../useLocationVoiceForm');
      const form = configToForm(MOCK_LOCATIONS[0]!);
      expect(form.tone).toBe('professional');
      expect(form.productsServices).toBe('Coffee and pastries');
      expect(form.avoidFacts).toEqual(['No discounts on weekends']);
      expect(form.sampleResponses).toEqual(['Thanks for the kind words!']);
    });

    it('creates independent copies of arrays', async () => {
      const { configToForm } = await import('../useLocationVoiceForm');
      const form = configToForm(MOCK_LOCATIONS[0]!);
      form.avoidFacts.push('new item');
      expect(MOCK_LOCATIONS[0]!.avoidFacts).not.toContain('new item');
    });
  });

  describe('buildPatch', () => {
    it('returns null when no changes', async () => {
      const { buildPatch } = await import('../useLocationVoiceForm');
      const form = { tone: 'professional', productsServices: 'test', avoidFacts: [], sampleResponses: [] };
      const result = buildPatch(form, { ...form });
      expect(result).toBeNull();
    });

    it('returns patch when tone changed', async () => {
      const { buildPatch } = await import('../useLocationVoiceForm');
      const initial = { tone: 'professional', productsServices: 'test', avoidFacts: [], sampleResponses: [] };
      const current = { ...initial, tone: 'casual' };
      const result = buildPatch(initial, current);
      expect(result).not.toBeNull();
      expect(result!.tone).toBe('casual');
    });

    it('returns patch when avoidFacts changed', async () => {
      const { buildPatch } = await import('../useLocationVoiceForm');
      const initial = { tone: 'professional', productsServices: 'test', avoidFacts: ['a'], sampleResponses: [] };
      const current = { ...initial, avoidFacts: ['a', 'b'] };
      const result = buildPatch(initial, current);
      expect(result).not.toBeNull();
      expect(result!.avoidFacts).toEqual(['a', 'b']);
    });

    it('trims and filters empty strings in avoidFacts', async () => {
      const { buildPatch } = await import('../useLocationVoiceForm');
      const initial = { tone: 'professional', productsServices: 'test', avoidFacts: ['a'], sampleResponses: [] };
      const current = { ...initial, avoidFacts: ['a ', '  ', 'b'] };
      const result = buildPatch(initial, current);
      expect(result!.avoidFacts).toEqual(['a', 'b']);
    });
  });
});

// ── Multi-location MODE is the SERVER's answer (invariants #9b + #13) ────────
//
// `shouldUseMultiLocationSettings` is `featureEnabled && activeLocationCount > 1`.
// The hook previously re-spelled only the second half as `locations.length > 1`,
// so an account with 2 active locations and MULTI_LOCATION_ENABLED=false got the
// multi-location voice UI. These tests pin BOTH directions so the count-only
// derivation cannot come back: a count-based implementation passes the "on" case
// and fails the "off" one.

describe('useLocationVoiceForm — multi-location mode comes from the server', () => {
  function mockTwoLocations(): void {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ locations: MOCK_LOCATIONS }),
    });
  }

  it('stays in single-location mode when the server says the flag is off, even with 2 locations', async () => {
    mockTwoLocations();
    const { useLocationVoiceForm } = await import('../useLocationVoiceForm');

    const { result } = renderHook(() =>
      useLocationVoiceForm({ multiLocationEnabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Two locations were loaded — the count alone would have said "multi".
    expect(result.current.locations).toHaveLength(2);
    expect(result.current.isMultiLocation).toBe(false);
  });

  it('enters multi-location mode when the server resolved it true', async () => {
    mockTwoLocations();
    const { useLocationVoiceForm } = await import('../useLocationVoiceForm');

    const { result } = renderHook(() =>
      useLocationVoiceForm({ multiLocationEnabled: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.locations).toHaveLength(2);
    expect(result.current.isMultiLocation).toBe(true);
  });

  it('reports the server answer verbatim and never AND-s a local count into it', async () => {
    // Unreachable in production (the server derives mode from the same rows),
    // but it is what kills the halfway mutant `multiLocationEnabled && count > 1`:
    // mode has ONE owner, `shouldUseMultiLocationSettings`, and the hook is not
    // allowed a second opinion.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ locations: [MOCK_LOCATIONS[0]] }),
    });
    const { useLocationVoiceForm } = await import('../useLocationVoiceForm');

    const { result } = renderHook(() =>
      useLocationVoiceForm({ multiLocationEnabled: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.locations).toHaveLength(1);
    expect(result.current.isMultiLocation).toBe(true);
  });
});
