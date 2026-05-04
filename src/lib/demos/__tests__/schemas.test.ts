import { describe, it, expect } from 'vitest';
import { OnboardingStartSchema, BusinessOnboardingPostPaySchema } from '@/lib/shared/schemas';

describe('OnboardingStartSchema', () => {
  it('accepts valid autocomplete payload', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme Cafe',
      prefilledCategory: 'Restaurant',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid URL payload', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'url',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when neither placeId nor mapsUrl provided', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when both placeId and mapsUrl provided', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects prefilledCategory in URL mode', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'url',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
      prefilledCategory: 'Restaurant',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName with newlines', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme\nCafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName with angle brackets', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme <script>',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName > 80 chars', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'A'.repeat(81),
    });
    expect(result.success).toBe(false);
  });
});

describe('BusinessOnboardingPostPaySchema', () => {
  it('accepts voice/profile payload', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      tone: 'casual',
      productsServices: 'Coffee',
    });
    expect(result.success).toBe(true);
  });

  it('rejects googlePlaceId', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      tone: 'casual',
    });
    expect(result.success).toBe(false);
  });

  it('rejects googleMapsUrl', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      tone: 'casual',
    });
    expect(result.success).toBe(false);
  });
});
