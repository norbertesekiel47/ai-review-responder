import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { createWorkerLogger } from '@/lib/shared/logger';

// Per-owner regenerate limiter shared by BOTH authenticated "regenerate an AI
// draft" entrypoints. Two fixed-window layers keyed by the authenticated owner
// account, on DISTINCT Redis keys: checkRateLimit is one counter per key, so a
// single shared key would double-increment and corrupt the window.
const BURST_MAX = 5;
const BURST_WINDOW_SECONDS = 60;
const HOUR_MAX = 30;
const HOUR_WINDOW_SECONDS = 3600;

type BlockedWindow = 'burst_60s' | 'hour_3600s';

// Truncated SHA-256 of the account id: a stable, non-reversible tuning/abuse
// signal that keeps the raw owner identity out of logs.
function hashAccountId(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

/**
 * Returns a 429 NextResponse when either rate-limit layer is over limit for the
 * owner account, or null when the request may proceed. Call BEFORE any side
 * effects (LLM-enqueuing work).
 *
 * FAILS OPEN by design: it uses checkRateLimit's default (non-strict) mode, so a
 * Redis outage allows the request through. Spend stays safe regardless because
 * the worker reserves cost before any LLM call — see the rate-limit failure-mode
 * invariant in .claude/CLAUDE.md "Non-obvious gotchas".
 */
export async function enforceDashboardRegenRateLimit(
  accountId: string,
): Promise<NextResponse | null> {
  // Evaluate both layers concurrently (each increments its own counter), then
  // decide — both windows must advance on every request, mirroring the
  // multi-layer pattern in src/app/api/onboarding/start/route.ts. Promise.all
  // is safe here: the keys are distinct and checkRateLimit never rejects in
  // default (non-strict) mode, so failure semantics are unchanged.
  const [burst, hour] = await Promise.all([
    checkRateLimit(`dashregen:owner:${accountId}:burst`, BURST_MAX, BURST_WINDOW_SECONDS),
    checkRateLimit(`dashregen:owner:${accountId}:hour`, HOUR_MAX, HOUR_WINDOW_SECONDS),
  ]);

  if (burst.allowed && hour.allowed) {
    return null;
  }

  const blockedWindow: BlockedWindow = !burst.allowed ? 'burst_60s' : 'hour_3600s';
  const logger = createWorkerLogger('[DashboardRegenRateLimit]');
  logger.warn({
    event: 'rate_limit_exceeded',
    route: 'dashboard_regenerate',
    window: blockedWindow,
    acctHash: hashAccountId(accountId),
  });

  return NextResponse.json(
    { error: 'rate_limited' },
    { status: 429, headers: NO_STORE_HEADERS },
  );
}
