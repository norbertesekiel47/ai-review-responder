import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { runReadinessProbes } from '@/lib/shared/readiness';

// Readiness (deep-scan §2.5): verifies the web process can actually serve —
// Postgres SELECT 1 + Upstash cache PING, 2s timeout each, 503 with per-dep
// status when a critical dependency is down. `/api/health` stays the fast
// dependency-light liveness probe; do not collapse the two.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const result = await runReadinessProbes([
    { name: 'postgres', probe: () => sql`SELECT 1` },
    { name: 'cache_redis', probe: () => getCacheRedis().ping() },
  ]);

  return NextResponse.json(
    {
      status: result.ready ? 'ready' : 'unready',
      service: 'web',
      checks: result.checks,
      timestamp: new Date().toISOString(),
    },
    {
      status: result.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
