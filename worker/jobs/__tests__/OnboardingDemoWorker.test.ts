import { describe, it, expect, beforeAll } from 'vitest';

describe('OnboardingDemoWorker', () => {
  beforeAll(() => {
    // fetch-reviews throws at module-load when MOCK_EXTERNAL_APIS!=true and
    // SERPAPI_API_KEY is unset. Tests don't need a real key — set mock mode
    // before the dynamic import below.
    process.env.MOCK_EXTERNAL_APIS = 'true';
  });

  it('exists and can be imported', async () => {
    const { handleOnboardingDemo } = await import('../OnboardingDemoWorker');
    expect(handleOnboardingDemo).toBeTypeOf('function');
  });
});
