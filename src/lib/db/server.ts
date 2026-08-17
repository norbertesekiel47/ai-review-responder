import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { createWorkerLogger } from '../shared/logger';
import { withAdmissionControl } from './admission';

// Boot-time config-validation warnings (pool sizing). Safe at this foundational
// layer: logger.ts imports only a pure sanitizer + node-only log-context (no cycle).
const dbConfigLogger = createWorkerLogger('db-config');

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

// Resolved shared write-pool ceiling (env-tunable). Exported so the worker
// composition root hands it to the pool-wait probe without re-reading env, and
// used below as the admission cap — cap == pool is exactly the condition under
// which postgres.js never pipelines onto a busy connection.
export const SHARED_POOL_MAX = readPoolMax();

/**
 * The shared write client, behind the #773 admission chokepoint.
 *
 * The gate is applied HERE, at the client, not at call sites: `src/app/**`
 * alone has 153 files importing `sql`, so per-call-site discipline has no
 * enforceable coverage. It is transparent — same type, same laziness, same
 * chaining — so nothing downstream changes. What changes is that a 4th
 * concurrent query against a pool of 3 now WAITS instead of being pipelined
 * onto a busy connection. See `./admission.ts` for the mechanism and why
 * postgres.js cannot do this itself.
 */
export const sql = withAdmissionControl(
  postgres(process.env.DATABASE_POOL_URL!, {
    ...BASE_POSTGRES_OPTIONS,
    // One client serves two roles, so `max` is env-tunable: the Railway worker
    // keeps the default 10; Vercel sets DB_POOL_MAX=3 per serverless instance
    // (the Supabase pooler multiplexes behind it — keep per-instance demand low).
    max: readPoolMax(),
    connection: {
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    },
  }),
  { cap: SHARED_POOL_MAX, clientName: 'sql' },
);

/**
 * Read-path pool size (`sqlRead`). Sized to the fan-out of the routes that use
 * it so their Promise.all waves run one-connection-per-query (the proven #505
 * non-wedge shape): KPI is a 5-query wave (+gate = <=6 peak). `DB_READ_POOL_MAX`
 * is validated + CLAMPED to the reviewed range [WEDGE_SAFE_READ_MIN,
 * READ_POOL_MAX_CEILING]; an out-of-range value is clamped and warn-logged, not
 * silently honored. Both bounds are 8 today, so the effective read max is 8.
 */
