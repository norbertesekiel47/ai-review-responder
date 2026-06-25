// src/lib/config/client.ts
//
// CLIENT lane — NEXT_PUBLIC_* only (build-inlined). The browser learns these at
// build time; a missing required one would otherwise inline as `undefined` and
// fail silently in the browser, so assertClientConfig() runs in the prebuild step.
import { z } from 'zod';

const nonEmpty = z.string().min(1);

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1).optional(),
  NEXT_PUBLIC_DOCS_BASE_URL: z.string().min(1).optional(),
});

export type ClientConfig = z.infer<typeof clientSchema>;

export const CLIENT_REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
] as const;

let memo: ClientConfig | undefined;

/** Lazy, memoized parse. NEVER call z.parse at import time. */
export function getClientConfig(): ClientConfig {
  if (!memo) memo = clientSchema.parse(process.env);
  return memo;
}

/** Build/boot guard: validates the required public vars are present. */
export function assertClientConfig(): void {
  const result = clientSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`[config] client config invalid/missing: ${missing}`);
  }
}
