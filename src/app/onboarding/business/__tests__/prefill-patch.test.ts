import { describe, it, expect } from 'vitest';
import { computePrefillPatch, type PrefillPatchInput } from '../prefill-patch';

// The three prefill modes, tested directly for the first time (#1093). They
// used to live inside an async fetch closure in StepLocation and could only be
// reached through the component.

const EMPTY: PrefillPatchInput = {
  prefill: { category: null, website: null },
  data: { category: '', website: '' },
  dirty: { category: false, website: false },
  lastPrefill: { category: null, website: null },
};

const input = (over: Partial<PrefillPatchInput>): PrefillPatchInput => ({ ...EMPTY, ...over });

describe('computePrefillPatch — mode (a), first pick', () => {
  it('fills an empty field from a place that offers a value', () => {
    const { patch } = computePrefillPatch(
      input({ prefill: { category: 'Restaurants', website: 'https://a.example' } }),
    );
    expect(patch).toEqual({ category: 'Restaurants', website: 'https://a.example' });
  });

  it('leaves a field alone when the place offers nothing', () => {
    expect(computePrefillPatch(EMPTY).patch).toEqual({});
  });
});

describe('computePrefillPatch — mode (b), re-pick of a different place', () => {
  it('overwrites an unedited value the previous place set', () => {
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: 'Bars & Nightclubs', website: null },
        data: { category: 'Restaurants', website: '' },
        lastPrefill: { category: 'Restaurants', website: null },
      }),
    );
    expect(patch.category).toBe('Bars & Nightclubs');
  });

  it('writes nothing when the new place answers the same value', () => {
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: 'Restaurants', website: 'https://a.example' },
        data: { category: 'Restaurants', website: 'https://a.example' },
        lastPrefill: { category: 'Restaurants', website: 'https://a.example' },
      }),
    );
    expect(patch).toEqual({});
  });
});

describe('computePrefillPatch — mode (c), the new place offers nothing', () => {
  it('CLEARS a value the previous prefill set', () => {
    // Keeping place A's answer while claiming to describe place B is stale data
    // masquerading as the new place's — the whole reason mode (c) exists.
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: null, website: null },
        data: { category: 'Restaurants', website: 'https://a.example' },
        lastPrefill: { category: 'Restaurants', website: 'https://a.example' },
      }),
    );
    expect(patch).toEqual({ category: '', website: '' });
  });

  it('does NOT clear a value no prefill ever set', () => {
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: null, website: null },
        data: { category: 'Restaurants', website: 'https://a.example' },
        lastPrefill: { category: null, website: null },
      }),
    );
    expect(patch).toEqual({});
  });
});

describe('computePrefillPatch — the dirty flag wins in every mode', () => {
  it('never overwrites an edited field', () => {
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: 'Restaurants', website: 'https://a.example' },
        data: { category: 'My own words', website: 'https://mine.example' },
        dirty: { category: true, website: true },
      }),
    );
    expect(patch).toEqual({});
  });

  it('never CLEARS an edited field either', () => {
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: null, website: null },
        data: { category: 'My own words', website: 'https://mine.example' },
        dirty: { category: true, website: true },
        lastPrefill: { category: 'Restaurants', website: 'https://a.example' },
      }),
    );
    expect(patch).toEqual({});
  });

  it('treats a missing dirty ref as not dirty', () => {
    const { patch } = computePrefillPatch(
      input({ prefill: { category: 'Restaurants', website: null }, dirty: null }),
    );
    expect(patch.category).toBe('Restaurants');
  });
});

describe('computePrefillPatch — the category vocabulary', () => {
  it('drops a Google category outside the 92 and treats it as absent', () => {
    // SerpAPI answers free text, so this is the COMMON path. Mode (c) applies:
    // an unofferable category is absent, not "kept from the previous place".
    const { patch } = computePrefillPatch(
      input({
        prefill: { category: 'Mexican restaurant', website: 'https://b.example' },
        data: { category: 'Restaurants', website: '' },
        lastPrefill: { category: 'Restaurants', website: null },
      }),
    );
    expect(patch.category).toBe('');
    expect(patch.website).toBe('https://b.example');
  });

  it('accepts a Google category that does spell one of the 92', () => {
    const { patch } = computePrefillPatch(
      input({ prefill: { category: '  restaurants ', website: null } }),
    );
    expect(patch.category).toBe('Restaurants');
  });
});

describe('computePrefillPatch — the snapshot', () => {
  it('records the NORMALIZED prefill, even when the patch is empty', () => {
    const { patch, nextLastPrefill } = computePrefillPatch(
      input({
        prefill: { category: 'Mexican restaurant', website: 'https://a.example' },
        data: { category: 'My own words', website: 'https://mine.example' },
        dirty: { category: true, website: true },
      }),
    );
    expect(patch).toEqual({});
    // The dirty flag kept the owner's values, but the snapshot still records
    // what THIS place offered, so the next re-pick compares correctly.
    expect(nextLastPrefill).toEqual({ category: null, website: 'https://a.example' });
  });
});
