import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { peekRegenBudget } from '@/lib/costs/tracker';
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

// User-facing copy for the per-review daily regenerate cap. Kept here next to the
// enforcer so the message is owned in one place; the client renders it verbatim.
const REGEN_LIMIT_MESSAGE =
  'Daily regenerate limit reached for this review — you can try again tomorrow.';

/**
 * Returns a 429 `regen_limit_reached` NextResponse when this review has used its
 * per-day regeneration cap, or null when a regenerate may proceed. Call BEFORE
 * enqueueing the regenerate so the owner gets synchronous feedback instead of a
 * silent worker-side failure (issue #335).
 *
 * The peek is a read-only counter GET — it does NOT consume budget or trigger
 * LLM spend. FAILS OPEN by design: a Redis outage returns null so a legitimate
 * regenerate is never blocked here. The authoritative gate is the worker's
 * checkRegenBudget (itself retryable on Redis transport failure), so over-budget
 * work is still rejected before any spend even when this peek is bypassed.
 */
export async function enforceRegenBudgetForReview(
  reviewId: string,
): Promise<NextResponse | null> {
  let status;
  try {
    status = await peekRegenBudget(reviewId);
  } catch (err) {
    createWorkerLogger('[DashboardRegenBudget]').warn({
      event: 'regen_budget_peek_failed',
      route: 'dashboard_regenerate',
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }

  if (status.remaining > 0) {
    return null;
  }

  return NextResponse.json(
    {
      error: 'regen_limit_reached',
      message: REGEN_LIMIT_MESSAGE,
      remaining: 0,
      limit: status.limit,
    },
    { status: 429, headers: NO_STORE_HEADERS },
  );
}
