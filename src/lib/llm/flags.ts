/**
 * LLM provider circuit breaker kill switch (invariant #13: server-authoritative,
 * never NEXT_PUBLIC). Default ON — only the literal 'false' disables. readFlag is
 * default-OFF (=== 'true'), so this default-ON toggle reads process.env directly
 * inside this sanctioned flags.ts home (the accessor is the exempt boundary).
 */
export function llmCircuitBreakerEnabled(): boolean {
  return process.env.LLM_CIRCUIT_BREAKER_ENABLED !== 'false';
}
