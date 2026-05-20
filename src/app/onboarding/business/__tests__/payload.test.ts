import { describe, expect, it } from 'vitest';
import { buildBusinessWizardPayload } from '../payload';

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
    expect(buildBusinessWizardPayload(baseData, { demoFlowEnabled: true })).not.toHaveProperty(
      'googlePlaceId',
    );
  });

  it('includes autocomplete location fields in legacy flow', () => {
    expect(buildBusinessWizardPayload(baseData, { demoFlowEnabled: false })).toMatchObject({
      businessName: 'RepWorth Cafe',
      googlePlaceId: 'place_123',
      googlePlaceAddress: '1 Main St',
    });
  });

  it('omits voice fields when skipVoice is true', () => {
    expect(
      buildBusinessWizardPayload(baseData, {
        demoFlowEnabled: false,
        skipVoice: true,
      }),
    ).not.toHaveProperty('productsServices');
  });
});
