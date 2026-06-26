import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getWorkerPublicUrl now reads WORKER_PUBLIC_URL via getServerConfig() (memoized).
// Set/delete the env, reset modules, then dynamically import so the config memo
// re-parses (Stage-3 convention #6). Every assertion below is unchanged.
async function freshUrl() {
  vi.resetModules();
  return import('../worker-public-url');
}

describe('getWorkerPublicUrl', () => {
  let SNAP: string | undefined;
  beforeEach(() => { SNAP = process.env.WORKER_PUBLIC_URL; delete process.env.WORKER_PUBLIC_URL; });
  afterEach(() => {
    if (SNAP === undefined) delete process.env.WORKER_PUBLIC_URL;
    else process.env.WORKER_PUBLIC_URL = SNAP;
  });

  it('returns the URL unchanged when there is no trailing slash', async () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    const { getWorkerPublicUrl } = await freshUrl();
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips a single trailing slash', async () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    const { getWorkerPublicUrl } = await freshUrl();
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips multiple trailing slashes', async () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com///';
    const { getWorkerPublicUrl } = await freshUrl();
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('throws when unset', async () => {
    delete process.env.WORKER_PUBLIC_URL;
    const { getWorkerPublicUrl } = await freshUrl();
    expect(() => getWorkerPublicUrl()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('strips a path, query, and fragment to the origin', async () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/api?x=1#frag';
    const { getWorkerPublicUrl } = await freshUrl();
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('preserves an explicit non-default port', async () => {
    process.env.WORKER_PUBLIC_URL = 'http://localhost:3001';
    const { getWorkerPublicUrl } = await freshUrl();
    expect(getWorkerPublicUrl()).toBe('http://localhost:3001');
  });
});
