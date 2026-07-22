import { readFlagEnabledByDefault } from '@/lib/config/flags';

/** LLM provider circuit breaker kill switch (invariant #13: server-authoritative,
 *  never NEXT_PUBLIC). Default ON — only the literal 'false' disables. */
export function llmCircuitBreakerEnabled(): boolean {
  return readFlagEnabledByDefault('LLM_CIRCUIT_BREAKER_ENABLED');
}
