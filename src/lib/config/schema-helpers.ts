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
