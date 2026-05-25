import { describe, it } from 'vitest';

const hasDb = Boolean(process.env.TEST_DATABASE_POOL_URL);

describe.skipIf(!hasDb)('tenant isolation integration', () => {
  it('requires a real two-account seeded proof before enabling TEST_DATABASE_POOL_URL', () => {
    throw new Error(
      'TEST_DATABASE_POOL_URL is set, but the tenant isolation integration test is still a placeholder. Implement the seeded two-account isolation proof before enabling this env var in CI.',
    );
  });
});
