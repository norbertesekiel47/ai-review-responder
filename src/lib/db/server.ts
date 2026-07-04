import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Postgres.js — PRIMARY client for all transactional writes
// Uses PgBouncer pooled connection; prepared statements disabled (required)
// Usage: await sql`SELECT ...`  or  await sql.begin(tx => { ... })
// ---------------------------------------------------------------------------
function readPoolMax(): number {
  const parsed = parseInt(process.env.DB_POOL_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export const sql = postgres(process.env.DATABASE_POOL_URL!, {
  prepare: false,
  // Explicit pool bounds (deep-scan §3.5). Postgres.js takes these in SECONDS.
  // One client serves two roles, so `max` is env-tunable: the Railway worker
  // keeps the default 10; Vercel sets DB_POOL_MAX=3 per serverless instance
  // (the Supabase pooler multiplexes behind it — keep per-instance demand low).
  max: readPoolMax(),
  idle_timeout: 30, // reap idle connections — matters most on quiet serverless instances
  max_lifetime: 1800, // bound connection age; tolerates pooler restarts/failovers
  connect_timeout: 10, // fail fast — a connect taking >10s is already an incident
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
 *
 * Instance-bound (coupled to the `sql` singleton): this wraps the
 * module-level `sql` singleton's `.json` — Postgres.js exposes no static
 * jsonb-parameter constructor — so importing `jsonb` pulls in the db
 * singleton. It is therefore a composition-root-only value import. Domain
 * modules — which receive `sql`/`tx` as an injected parameter per the
 * injection convention — must NOT import `jsonb`; call the injected
 * client's `.json(value)` directly (e.g. `tx.json(payload)`), which is
 * byte-identical to this helper. (Modularity A+ campaign, PR 2z; spec §2.1.)
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
