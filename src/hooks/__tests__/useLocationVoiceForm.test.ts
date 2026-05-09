import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
