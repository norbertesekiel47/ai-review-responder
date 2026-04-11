import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Postgres.js — PRIMARY client for all transactional writes
// Uses PgBouncer pooled connection; prepared statements disabled (required)
// Usage: await sql`SELECT ...`  or  await sql.begin(tx => { ... })
// ---------------------------------------------------------------------------
export const sql = postgres(process.env.DATABASE_POOL_URL!, {
  prepare: false,
  // Supabase PgBouncer has a short default statement_timeout (~8s).
  // The OutboxPoller watchdog CTE can exceed this when updating locked rows.
  // 30s is generous but safe — the poller runs every 10s, so a long query
  // blocks the next cycle but doesn't cascade.
  connection: {
    statement_timeout: 30_000, // 30 seconds in ms
  },
});

// ---------------------------------------------------------------------------
// Supabase server client — auth admin, storage, server-side reads
// Uses the service-role key. NEVER import in browser/client components.
// ---------------------------------------------------------------------------
export const supabaseServer = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);
