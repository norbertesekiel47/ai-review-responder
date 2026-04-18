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

/**
 * Bind a value to a JSONB column or parameter. Use this instead of
 * `${JSON.stringify(x)}::jsonb` (which double-encodes — Postgres.js wraps
 * string values going to a jsonb position in JSON quotes, producing a
 * JSONB scalar string rather than a JSONB object) and instead of
 * `${x}::jsonb` (which doesn't type-check because our named payload
 * interfaces don't carry an index signature that satisfies Postgres.js's
 * strict `JSONValue` type).
 *
 * Usage:
 *   await sql`INSERT INTO t (col) VALUES (${jsonb(payload)})`
 *
 * Internally wraps `sql.json(value)` with a type cast so typed payload
 * interfaces (BasePayload / SyncReviewsPayload / etc.) are accepted at
 * compile time. At runtime Postgres.js sends the value as a parameter
 * of OID 3802 (jsonb) — serialized exactly once.
 */
export function jsonb<T>(value: T): ReturnType<typeof sql.json> {
  return sql.json(value as never);
}

// ---------------------------------------------------------------------------
// Supabase server client — auth admin, storage, server-side reads
// Uses the service-role key. NEVER import in browser/client components.
// ---------------------------------------------------------------------------
export const supabaseServer = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);
