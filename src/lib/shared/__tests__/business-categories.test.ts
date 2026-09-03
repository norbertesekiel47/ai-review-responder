import { describe, it, expect } from 'vitest';
import {
  BUSINESS_CATEGORY_GROUPS,
  BUSINESS_SUBCATEGORIES,
  isBusinessSubcategory,
} from '../business-categories';
import { resolveVertical, VERTICALS } from '@/lib/solicitation/restraint-policy';

// Eval suite for #1093. The vocabulary is only worth closing if closing it
// makes the vertical mapping TOTAL — before this, 48 of the 92 fell to `other`
// by keyword accident and two resolved wrongly.

describe('BUSINESS_CATEGORY_GROUPS', () => {
  it('carries 15 groups and 92 subcategories', () => {
    expect(BUSINESS_CATEGORY_GROUPS).toHaveLength(15);
    expect(BUSINESS_SUBCATEGORIES).toHaveLength(92);
  });

  it('has no duplicate subcategory across groups', () => {
    // A duplicate would make the stored value ambiguous about its group and
    // would silently collapse two `SUBCATEGORY_VERTICALS` keys into one.
    expect(new Set(BUSINESS_SUBCATEGORIES).size).toBe(BUSINESS_SUBCATEGORIES.length);
  });

  it('has no empty group', () => {
    for (const group of BUSINESS_CATEGORY_GROUPS) {
      expect(group.subcategories.length, `${group.category} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('isBusinessSubcategory', () => {
  it('accepts every member of the vocabulary', () => {
    for (const sub of BUSINESS_SUBCATEGORIES) expect(isBusinessSubcategory(sub)).toBe(true);
  });

  it('rejects a legacy free-text value', () => {
    // Legacy rows are a LEGAL state (#1085 chose a keyword fallback over a
    // migration), so this guard must say "not in the vocabulary", never throw.
    expect(isBusinessSubcategory("Bella's Cafe")).toBe(false);
    expect(isBusinessSubcategory('')).toBe(false);
  });

  it('is case- and whitespace-exact', () => {
    // Deliberate: an inexact match would let two different stored strings claim
    // the same vocabulary entry, which is how the keyword matcher went wrong.
    expect(isBusinessSubcategory('restaurants')).toBe(false);
    expect(isBusinessSubcategory(' Restaurants ')).toBe(false);
  });
});

describe('vertical resolution over the closed vocabulary', () => {
  it('every one of the 92 subcategories resolves to a named vertical', () => {
    for (const sub of BUSINESS_SUBCATEGORIES) {
      const { vertical } = resolveVertical(sub);
      expect(VERTICALS, `${sub} resolved outside the enum`).toContain(vertical);
    }
  });

  it('resolves a vocabulary hit without claiming a keyword matched', () => {
    // `matched_keyword` rides the withhold evidence envelope. On a table hit no
    // keyword matched, and saying otherwise would send a reader hunting a
    // keyword list that does not contain the value.
    expect(resolveVertical('Restaurants')).toEqual({
      vertical: 'food_and_drink',
      matchedKeyword: null,
    });
  });

  it('fixes Bakeries, which the plural defeated', () => {
    // `bakery` IS a food_and_drink keyword; the vocabulary is plural, so the
    // left-boundary stem never matched and this fell to `other`.
    expect(resolveVertical('Bakeries').vertical).toBe('food_and_drink');
  });

  it('fixes Grocery / Specialty Food Stores, which matched food before retail', () => {
    // `food_and_drink` is checked before `retail`, so the `food` keyword won
    // and the more specific reading never got a turn.
    expect(resolveVertical('Grocery / Specialty Food Stores').vertical).toBe('retail');
  });

  it('leaves the keyword fallback intact for legacy free text', () => {
    // #1085 chose a fallback over a migration. Every one of these predates the
    // vocabulary and must resolve exactly as it did before.
    expect(resolveVertical("Bella's Cafe")).toEqual({
      vertical: 'food_and_drink',
      matchedKeyword: 'cafe',
    });
    expect(resolveVertical('Barre Studio')).toEqual({
      vertical: 'fitness',
      matchedKeyword: 'barre',
    });
    expect(resolveVertical('Quantum Flux Consulting')).toEqual({
      vertical: 'other',
      matchedKeyword: null,
    });
  });

  it('the vocabulary WINS over a keyword that would disagree', () => {
    // The ordering contract. 'Moving & Storage' contains the `moving` keyword
    // and the table agrees; 'Grocery / Specialty Food Stores' contains `food`
    // and the table DISAGREES — that disagreement is the whole point, so the
    // table must be consulted first.
    expect(resolveVertical('Grocery / Specialty Food Stores').matchedKeyword).toBeNull();
  });
});
