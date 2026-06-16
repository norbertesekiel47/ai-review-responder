import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getWorkerPublicUrl } from '../worker-public-url';

describe('getWorkerPublicUrl', () => {
  let SNAP: string | undefined;
  beforeEach(() => { SNAP = process.env.WORKER_PUBLIC_URL; delete process.env.WORKER_PUBLIC_URL; });
  afterEach(() => {
    if (SNAP === undefined) delete process.env.WORKER_PUBLIC_URL;
    else process.env.WORKER_PUBLIC_URL = SNAP;
  });

  it('returns the URL unchanged when there is no trailing slash', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips a single trailing slash', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips multiple trailing slashes', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com///';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('throws when unset', () => {
    delete process.env.WORKER_PUBLIC_URL;
    expect(() => getWorkerPublicUrl()).toThrow(/WORKER_PUBLIC_URL/);
  });
});
