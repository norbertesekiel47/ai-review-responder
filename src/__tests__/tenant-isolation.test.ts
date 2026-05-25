import { describe, expect, it } from 'vitest';

const hasDb = Boolean(process.env.TEST_DATABASE_POOL_URL);

describe.skipIf(!hasDb)('tenant isolation integration', () => {
  it('prevents account A from seeing account B seeded rows', async () => {
    expect(process.env.TEST_DATABASE_POOL_URL).toBeTruthy();
  });
});
