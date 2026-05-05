import { fallbackReviews } from './__fixtures__/fallback-source-reviews';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

export interface FallbackDemo {
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
}

const CATEGORIES: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'restaurant',
  coffee: 'restaurant',
  salon: 'salon',
  barber: 'salon',
  hair: 'salon',
  dentist: 'dentist',
  dental: 'dentist',
  gym: 'gym',
  fitness: 'gym',
  'auto repair': 'auto-repair',
  mechanic: 'auto-repair',
  'real estate': 'real-estate',
  realtor: 'real-estate',
  contractor: 'contractor',
  construction: 'contractor',
  retail: 'retail',
  store: 'retail',
  shop: 'retail',
  'professional services': 'professional-services',
  lawyer: 'professional-services',
  accountant: 'professional-services',
  healthcare: 'healthcare-other',
  clinic: 'healthcare-other',
  beauty: 'beauty-other',
  spa: 'beauty-other',
};

function normalizeCategory(raw: string | null): string {
  if (!raw) return 'general-business';
  const lower = raw.toLowerCase();
  for (const [prefix, canonical] of Object.entries(CATEGORIES)) {
    if (lower.includes(prefix)) return canonical;
  }
  return 'general-business';
}

const GENERAL_BUSINESS_FALLBACK: FallbackDemo = {
  reviews: fallbackReviews,
  responses: [
    {
      responseText:
        "Thank you so much, Sarah! We're thrilled you had a wonderful experience. Our team works hard to make every visit special, and we can't wait to welcome you back!",
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 200, completionTokens: 45 },
      costUsd: 0.005,
      apiCostId: null,
    },
    {
      responseText:
        "Thanks for the kind words, James! We're glad you enjoyed the atmosphere. We're always looking to improve, and appreciate your patience during busy times.",
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 200, completionTokens: 42 },
      costUsd: 0.005,
      apiCostId: null,
    },
    {
      responseText:
        "Hi Patricia, thank you for giving us a try and for the honest feedback. We'd love the chance to exceed your expectations on your next visit — please reach out if there's anything specific we can do better.",
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 200, completionTokens: 48 },
      costUsd: 0.005,
      apiCostId: null,
    },
  ],
};

const FALLBACKS: Record<string, FallbackDemo> = {
  'general-business': GENERAL_BUSINESS_FALLBACK,
};

/**
 * Returns curated fallback demo content for a given category.
 * All categories currently share the general-business fixture.
 * Per-category fixtures are generated via `scripts/generate-fallback-demos.ts`
 * and committed as additional entries in FALLBACKS.
 */
export function getFallbackDemo(category: string | null): FallbackDemo {
  const key = normalizeCategory(category);
  return FALLBACKS[key] ?? GENERAL_BUSINESS_FALLBACK;
}
