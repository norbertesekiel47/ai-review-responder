// THE crisp local proof that validation is not at import time: importing the
// server/worker/client config modules with ALL secrets cleared must NOT throw.
// If anyone re-introduces a top-level z.parse(), this test goes red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config import-safety (no import-time secret dependency)', () => {
  const original = process.env;
  beforeEach(() => { process.env = {} as NodeJS.ProcessEnv; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('importing config/server with a cleared env does not throw', async () => {
    await expect(import('../server')).resolves.toBeDefined();
  });

  it('importing config/worker with a cleared env does not throw', async () => {
    await expect(import('../worker')).resolves.toBeDefined();
  });

  it('importing config/client with a cleared env does not throw', async () => {
    await expect(import('../client')).resolves.toBeDefined();
  });
});
