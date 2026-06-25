// src/lib/config/schema-helpers.ts
//
// Shared Zod field builders for the config lanes so all three (client/server/
// worker) treat presence/emptiness identically.
//
// Key semantics: an OPTIONAL env var that is present-but-empty (or whitespace-
// only) is treated as ABSENT, not invalid. This matters because .env files
// routinely carry `FOO=` placeholders for optional vars (e.g. an unset
// NEXT_PUBLIC_SENTRY_DSN in local dev). A naive `z.string().min(1).optional()`
// would wrongly reject that. A REQUIRED var set to empty stays invalid — that is
// a genuine misconfiguration.
import { z } from 'zod';

/** Required: must be a present, non-empty (after trim) string. */
export const requiredVar = z.string().trim().min(1);

/** Optional: absent OR present; empty/whitespace-only collapses to undefined. */
export const optionalVar = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);

/**
 * Throw if any of `vars` is unset or empty/whitespace-only in `snapshot`. The
 * "required-ness at the accessor" primitive (treats present-but-empty as absent,
 * matching optionalVar's semantics). Accessors pass the SAME memoized config
 * snapshot they then narrow, so the assert and the `!` narrowing can never
 * disagree (an env populated after the first parse cannot make a narrowed `!`
 * yield undefined-as-string).
 */
export function requirePresentIn(
  snapshot: Partial<Record<string, string>>,
  vars: readonly string[],
  subsystem: string,
): void {
  const missing = vars.filter((name) => {
    const value = snapshot[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`[config] ${subsystem} requires: ${missing.join(', ')}`);
  }
}

/**
 * Throw if any of `vars` is unset or empty/whitespace-only in live `process.env`.
 * Used by the standalone assert*Config() entry-gate functions (Stage-3 entry
 * asserts). Accessors that also RETURN values use requirePresentIn against their
 * own snapshot instead, so assert + narrow share one source of truth.
 */
export function requirePresent(vars: readonly string[], subsystem: string): void {
  requirePresentIn(process.env, vars, subsystem);
}
