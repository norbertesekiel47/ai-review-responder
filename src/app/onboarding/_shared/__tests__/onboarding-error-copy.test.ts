import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_CONNECTION_FAILED,
  ONBOARDING_ERROR_COPY,
  ONBOARDING_ERROR_FALLBACK,
  mapOnboardingApiError,
} from '../onboarding-error-copy';

// Every `error` code the two onboarding routes can emit. Keep in lockstep with
// `src/app/api/onboarding/{start,business}/route.ts` — a new code with no row
// here would fall back to the generic sentence (safe) but lose its specific copy.
const START_CODES = [
  'not_found',
  'forbidden',
  'unauthorized',
  'account_incomplete',
  'subscription_inactive',
  'rate_limited',
  'rate_limit_unavailable',
  'invalid_json',
  'invalid_body',
  'redis_unavailable',
  'internal_error',
];
const BUSINESS_CODES = [
  'forbidden',
  'unauthorized',
  'account_incomplete',
  'subscription_inactive',
  'onboarding_not_started',
  'already_onboarded',
  'rate_limited',
  'rate_limit_unavailable',
  'invalid_json',
  'invalid_body',
  'internal_error',
];

const RAW_CODE = /^[a-z]+(_[a-z]+)+$/; // snake_case machine codes

describe('ONBOARDING_ERROR_COPY', () => {
  it.each([...new Set([...START_CODES, ...BUSINESS_CODES])])(
    'maps %s to a plain sentence, not a code',
    (code) => {
      const copy = ONBOARDING_ERROR_COPY[code];
      expect(copy).toBeDefined();
      expect(copy).not.toMatch(RAW_CODE);
      expect(copy).toMatch(/[.!]$/);
    },
  );

  it('uses no internal nouns', () => {
    for (const copy of Object.values(ONBOARDING_ERROR_COPY)) {
      expect(copy).not.toMatch(/\b(redis|zernio|worker|json|payload|body)\b/i);
    }
  });
});

describe('mapOnboardingApiError', () => {
  it('maps a known code', () => {
    expect(mapOnboardingApiError({ error: 'invalid_body' })).toBe(
      ONBOARDING_ERROR_COPY.invalid_body,
    );
  });

  it('never surfaces the raw code for an unknown error', () => {
    const copy = mapOnboardingApiError({ error: 'brand_new_code' });
    expect(copy).toBe(ONBOARDING_ERROR_FALLBACK);
    expect(copy).not.toContain('brand_new_code');
  });

  it('never surfaces a server `message` field', () => {
    const copy = mapOnboardingApiError({ error: 'mystery', message: 'pg: relation does not exist' });
    expect(copy).toBe(ONBOARDING_ERROR_FALLBACK);
  });

  it.each([undefined, null, {}, 'invalid_body', { error: 42 }, []])(
    'falls back to the plain sentence for a malformed body (%s)',
    (body) => {
      expect(mapOnboardingApiError(body)).toBe(ONBOARDING_ERROR_FALLBACK);
    },
  );

  it('has a plain-language connection failure sentence', () => {
    expect(ONBOARDING_CONNECTION_FAILED).toMatch(/connection/i);
    expect(ONBOARDING_CONNECTION_FAILED).not.toMatch(RAW_CODE);
  });
});