// Wedge-safe MINIMUM: the widest Promise.all fan-out ROUTED onto sqlRead
// (KPI ≤6) must run one-connection-per-query (#505). Config can never set below
// this floor, so a mis-set low env cannot reintroduce the wedge (codex #6).
export const WEDGE_SAFE_READ_MIN = 8;
// Capacity-budgeted MAXIMUM. ADR 0009's current Supavisor budget permits at
// most 15 aggregate warm Vercel isolates in worker steady state and 13 during a
// two-worker rolling overlap. Both derive from read max = 8 per isolate (write
// 3 + read 8 = 11 client connections each). A larger read pool multiplies
// client connections across isolates and can starve the write path (all clients
// share the SAME backend pool), so DB_READ_POOL_MAX is capped here — an
// oversized env cannot silently invalidate the documented budget.
// Raising this is a deliberate capacity change: bump the constant AND re-run the
// ADR 0009 staging burst-drill to re-derive the isolate budget.
export const READ_POOL_MAX_CEILING = 8;
function readReadPoolMax(): number {
  const parsed = parseInt(process.env.DB_READ_POOL_MAX ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return WEDGE_SAFE_READ_MIN;
  const clamped = Math.min(READ_POOL_MAX_CEILING, Math.max(WEDGE_SAFE_READ_MIN, parsed));
  if (clamped !== parsed) {
    dbConfigLogger.warn('DB_READ_POOL_MAX outside reviewed range — clamped', {
      requested: parsed,
      clamped,
      min: WEDGE_SAFE_READ_MIN,
      max: READ_POOL_MAX_CEILING,
    });
  }
  return clamped;
}

/**
 * Dedicated READ client (bulkhead) for the wedge-safe small-fan-out
 * dashboard/KPI read routes. Distinct LOCAL pool from `sql`, so a heavy read
 * wave can't consume the write client's slots. Same DATABASE_POOL_URL — it
 * shares the SAME Supavisor backend pool (isolation is LOCAL slots only, NOT
 * backend capacity; ADR 0009). Tighter 8s read statement_timeout.
 * `application_name` is client intent only — Supavisor flattens it to
 * 'Supavisor' server-side (ADR 0007), so it is NOT an attribution mechanism.
 * Lazy: postgres.js connects on first query; the worker imports this module
 * but never queries sqlRead, so zero connections there.
 *
 * Also behind the #773 admission chokepoint, at its OWN cap — a separate pool
 * needs a separate gate, and a transaction on `sql` does not exempt it. Every
 * MODULE-OWNED singleton here (`sql`, `sqlRead`, `sqlUnsubscribe`) is gated.
 * The CALLER-OWNED poller clients built via `createDedicatedPostgresClient`
 * (e.g. the HealthAlertPoller's) are deliberately NOT gated: each is a small
 * single-flight bulkhead whose caller already controls its own fan-out.
 */
const READ_POOL_MAX = readReadPoolMax();
export const sqlRead = withAdmissionControl(
  createDedicatedPostgresClient(process.env.DATABASE_POOL_URL!, {
    max: READ_POOL_MAX,
    connection: { application_name: 'repworth_reads', statement_timeout: 8000 },
  }),
  { cap: READ_POOL_MAX, clientName: 'sqlRead' },
);

/**
 * Dedicated LOCAL pool for recipient-facing Unsubscribe redemption (#651).
 *
 * The fixed ceiling is deliberately not environment-tunable: raising it changes
 * ADR 0009's shared Supavisor/backend capacity budget and requires a new staging
 * compound-pressure drill. Like `sqlRead`, this is local-slot isolation only —
 * it still uses the same DATABASE_POOL_URL and backend pool as `sql`.
 *
 * The #773 admission chokepoint is mandatory here. Excess distinct-token
 * redemptions queue at this client instead of Postgres.js pipelining them onto a
 * busy connection; the existing 30-second queue deadline remains the route's
 * accepted sanitized retryable-503 infrastructure failure path.
 *
 * Lazy: postgres.js connects only on first use. Vercel imports this module but
 * no Vercel composition root queries this client, so it opens connections only
 * on the Railway one-click redemption path.
 */
export const UNSUBSCRIBE_POOL_MAX = 2;
export const sqlUnsubscribe = withAdmissionControl(
  createDedicatedPostgresClient(process.env.DATABASE_POOL_URL!, {
    max: UNSUBSCRIBE_POOL_MAX,
    connection: { application_name: 'repworth_unsubscribe' },
  }),
  { cap: UNSUBSCRIBE_POOL_MAX, clientName: 'sqlUnsubscribe' },
);

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
 * Purpose: give a narrow workload its OWN small local pool so a wedged or busy
 * connection cannot consume the shared singleton's slots. Module-owned
 * singletons are closed by `closeAllPostgresClients`; composition-root callers
 * that create a client own its lifecycle and MUST pass a closer into worker
 * shutdown (invariant #15).
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
 * Close every Postgres client for worker shutdown: caller-owned and module-owned
 * dedicated clients FIRST (best-effort, in parallel), then the shared `sql`
 * singleton.
 *
 * This is the shutdown close-order contract, owned here because `server.ts`
 * owns `sql`. `dedicatedClosers` are the dedicated pollers' `.end()` wrappers
 * (e.g. `closeHealthSql`). They run through `Promise.allSettled`, so a
 * wedged or rejecting dedicated `.end()` — the exact failure mode #500
 * self-heals — can NEVER skip the shared `sql.end()`. Each dedicated closer
 * is expected to bound its own `.end({ timeout })`.
 */
export async function closeAllPostgresClients(
  dedicatedClosers: Array<() => Promise<void>>,
): Promise<void> {
  // Module-owned dedicated singletons JOIN the best-effort closers (one
  // rejecting .end() cannot skip sql.end()); sql.end() stays AWAITED DIRECTLY
  // so its rejection still propagates — preserving the shutdown contract.
  // Each close is bounded so a TCP-wedged dedicated pool cannot stall the
  // subsequent shared-pool close.
  await Promise.allSettled([
    ...dedicatedClosers.map((close) => close()),
    sqlRead.end({ timeout: 5 }),
    sqlUnsubscribe.end({ timeout: 5 }),
  ]);
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

/**
 * Every auth.admin.* / storage.* call is otherwise UNBOUNDED — supabase-js
 * exposes no per-call timeout, and a hung call from a worker job holds its
 * BullMQ slot forever (BullMQ auto-renews the lock). 10s matches the
 * CleanupAbandonedSignupsPoller's existing Promise.race bound. A caller-
 * provided signal still wins (composed via AbortSignal.any) so streaming/
 * cancellable calls keep their own semantics.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 10_000;

// `timeoutMs` is injectable only so tests can exercise the timeout path with
// real timers (AbortSignal.timeout ignores vitest's fake timers); production
// callers never pass it.
export function boundedSupabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = SUPABASE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

/**
 * UNBOUNDED shared client — the default for request flows and every Auth
 * identity MUTATION (signup provisioning, invites, password flows). These
 * calls keep supabase-js's native fetch semantics on purpose: a mutation that
 * commits remotely but responds slowly must NOT surface as a TimeoutError with
 * no reconciliation path — an aborted-but-committed signUp/createUser leaves
 * an orphaned Auth identity and later `account_exists` lockouts. Use
 * `supabaseServerBounded` instead only where hanging is worse than ambiguity.
 */
export const supabaseServer = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

/**
 * BOUNDED client (10s via `boundedSupabaseFetch`) for worker-side admin /
 * storage operations that must never hang a BullMQ slot or wedge a poller
 * cycle: the account-offboarding purge path and the abandoned-signups cleanup
 * poller (whose deleteUser calls are retried/idempotent — "user not found" is
 * success — so an abort-after-commit is reconciled on the next attempt).
 * Never route identity-CREATING mutations through this client.
 *
 * Two server-side GoTrue instances may log a benign "Multiple GoTrueClient
 * instances" warning; both clients are stateless service-role clients, so no
 * session storage is shared or clobbered.
 */
export const supabaseServerBounded = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { global: { fetch: boundedSupabaseFetch } },
);
