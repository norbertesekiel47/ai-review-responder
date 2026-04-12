// Cost guard lifecycle
export {
  checkIdempotentCache,
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  setCachedGeneration,
  releaseCost,
  releaseConcurrencySlot,
  checkRegenBudget,
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from './tracker';

// Audit trail
export {
  recordApiCost,
  linkApiCostToResponse,
  calculateCostUsd,
} from './audit';

// Redis client (re-exported for backward compat — prefer importing from @/lib/db/redis-cache directly)
export { getCacheRedis } from '@/lib/db/redis-cache';
