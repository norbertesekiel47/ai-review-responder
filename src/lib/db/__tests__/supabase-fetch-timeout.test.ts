import { describe, it, expect, vi } from 'vitest';

// The module-scope Postgres.js client must not touch DATABASE_POOL_URL here;
// `json` is stubbed because server.ts's jsonb() helper references sql.json.
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { json: vi.fn() })),
}));

// createClient is mocked so the client-split tests below can assert on the
// OPTIONS each module-scope client was constructed with (each call returns a
// fresh object so instance-identity assertions stay meaningful).
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}));

import { createClient } from '@supabase/supabase-js';
import {
  boundedSupabaseFetch,
  SUPABASE_FETCH_TIMEOUT_MS,
  supabaseServer,
  supabaseServerBounded,
} from '../server';

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

// Adversarial finding 1: the 10s fetch bound must NOT apply to the shared
// `supabaseServer` client — it also serves Auth identity MUTATIONS (signup
// provisioning, invites), where a mutation that commits remotely but responds
// slowly would surface as TimeoutError with no reconciliation (orphaned Auth
// identity → `account_exists` lockouts). Only the worker-facing
// `supabaseServerBounded` client installs boundedSupabaseFetch.
// Both clients are created at module load, in source order: supabaseServer
// first, supabaseServerBounded second — asserted by call index.
describe('supabase server client split', () => {
  it('creates supabaseServer WITHOUT a custom fetch (identity mutations stay unbounded)', () => {
    const call = vi.mocked(createClient).mock.calls[0]!;
    const options = call[2] as { global?: { fetch?: unknown } } | undefined;
    expect(options?.global?.fetch).toBeUndefined();
  });

  it('creates supabaseServerBounded WITH boundedSupabaseFetch as its injected fetch', () => {
    const call = vi.mocked(createClient).mock.calls[1]!;
    const options = call[2] as { global?: { fetch?: unknown } } | undefined;
    expect(options?.global?.fetch).toBe(boundedSupabaseFetch);
  });

  it('exports two distinct client instances', () => {
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(2);
    expect(supabaseServerBounded).not.toBe(supabaseServer);
  });

});
