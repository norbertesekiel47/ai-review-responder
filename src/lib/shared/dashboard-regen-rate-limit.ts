import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { peekRegenBudgetBatch } from '@/lib/costs/tracker';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { createWorkerLogger } from '@/lib/shared/logger';

// Per-owner regenerate limiter shared by every authenticated "regenerate an AI
// draft" entrypoint. ENUMERATED rather than counted, because the count is what
// drifted: this header read "both" and then "the THREE", and Past Replies
// `draft` was absent from every version of it. The four callers of
// `enforceDashboardRegenRateLimit` are
//
//   - `reviews/[reviewId]/generate`
//   - `reviews/[reviewId]/regenerate`
//   - `past-replies/draft`, under `mode === 'regenerate'` ONLY — manual mode is
//     a plain INSERT, not an LLM call, so it is not spend to bound
//   - `solicitation/batch/regenerate` — the #860 per-ask lane
//
// `docs/directory.md` § `src/lib/shared/` lists the same four; a new entrypoint
// updates both. Two fixed-window layers keyed by the authenticated owner
// account, on DISTINCT Redis keys: checkRateLimit is one counter per key, so a
// single shared key would double-increment and corrupt the window.
// The HOUR layer is the spend bound (30 × the 15¢ pessimistic reserve ≈ $4.50/hr
// worst case); the BURST layer only exists to stop a click-storm. Raised 5 → 10
// at #672 so an owner deliberately working through a freshly imported Reviews
// list is not 429'd every few clicks — the hourly bound is deliberately
// unchanged, so worst-case on-demand spend per hour does not move.
const BURST_MAX = 10;
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
 * per-review daily cap, or null when a regenerate may proceed. Call BEFORE
 * enqueueing the regenerate so the owner gets synchronous feedback instead of a
 * silent worker-side failure (issue #335).
 *
 * The peek is a read-only counter read — it does NOT consume budget or trigger
 * LLM spend. FAILS OPEN by design: an Upstash outage returns null so a
 * legitimate regenerate is never blocked here. The authoritative gate is the
 * worker's checkRegenBudget (itself retryable on Redis transport failure), so
 * over-budget work is still rejected before any spend even when this peek is
 * bypassed.
 */
export async function enforceRegenBudgetForReview(
  reviewId: string,
): Promise<NextResponse | null> {
  // ONE contract, not two (#731). peekRegenBudgetBatch never rejects — it calls
  // getCacheRedis() inside its own try and logs on the shared
  // `regen_budget_peek_failed` stream — so this call site needs no catch of its
  // own, and the deleted one is not a lost guard.
  //
  // An ABSENT MAP ENTRY is the single fail-open path: the MGET itself failed, so
  // the advisory peek is UNKNOWN and the regenerate proceeds. An absent Redis
  // KEY is a different fact and still yields `{ used: 0 }` — inverting the two
  // would 429 every regenerate during an Upstash outage (D-F).
  const status = (await peekRegenBudgetBatch([reviewId])).get(reviewId);
  if (status === undefined || status.remaining > 0) {
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

// User-facing copy for the per-ASK daily cap (#860).
//
// The word "rewrite" below is a KNOWN DEVIATION from **Ask regeneration**'s
// `_Avoid_` list (edit, rewrite, redraft, retry, re-roll), NOT a carve-out.
// Unlike the **Halt latch**'s single "stop" exception, that list grants none —
// the panel says so on the label it chose instead, "Writing a new version…"
// (`AskList.tsx`). This string is left as it shipped only because the panel
// renders the server's message verbatim, so the wording lives in one place;
// reword the sentence and the panel's copy together, never this one alone.
// Do not cite this comment as licence for the word anywhere else.
const ASK_REGEN_LIMIT_MESSAGE =
  'Daily rewrite limit reached for this message — you can try again tomorrow.';

/**
 * The 429 an exhausted per-ask budget answers with — a RESPONSE BUILDER, not an
 * enforcer, and the difference is load-bearing.
 *
 * Its review-lane sibling `enforceRegenBudgetForReview` peeks AND decides AND
 * shapes, which is safe there because a review id is scoped by the surrounding
 * route before it is ever reached. An ASK id is not: the counter is keyed on
 * the bare id, so a peek-and-refuse before tenant validation lets an
 * authenticated owner tell a foreign ask from an unknown one (codex round 1,
 * finding 4). So the ask lane splits the three jobs — the route PEEKS,
 * `requestAskRegeneration` DECIDES after it has proven ownership, and this
 * shapes. Do not "unify" it with the review door.
 */
export function askRegenLimitResponse(limit: number): NextResponse {
  return NextResponse.json(
    {
      error: 'regen_limit_reached',
      message: ASK_REGEN_LIMIT_MESSAGE,
      remaining: 0,
      limit,
    },
    { status: 429, headers: NO_STORE_HEADERS },
  );
}
