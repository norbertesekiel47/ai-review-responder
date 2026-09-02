import { describe, expect, it } from 'vitest';
import { buildBusinessWizardPayload, initialWizardFormData } from '../payload';

const baseData = {
  inputMode: 'autocomplete' as const,
  googlePlaceId: 'place_123',
  googlePlaceAddress: '1 Main St',
  googleMapsUrl: '',
  businessName: 'RepWorth Cafe',
  category: 'Cafe',
  website: 'https://example.com',
  tone: 'warm',
  productsServices: 'Coffee',
  staffNames: 'Nora',
  highlightFacts: 'Fast service',
  avoidFacts: 'No discounts',
  sampleResponses: 'Thanks!',
};

describe('buildBusinessWizardPayload', () => {
  it('excludes location fields in demo flow', () => {
    const payload = buildBusinessWizardPayload(baseData, { demoFlowEnabled: true });

    expect(payload).not.toHaveProperty('googlePlaceId');
    expect(payload).not.toHaveProperty('googlePlaceAddress');
    expect(payload).not.toHaveProperty('googleMapsUrl');
  });

  it('includes autocomplete location fields in legacy flow', () => {
    expect(buildBusinessWizardPayload(baseData, { demoFlowEnabled: false })).toMatchObject({
      businessName: 'RepWorth Cafe',
      googlePlaceId: 'place_123',
      googlePlaceAddress: '1 Main St',
    });
  });

  it('omits voice fields when skipVoice is true', () => {
    const payload = buildBusinessWizardPayload(baseData, {
      demoFlowEnabled: false,
      skipVoice: true,
    });

    expect(payload).not.toHaveProperty('productsServices');
    expect(payload).not.toHaveProperty('staffNames');
    expect(payload).not.toHaveProperty('highlightFacts');
    expect(payload).not.toHaveProperty('avoidFacts');
    expect(payload).not.toHaveProperty('sampleResponses');
  });

  it('includes URL location fields in legacy URL mode', () => {
    expect(
      buildBusinessWizardPayload(
        {
          ...baseData,
          inputMode: 'url',
          googleMapsUrl: 'https://maps.google.com/?cid=123',
        },
        { demoFlowEnabled: false },
      ),
    ).toMatchObject({
      businessName: 'RepWorth Cafe',
      googlePlaceId: undefined,
      googlePlaceAddress: undefined,
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    });
  });
});

describe('initialWizardFormData', () => {
  it('seeds the Profile fields from the server row and starts Location empty', () => {
    const data = initialWizardFormData({
      category: 'Cafe',
      website: 'https://example.com',
      businessName: 'RepWorth Cafe',
    });

    expect(data).toMatchObject({
      businessName: 'RepWorth Cafe',
      category: 'Cafe',
      website: 'https://example.com',
      inputMode: 'autocomplete',
      googlePlaceId: '',
      googlePlaceAddress: '',
      googleMapsUrl: '',
      tone: 'professional and friendly',
    });
  });

  it('falls back to empty Profile fields when the page passes no seed', () => {
    const data = initialWizardFormData();

    expect(data.businessName).toBe('');
    expect(data.category).toBe('');
    expect(data.website).toBe('');
    // Voice starts blank — empty strings collapse to undefined in the payload.
    expect(buildBusinessWizardPayload(data, { demoFlowEnabled: true })).toEqual({
      tone: 'professional and friendly',
    });
  });
});
