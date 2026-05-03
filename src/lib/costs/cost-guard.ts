import {
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  releaseCost,
  releaseConcurrencySlot,
} from './tracker';

export interface CostGuardOptions {
  businessId: string;
  subscriptionTier: string;
  /** Acquire a per-business concurrency slot. Defaults to true. */
  withConcurrency?: boolean;
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

export async function withCostGuard<T>(
  opts: CostGuardOptions,
  fn: () => Promise<CostGuardedResult<T>>,
): Promise<T> {
  const { businessId, subscriptionTier, withConcurrency = true, onFinalizeError = 'propagate' } = opts;

  // L6: Defensive boundary check. Empty businessId would build collision-prone
  // Redis keys like `cost:daily::2026-05-03`. Tier feeds tier-limit lookup;
  // empty would silently fall back to 'standard'. Both are caller bugs we
  // want to surface immediately, not paper over.
  if (!businessId) {
    throw new TypeError('withCostGuard: businessId is required');
  }
  if (!subscriptionTier) {
    throw new TypeError('withCostGuard: subscriptionTier is required');
  }

  const reservationDate = await reserveCost(businessId, subscriptionTier);

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
      await finalizeCost(businessId, actualCostCents, reservationDate);
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
        await releaseCost(businessId, reservationDate);
      } catch (err) {
        console.error('[cost-guard] Failed to release cost reservation:', err);
      }
    }
  }
}
