import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase browser client — client-side auth and real-time subscriptions
// Uses the anon key. Safe for browser bundles.
// ---------------------------------------------------------------------------
export const supabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
