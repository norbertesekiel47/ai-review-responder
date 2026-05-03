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

  const reservationDate = await reserveCost(businessId, subscriptionTier);

  let concurrencyAcquired = false;
  let finalized = false;

  try {
    if (withConcurrency) {
      await acquireConcurrencySlot(businessId);
      concurrencyAcquired = true;
    }

    const { value, actualCostCents } = await fn();

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
