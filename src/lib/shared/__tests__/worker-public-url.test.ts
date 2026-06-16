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

  it('strips a path, query, and fragment to the origin', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/api?x=1#frag';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('preserves an explicit non-default port', () => {
    process.env.WORKER_PUBLIC_URL = 'http://localhost:3001';
    expect(getWorkerPublicUrl()).toBe('http://localhost:3001');
  });
});
