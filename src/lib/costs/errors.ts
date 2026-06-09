// Shared cost-guard error types that more than one cost module + the worker
// need to reference. Kept in a leaf module (imports nothing from tracker.ts /
// concurrency-guard.ts / generator.ts) so the three pre-LLM touchpoints and
// generate-draft can all import it without creating an import cycle.

/** The pre-LLM cost-guard Redis touchpoint that failed its transport round-trip. */
export type CostInfraTouchpoint =
  | 'reserveCost'
  | 'checkIdempotentCache'
  | 'acquireConcurrencySlot';

/**
 * A pre-LLM cost-guard Redis (Upstash) round-trip failed as a
 * TRANSPORT/CONNECTION error — NOT a budget decision.
 *
 * The generation worker RE-THROWS this (like TransientLLMError) so BullMQ
 * retries and the 1h outbox watchdog re-dispatches, instead of terminally
 * losing the draft on a flaky-Redis blip. Genuine budget-exceeded outcomes
 * (CostLimitExceededError / GlobalCostLimitExceededError / RegenBudgetExceededError)
 * are NOT infra failures and stay terminal — never reclassify a budget decision
 * as infra.
 */
export class CostInfraUnavailableError extends Error {
  constructor(
    public readonly touchpoint: CostInfraTouchpoint,
    options?: ErrorOptions,
  ) {
    super(`Cost-guard Redis unavailable at ${touchpoint}`, options);
    this.name = 'CostInfraUnavailableError';
  }
}
