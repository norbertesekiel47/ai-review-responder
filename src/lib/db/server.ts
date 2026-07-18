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

// Pinned postgres.js pool bounds (deep-scan §3.5), shared by the `sql` singleton
// AND every dedicated client built via createDedicatedPostgresClient — one
// authoritative owner for these constants. Postgres.js takes these in SECONDS.
//   idle_timeout    — reap idle connections (matters most on quiet serverless instances)
//   max_lifetime    — bound connection age; tolerates pooler restarts/failovers
//   connect_timeout — fail fast; a connect taking >10s is already an incident
// `prepare: false` is REQUIRED behind the Supabase PgBouncer transaction pooler.
const BASE_POSTGRES_OPTIONS = {
  prepare: false,
  idle_timeout: 30,
  max_lifetime: 1800,
  connect_timeout: 10,
} as const;

// Supabase PgBouncer has a short default statement_timeout (~8s). The OutboxPoller
// watchdog CTE can exceed this when updating locked rows. 30s is generous but safe.
// Postgres.js takes SECONDS everywhere EXCEPT connection.statement_timeout, which
// is milliseconds. Dedicated clients inherit this default unless they override
// `connection.statement_timeout`.
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export const sql = postgres(process.env.DATABASE_POOL_URL!, {
  ...BASE_POSTGRES_OPTIONS,
  // One client serves two roles, so `max` is env-tunable: the Railway worker
  // keeps the default 10; Vercel sets DB_POOL_MAX=3 per serverless instance
  // (the Supabase pooler multiplexes behind it — keep per-instance demand low).
  max: readPoolMax(),
  connection: {
    statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
  },
});

/** Tight overrides a dedicated client may pass; both are optional. */
type DedicatedClientOverrides = {
  /** Pool ceiling for this dedicated client. Defaults to 2 (dedicated clients are small). */
  max?: number;
  /**
   * Postgres.js connection parameters. Merged over the pinned
   * `statement_timeout` default, so a caller can pass a tighter
   * `statement_timeout` (ms) and/or an `application_name`.
   */
  connection?: Partial<postgres.ConnectionParameters>;
};

/**
 * Build a NEW postgres.js client — distinct from the shared `sql` singleton —
 * on the SAME pinned base config (`prepare: false`, idle/lifetime/connect
 * timeouts, 30s statement_timeout), but pointed at `url` (not DATABASE_POOL_URL)
 * with tight per-caller overrides.
 *
 * Purpose: give a poller its OWN small, isolated pool so a wedged connection on
 * it cannot starve the shared singleton (bulkhead). Callers own the returned
 * client's lifecycle and MUST `.end()` it in the worker shutdown path
 * (invariant #15). Created only here (the DB-client owner) and passed down to
 * composition-root pollers.
 *
 * Postgres.js does not connect until the first query, so constructing a client
 * is side-effect-free (safe offline / in tests).
 */
export function createDedicatedPostgresClient(
  url: string,
  overrides?: DedicatedClientOverrides,
): ReturnType<typeof postgres> {
  return postgres(url, {
    ...BASE_POSTGRES_OPTIONS,
    max: overrides?.max ?? 2,
    connection: {
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      ...overrides?.connection,
    },
  });
}

/**
 * Close every Postgres client for worker shutdown: the caller's dedicated
 * clients FIRST (best-effort, in parallel), then the shared `sql` singleton.
 *
 * This is the shutdown close-order contract, owned here because `server.ts`
 * owns `sql`. `dedicatedClosers` are the dedicated pollers' `.end()` wrappers
 * (e.g. `closeReaperClient`, `closeHealthSql`). They run through
 * `Promise.allSettled`, so a wedged or rejecting dedicated `.end()` — the exact
 * failure mode #500 self-heals — can NEVER skip the shared `sql.end()`. Each
 * dedicated closer is expected to bound its own `.end({ timeout })`.
 */
export async function closeAllPostgresClients(
  dedicatedClosers: Array<() => Promise<void>>,
): Promise<void> {
  await Promise.allSettled(dedicatedClosers.map((close) => close()));
  await sql.end();
}

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
