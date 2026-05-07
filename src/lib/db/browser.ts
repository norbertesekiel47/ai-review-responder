import { createBrowserClient } from '@supabase/ssr';

/**
 * Supabase browser client — auth-aware, manages cookies automatically.
 * Uses the anon key. Safe for browser bundles.
 *
 * Call this function (not a singleton) so @supabase/ssr manages cookies correctly.
 * The library deduplicates internally — multiple calls return the same instance.
 */
export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
