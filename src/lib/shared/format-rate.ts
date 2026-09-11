// Breaker-rate rendering for send-breaker.ts's Sentry titles (#910 B3.10).
// Extracted as a zero-import leaf when the legacy admin panel shared this
// rendering: importing send-breaker.ts from a 'use client' file initialized
// its module-scope worker logger and dragged node:async_hooks into the client
// chunk (#898). Keep this formatter dependency-free.

/** `0.0123` → `"1.23%"`. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
