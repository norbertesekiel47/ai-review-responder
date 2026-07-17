import { describe, it, expect, vi } from 'vitest';

// The module-scope Postgres.js client must not touch DATABASE_POOL_URL here;
// `json` is stubbed because server.ts's jsonb() helper references sql.json.
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { json: vi.fn() })),
}));

import { boundedSupabaseFetch, SUPABASE_FETCH_TIMEOUT_MS } from '../server';

describe('boundedSupabaseFetch', () => {
  it('attaches a timeout signal when the caller passes none', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', inner);
    await boundedSupabaseFetch('https://example.test/auth/v1/admin', {
      method: 'POST',
    });
    const init = inner.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it('rejects within the bound instead of hanging forever', async () => {
    // Real timers with a small injected timeout: AbortSignal.timeout is
    // implemented on Node's internal timer list, which vitest's fake timers
    // cannot advance (plan Task 2 fallback).
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
    const pending = boundedSupabaseFetch(
      'https://example.test/storage/v1/object',
      {},
      25,
    );
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    vi.unstubAllGlobals();
  });

  it('exports the production bound as a 10s named constant', () => {
    expect(SUPABASE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('a caller-provided signal still aborts the request (composed, not replaced)', async () => {
    const inner = vi.fn((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
    vi.stubGlobal('fetch', inner);
    const controller = new AbortController();
    const pending = boundedSupabaseFetch('https://example.test/auth/v1/admin', {
      signal: controller.signal,
    });
    controller.abort(new Error('caller aborted'));
    await expect(pending).rejects.toThrow('caller aborted');
    expect((inner.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });
});
