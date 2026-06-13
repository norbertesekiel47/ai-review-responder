import { describe, expect, it } from 'vitest';
import { runReadinessProbes } from '../readiness';

describe('runReadinessProbes', () => {
  it('reports ready when every probe resolves', async () => {
    const result = await runReadinessProbes([
      { name: 'postgres', probe: async () => [{ ok: 1 }] },
      { name: 'cache_redis', probe: async () => 'PONG' },
    ]);

    expect(result).toEqual({
      ready: true,
      checks: { postgres: 'ok', cache_redis: 'ok' },
    });
  });

  it('reports unready with per-dependency status when one probe rejects', async () => {
    const result = await runReadinessProbes([
      { name: 'postgres', probe: async () => 1 },
      {
        name: 'queue_redis',
        probe: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    ]);

    expect(result).toEqual({
      ready: false,
      checks: { postgres: 'ok', queue_redis: 'failed' },
    });
  });

  it('treats a synchronous throw from the probe factory as a failed dependency', async () => {
    const result = await runReadinessProbes([
      {
        name: 'cache_redis',
        probe: () => {
          // e.g. getCacheRedis() throwing because REDIS_CACHE_URL is unset
          throw new Error('not configured');
        },
      },
    ]);

    expect(result).toEqual({ ready: false, checks: { cache_redis: 'failed' } });
  });

  it('fails a probe that exceeds the timeout instead of hanging', async () => {
    const never = new Promise(() => {});
    const start = Date.now();
    const result = await runReadinessProbes([{ name: 'postgres', probe: () => never }], 50);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ ready: false, checks: { postgres: 'failed' } });
    expect(elapsed).toBeLessThan(1_000);
  });

  it('runs probes concurrently so total time is bounded by the slowest, not the sum', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const start = Date.now();
    const result = await runReadinessProbes(
      [
        { name: 'a', probe: () => delay(40) },
        { name: 'b', probe: () => delay(40) },
        { name: 'c', probe: () => delay(40) },
      ],
      500,
    );

    expect(result.ready).toBe(true);
    expect(Date.now() - start).toBeLessThan(120);
  });
});
