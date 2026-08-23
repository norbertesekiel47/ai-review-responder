// One owner for the breaker-rate rendering (#910 B3.10). Two surfaces show
// the SAME rate within seconds of each other — the Sentry page title
// (src/lib/solicitation/send-breaker.ts) and the admin panel
// (src/app/admin/solicitation/SendBreakerClient.tsx) — and a one-decimal
// drift makes them look like they disagree about whether the threshold was
// crossed. They could not share the copy before: send-breaker.ts instantiates
// a worker logger at module scope, so one runtime import from a 'use client'
// file dragged node:async_hooks into the client chunk and failed the build
// (#898 proved it both ways). This leaf imports NOTHING, so both sides may.

/** `0.0123` → `"1.23%"`. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
