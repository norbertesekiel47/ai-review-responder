// src/hooks/__tests__/settings-form-patch.test.ts
//
// The dirty-field vocabulary shared by useSettingsForm and useLocationVoiceForm.
// Extracting it (H5 bundle item 4) is only worth anything if the extraction is
// actually pinned: these cover every comparison branch, so a future edit to a
// single field's semantics — the `|| null` clears, the trim-and-drop on list
// fields, `false` surviving as a real value — fails here rather than in a
// rendered form.

import { describe, it, expect } from 'vitest';
import {
  buildAccountSettingsPatch,
  buildVoiceFieldsPatch,
  countDirtyFields,
  patchOrNull,
  type AccountSettingsFields,
  type VoiceFormFields,
} from '../settings-form-patch';

const VOICE: VoiceFormFields = {
  tone: 'professional',
  productsServices: 'Coffee and pastries',
  avoidFacts: ['no weekend discounts'],
  sampleResponses: ['Thanks!'],
};

const ACCOUNT: AccountSettingsFields = {
  ...VOICE,
  ownerPhone: '+15551234567',
  weeklySummaryEnabled: true,
  monthlyImpactEnabled: false,
};

describe('buildVoiceFieldsPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE })).toEqual({});
  });

  it('sends a changed tone as-is, including an empty string', () => {
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, tone: 'casual' })).toEqual({ tone: 'casual' });
    // Empty tone is a real value, NOT a clear-to-null — only productsServices
    // and ownerPhone clear.
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, tone: '' })).toEqual({ tone: '' });
  });

  it('clears productsServices to null when emptied, and sends text otherwise', () => {
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, productsServices: '' }))
      .toEqual({ productsServices: null });
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, productsServices: 'Bagels' }))
      .toEqual({ productsServices: 'Bagels' });
  });

  it('trims and drops blank lines in avoidFacts', () => {
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, avoidFacts: [' a ', '   ', 'b'] }))
      .toEqual({ avoidFacts: ['a', 'b'] });
  });

  it('trims and drops blank lines in sampleResponses', () => {
    expect(buildVoiceFieldsPatch(VOICE, { ...VOICE, sampleResponses: ['  x', '', ' y '] }))
      .toEqual({ sampleResponses: ['x', 'y'] });
  });

  it('carries every changed field at once', () => {
    const patch = buildVoiceFieldsPatch(VOICE, {
      tone: 'warm',
      productsServices: 'Tea',
      avoidFacts: [],
      sampleResponses: [],
    });
    expect(patch).toEqual({
      tone: 'warm',
      productsServices: 'Tea',
      avoidFacts: [],
      sampleResponses: [],
    });
  });
});

describe('patchOrNull', () => {
  it('returns null for an empty patch', () => {
    expect(patchOrNull({})).toBeNull();
  });

  it('returns the patch itself when it carries anything', () => {
    const patch = { tone: 'casual' };
    expect(patchOrNull(patch)).toBe(patch);
  });
});

describe('buildAccountSettingsPatch', () => {
  it('returns null when nothing changed', () => {
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT })).toBeNull();
  });

  it('includes the voice fields it shares with the Voice tab', () => {
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT, tone: 'casual' }))
      .toEqual({ tone: 'casual' });
  });

  it('clears ownerPhone to null when emptied, and sends a new number otherwise', () => {
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT, ownerPhone: '' }))
      .toEqual({ ownerPhone: null });
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT, ownerPhone: '+15559999999' }))
      .toEqual({ ownerPhone: '+15559999999' });
  });

  it('sends a toggled digest flag as its new value, false included', () => {
    // `false` must survive: an `if (value)` guard anywhere in this chain would
    // silently make "turn the weekly summary off" a no-op.
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT, weeklySummaryEnabled: false }))
      .toEqual({ weeklySummaryEnabled: false });
    expect(buildAccountSettingsPatch(ACCOUNT, { ...ACCOUNT, monthlyImpactEnabled: true }))
      .toEqual({ monthlyImpactEnabled: true });
  });

  it('carries voice and account fields together', () => {
    expect(buildAccountSettingsPatch(ACCOUNT, {
      ...ACCOUNT,
      tone: 'warm',
      ownerPhone: '',
      monthlyImpactEnabled: true,
    })).toEqual({
      tone: 'warm',
      ownerPhone: null,
      monthlyImpactEnabled: true,
    });
  });
});

describe('countDirtyFields', () => {
  it('counts zero for an identical snapshot', () => {
    expect(countDirtyFields(ACCOUNT, { ...ACCOUNT })).toBe(0);
  });

  it('counts each differing field once, arrays included', () => {
    expect(countDirtyFields(ACCOUNT, {
      ...ACCOUNT,
      tone: 'casual',
      avoidFacts: ['different', 'entries'],
    })).toBe(2);
  });

  it('compares by value, not identity — a cloned array is not dirty', () => {
    expect(countDirtyFields(ACCOUNT, { ...ACCOUNT, avoidFacts: [...ACCOUNT.avoidFacts] })).toBe(0);
  });
});
