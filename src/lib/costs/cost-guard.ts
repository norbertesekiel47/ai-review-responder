import { reserveCost, finalizeCost, releaseCost } from './tracker';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from './concurrency-guard';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

export interface CostGuardOptions {
  businessId: string;
  subscriptionTier: SubscriptionTierValue;
  /** Acquire a per-business concurrency slot. Defaults to true. */
  withConcurrency?: boolean;
  /**
   * Task-scoped pessimistic reservation in INTEGER cents (Redis INCRBY is
   * integer-only; round via Math.ceil(usd * 100)). Omitted ⇒ the tracker's
   * 15¢ reply-generation default. The guard threads the SAME value through
   * reserve, finalize, and release via its closure — never re-derived — so a
   * reserve/finalize mismatch cannot silently leak daily budget (SPEC §7.2).
   */
  estimateCents?: number;
  /**
   * What to do when finalizeCost itself throws (e.g. Redis transport flake)
   * AFTER fn has successfully returned a value.
   * - 'propagate' (default): log and re-throw the finalize error. Caller's
   *   value is discarded.
   * - 'log-and-return-value': log the finalize error and return fn's value
   *   anyway. The cost reservation is NOT released; it ages out via the 24h Redis TTL.
   */
  onFinalizeError?: 'propagate' | 'log-and-return-value';
}

export interface CostGuardedResult<T> {
  value: T;
  actualCostCents: number;
}

// ACKNOWLEDGED DEBT (#628 → refactor ticket): pre-dates this branch, surfaced
// here only because #628 threaded a task-scoped estimate through it. Its
// branches ARE the reserve → spend → finalize/release matrix documented in
// lab-notes ("Cost-guard fail-open/retry matrix"): transport failures
// retryable, budget decisions terminal, finalize failures never job-retried.
// Each branch is a distinct money-safety rule, so collapsing them to lower a
// metric would hide exactly the distinctions that keep spend safe.
// fallow-ignore-next-line complexity
export async function withCostGuard<T>(
  opts: CostGuardOptions,
  fn: () => Promise<CostGuardedResult<T>>,
): Promise<T> {
  const { businessId, subscriptionTier, withConcurrency = true, onFinalizeError = 'propagate', estimateCents } = opts;

  // L6: Defensive boundary check. Empty businessId would build collision-prone
  // Redis keys like `cost:daily::2026-05-03`. Tier feeds tier-limit lookup;
  // empty would produce an invalid configuration lookup. Both are caller bugs we
  // want to surface immediately, not paper over.
  if (!businessId) {
    throw new TypeError('withCostGuard: businessId is required');
  }
  if (!subscriptionTier) {
    throw new TypeError('withCostGuard: subscriptionTier is required');
  }
  // A non-integer estimate would make the reserve Lua INCRBY throw, which the
  // tracker would then misclassify as a retryable CostInfraUnavailableError —
  // an infinite-retry loop for what is really a caller bug. Surface it here,
  // before any reservation exists.
  if (
    estimateCents !== undefined &&
    (!Number.isSafeInteger(estimateCents) || estimateCents < 1)
  ) {
    throw new TypeError(
      `withCostGuard: invalid estimateCents=${estimateCents} (must be a positive safe integer)`,
    );
  }

  const reservationDate = await reserveCost(businessId, subscriptionTier, estimateCents);

  let concurrencyAcquired = false;
  let finalized = false;

  try {
    if (withConcurrency) {
      await acquireConcurrencySlot(businessId);
      concurrencyAcquired = true;
    }

    const { value, actualCostCents } = await fn();

    // M1: Validate BEFORE the inner try around finalizeCost so a malformed
    // cost (NaN from calculateCostUsd on unknown model, fractional from a
    // caller bug, negative, etc.) throws while `finalized` is still false —
    // letting the outer finally run releaseCost and return the reservation.
    // Letting NaN reach Redis INCRBY would throw inside the inner try, set
    // finalized=true, and leak the reservation until the 24h TTL.
    if (!Number.isSafeInteger(actualCostCents) || actualCostCents < 0) {
      throw new TypeError(
        `withCostGuard: invalid actualCostCents=${actualCostCents} (must be a non-negative safe integer)`,
      );
    }

    try {
      await finalizeCost(businessId, actualCostCents, reservationDate, estimateCents);
      finalized = true;
    } catch (finalizeErr) {
      console.error('[cost-guard] finalizeCost failed:', finalizeErr);
      finalized = true;
      if (onFinalizeError === 'log-and-return-value') {
        return value;
      }
      throw finalizeErr;
    }

    return value;
  } finally {
    if (concurrencyAcquired) {
      try {
        await releaseConcurrencySlot(businessId);
      } catch (err) {
        console.error('[cost-guard] Failed to release concurrency slot:', err);
      }
    }
    if (!finalized) {
      try {
        await releaseCost(businessId, reservationDate, estimateCents);
      } catch (err) {
        console.error('[cost-guard] Failed to release cost reservation:', err);
      }
    }
  }
}
