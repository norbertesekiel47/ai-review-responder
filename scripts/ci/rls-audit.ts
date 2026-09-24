import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIVE_DB_LOCK_KEY } from '../../src/lib/shared/__tests__/helpers/live-db-lock';
import {
  PROVISION_MARKER_MISSING,
  computeProvisionHash,
  expectedProvisionHash,
  findProvisionFailure,
  readProvisionMarker,
  type LiveSql,
} from '../../src/lib/shared/__tests__/helpers/live-db-lane';
import { RLS_REQUIRED_TABLES } from './rls-tables';

export interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
}

/**
 * The tables this audit requires RLS on. Owned by `./rls-tables.ts` since
 * #1300 — deliberately NOT `TENANT_TABLES`, so "must carry RLS" and "is
 * tenant-scope audited" can be answered independently. That file's header
 * carries the reasoning.
 */
export const REQUIRED_RLS_TABLES = RLS_REQUIRED_TABLES;

export function findRlsFailures(
  rows: RlsRow[],
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): string[] {
  const rowByTable = new Map(rows.map((row) => [row.relname, row]));

  return requiredTables.flatMap((table) => {
    const row = rowByTable.get(table);
    if (!row) return [`${table} missing from pg_class result`];
    if (!row.relrowsecurity) return [`${table} has RLS disabled`];
    return [];
  });
}

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

const ENABLE_RLS_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;

/**
 * Tables that receive `ENABLE ROW LEVEL SECURITY` anywhere in the given
 * migration SQL. Pure over its input, so the coverage gate is unit-testable
 * without a database.
 *
 * Presence-only: a table enabled then later `DISABLE`d would still be counted.
 * The realistic regression (forgetting to enable) is caught here; a later
 * DISABLE is only caught by the live relrowsecurity check.
 */
export function collectRlsEnabledTables(migrationsSql: readonly string[]): Set<string> {
  const enabled = new Set<string>();
  for (const sql of migrationsSql) {
    for (const match of sql.matchAll(ENABLE_RLS_RE)) {
      const table = match[1];
      if (table) enabled.add(table);
    }
  }
  return enabled;
}

/**
 * Required tenant tables that have no `ENABLE ROW LEVEL SECURITY` in any
 * migration. This is the DB-free gate: it catches a new TENANT_TABLES entry (or
 * a migration) that forgets to enable RLS — a regression a live-DB check would
 * miss entirely whenever no database is reachable.
 */
export function findRlsCoverageFailures(
  enabledTables: ReadonlySet<string>,
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): string[] {
  return requiredTables.flatMap((table) =>
    enabledTables.has(table)
      ? []
      : [`${table} has no ENABLE ROW LEVEL SECURITY in any migration`],
  );
}

export function readMigrationsSql(dir: string = MIGRATIONS_DIR): string[] {
  // Sorted: the deny-all guard REPLAYS policy creates and drops in migration
  // order, and readdirSync's order is filesystem-defined, not lexical.
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

// ---------------------------------------------------------------------------
// Deny-all recurrence guard (#1300).
//
// A "deny-all" table is RLS-on with ZERO policies. RLS filters ROWS; it removes
// no TABLE PRIVILEGE, so a deny-all table that still carries the Supabase
// default `anon`/`authenticated` grants stays on the PostgREST surface, and any
// policy later added to it opens it instantly because the grant was never
// taken away. Migration 122 (#1176) swept the twenty that existed and removed
// TRUNCATE/REFERENCES/TRIGGER/MAINTAIN from the default privileges — but
// SELECT, INSERT, UPDATE and DELETE stay in those defaults, so the gap comes
// straight back on the NEXT deny-all table. This guard is what stops that.
//
// WHY STATIC AND NOT LIVE. The obvious check is `has_table_privilege` for
// `anon`/`authenticated` against the test database. It would pass vacuously:
// `scripts/ci/test-db-bootstrap.sql` creates the three Supabase roles and
// grants them `USAGE ON SCHEMA public`, and nothing else — the container never
// reproduces Supabase's default TABLE privileges, so no grant ever exists there
// to detect. Reading the checked-in migrations is the only place the guard can
// actually fire, and it needs no database, so it runs in CI's `lint` job.
//
// WHAT IT ACCEPTS as the revoke. Exactly the shape migrations 117-120 and 122
// use: `REVOKE ALL ON <tables> FROM <roles>` naming BOTH `anon` and
// `authenticated`. Deliberately narrow — a partial revoke would need this
// guard to model which privileges matter, and the repo has one spelling.

/**
 * Removes SQL comments so the scanners below never read a `REVOKE` or
 * `CREATE POLICY` out of prose. RepWorth's migration headers quote their own
 * statements (migration 120's header contains the literal
 * `REVOKE ALL ... FROM anon, authenticated`), so this is load-bearing rather
 * than hygiene.
 *
 * Lexes the four states Postgres does: line comment, block comment (nestable),
 * single-quoted string, and dollar-quoted body. Comments ARE recognised inside
 * a dollar-quoted body (that is how PL/pgSQL is parsed) and are NOT recognised
 * inside a single-quoted string.
 */
/** Index just past the `--` comment that starts at `i`. */
function endOfLineComment(sql: string, i: number): number {
  const end = sql.indexOf('\n', i);
  return end === -1 ? sql.length : end;
}

/** Index just past the nestable slash-star comment that starts at `i`. */
function endOfBlockComment(sql: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (sql.startsWith('/*', j)) { depth += 1; j += 2; }
    else if (sql.startsWith('*/', j)) { depth -= 1; j += 2; }
    else j += 1;
  }
  return j;
}

/** Index just past the single-quoted literal that starts at `i` (`''` escapes). */
function endOfSingleQuoted(sql: string, i: number): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
    if (sql[j] === "'") return j + 1;
    j += 1;
  }
  return j;
}

const DOLLAR_TAG_RE = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/;

interface LexStep {
  /** Index to continue scanning from. */
  next: number;
  /** Text to keep — a single space for anything elided. */
  emit: string;
  /** The dollar-quote tag in force AFTER this step, if any. */
  tag: string | null;
}

/** One lexer step at `i`, given the dollar-quote tag currently in force. */
function lexStep(sql: string, i: number, tag: string | null): LexStep {
  if (tag && sql.startsWith(tag, i)) return { next: i + tag.length, emit: ' ', tag: null };
  if (sql.startsWith('--', i)) return { next: endOfLineComment(sql, i), emit: ' ', tag };
  if (sql.startsWith('/*', i)) return { next: endOfBlockComment(sql, i), emit: ' ', tag };
  if (sql[i] === "'") {
    const end = endOfSingleQuoted(sql, i);
    return { next: end, emit: sql.slice(i, end), tag };
  }
  // The `$` guard keeps the regex off the hot path: without it every ordinary
  // character would pay for a `sql.slice(i)` copy.
  const opened = !tag && sql[i] === '$' ? DOLLAR_TAG_RE.exec(sql.slice(i))?.[0] : undefined;
  if (opened) return { next: i + opened.length, emit: ' ', tag: opened };
  return { next: i + 1, emit: sql[i] ?? '', tag };
}

export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let tag: string | null = null;
  while (i < sql.length) {
    const step = lexStep(sql, i, tag);
    out += step.emit;
    i = step.next;
    tag = step.tag;
  }
  return out;
}

const DISABLE_RLS_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/gi;

const DROP_TABLE_RE =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:\s*(?:public\.)?"?[a-z_][a-z0-9_]*"?\s*,?)+?)\s*(?:CASCADE|RESTRICT)?\s*;/gi;

const CREATE_POLICY_RE =
  /CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+ON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

const DROP_POLICY_RE =
  /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+ON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * `REVOKE ALL [PRIVILEGES] ON <table list> FROM <role list>;`. The negative
 * lookahead excludes `ON ALL TABLES IN SCHEMA …`, whose first token would
 * otherwise parse as a table named `ALL`.
 *
 * The trailing `;` is required, and that fails CLOSED: an unterminated revoke
 * is simply not seen, so its table stays flagged rather than silently excused.
 * `DROP_TABLE_RE` above requires one for the same reason.
 */
const REVOKE_ALL_RE =
  /REVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?!ALL\s+TABLES\b)((?:\s*(?:public\.)?"?[a-z_][a-z0-9_]*"?\s*,?)+?)\s*FROM\s+([^;]+);/gi;

/**
 * A revoke counts only when BOTH client roles are named. Word-boundary
 * matched, so `service_role` never satisfies `anon` and a role list is read
 * however it is spaced.
 */
const CLIENT_ROLE_PATTERNS = [/\banon\b/, /\bauthenticated\b/] as const;

export interface TableRlsPosture {
  rlsEnabled: boolean;
  policies: Set<string>;
  clientRolesRevoked: boolean;
}

interface OrderedEvent {
  order: number;
  apply: (posture: Map<string, TableRlsPosture>) => void;
}

/** `public."a", b , c` → `['a', 'b', 'c']`. */
function splitTableList(list: string): string[] {
  return list
    .split(',')
    .map((t) => t.trim().replace(/^public\./i, '').replace(/"/g, '').toLowerCase())
    .filter(Boolean);
}

function postureFor(posture: Map<string, TableRlsPosture>, table: string): TableRlsPosture {
  let entry = posture.get(table);
  if (!entry) {
    entry = { rlsEnabled: false, policies: new Set(), clientRolesRevoked: false };
    posture.set(table, entry);
  }
  return entry;
}

/**
 * Replays every RLS-relevant statement in the given migrations, in order, and
 * returns the resulting per-table posture.
 *
 * ORDER MATTERS, which is why this replays rather than counting. Seven
 * migrations use the idempotent `DROP POLICY IF EXISTS …; CREATE POLICY …`
 * re-create pattern; a presence-only policy count would read those drops as
 * policy REMOVALS (or ignore them and miss a real drop). Replaying by policy
 * NAME gets both right.
 */
export function analyzeRlsPosture(
  migrationsSql: readonly string[],
): Map<string, TableRlsPosture> {
  const posture = new Map<string, TableRlsPosture>();
  for (const raw of migrationsSql) {
    const sql = stripSqlComments(raw);
    const events = [
      ...rlsFlagEvents(sql),
      ...policyEvents(sql),
      ...lifecycleEvents(sql),
    ].sort((a, b) => a.order - b.order);
    for (const event of events) event.apply(posture);
  }
  return posture;
}

/** One event per regex match, for a pattern whose group 1 is a single table. */
function singleTableEvents(
  sql: string,
  pattern: RegExp,
  mutate: (entry: TableRlsPosture) => void,
): OrderedEvent[] {
  return [...sql.matchAll(pattern)].flatMap((m) => {
    const table = m[1]?.toLowerCase();
    return table ? [{ order: m.index, apply: (p) => mutate(postureFor(p, table)) }] : [];
  });
}

/** `ALTER TABLE … {ENABLE,DISABLE} ROW LEVEL SECURITY`. */
function rlsFlagEvents(sql: string): OrderedEvent[] {
  return [
    ...singleTableEvents(sql, ENABLE_RLS_RE, (entry) => { entry.rlsEnabled = true; }),
    ...singleTableEvents(sql, DISABLE_RLS_RE, (entry) => { entry.rlsEnabled = false; }),
  ];
}

/** `{CREATE,DROP} POLICY <name> ON <table>`, tracked by policy NAME. */
function policyEvents(sql: string): OrderedEvent[] {
  const events = (pattern: RegExp, mutate: (policies: Set<string>, name: string) => void) =>
    [...sql.matchAll(pattern)].flatMap((m) => {
      const name = m[1] ?? m[2];
      const table = m[3]?.toLowerCase();
      if (!name || !table) return [];
      return [{
        order: m.index,
        apply: (p: Map<string, TableRlsPosture>) => mutate(postureFor(p, table).policies, name),
      }];
    });
  return [
    ...events(CREATE_POLICY_RE, (policies, name) => { policies.add(name); }),
    ...events(DROP_POLICY_RE, (policies, name) => { policies.delete(name); }),
  ];
}

/**
 * `DROP TABLE` and `REVOKE ALL … FROM <roles>`, both over a comma list.
 *
 * A dropped table takes its posture with it — otherwise a deny-all table
 * removed by a later migration would fail this guard forever (migration 061
 * dropped two such tables). A revoke counts only when both client roles are
 * named.
 */
function lifecycleEvents(sql: string): OrderedEvent[] {
  const drops = [...sql.matchAll(DROP_TABLE_RE)].flatMap((m) =>
    splitTableList(m[1] ?? '').map((table) => ({
      order: m.index,
      apply: (p: Map<string, TableRlsPosture>) => { p.delete(table); },
    })));

  const revokes = [...sql.matchAll(REVOKE_ALL_RE)]
    .filter((m) => CLIENT_ROLE_PATTERNS.every((p) => p.test((m[2] ?? '').toLowerCase())))
    .flatMap((m) =>
      splitTableList(m[1] ?? '').map((table) => ({
        order: m.index,
        apply: (p: Map<string, TableRlsPosture>) => { postureFor(p, table).clientRolesRevoked = true; },
      })));

  return [...drops, ...revokes];
}

/**
 * Deny-all tables (RLS on, zero policies) with no `REVOKE ALL … FROM anon,
 * authenticated` in any migration. Covers EVERY table the migrations create,
 * not only the registry: the failure mode #1300 names is a NEW table landing
 * deny-all, and a new table is exactly the one nobody has added to a list yet.
 */
export function findDenyAllRevokeFailures(
  posture: ReadonlyMap<string, TableRlsPosture>,
): string[] {
  return [...posture.entries()]
    .filter(([, entry]) => entry.rlsEnabled && entry.policies.size === 0 && !entry.clientRolesRevoked)
    .map(([table]) => table)
    .sort()
    .map(
      (table) =>
        `${table} is deny-all (RLS on, zero policies) with no REVOKE ALL ON ${table} FROM anon, authenticated in any migration`,
    );
}

function reportFailures(label: string, failures: readonly string[]): void {
  console.error(`rls-audit: ${label} failed`);
  for (const failure of failures) {
    console.error(failure);
  }
}

// ---------------------------------------------------------------------------
// Provisioning coordination (#877). The live check joins the same advisory
// protocol as scripts/test-db-setup.sh (exclusive) and the DDL suites
// (exclusive, via live-db-lock.ts): a SHARED acquisition on the SUITE key, so
// this read can never observe a half-dropped schema — the class of failure
// that produced 20+ bogus "missing from pg_class" lines on #865 — nor a DDL
// suite's committed degrade. It deliberately does NOT take the lane key (#958):
// provisioning holds the suite key too, and a lane's non-DDL suites cannot
// change what this audit reads.

/** Bounds both the shared-lock wait and the queries on the audit session. */
const LIVE_AUDIT_STATEMENT_TIMEOUT_MS = 240_000;

// Re-exported for the DB-free provisioning tests: importing the live-db-lock
// helper directly would mark them as live-DB suites (`ci:live-db-suites`
// counts that import as suite-shaped), and this audit is the key's
// shared-lock consumer anyway.
export { LIVE_DB_LOCK_KEY };

// The provision-marker helpers are owned by the lane module (#958) — every
// shared acquisition validates the marker, and this audit is one of them.
export {
  PROVISION_MARKER_MISSING,
  computeProvisionHash,
  expectedProvisionHash,
  findProvisionFailure,
  readProvisionMarker,
  type LiveSql,
};

/**
 * Runs `fn` holding the SHARED live-DB advisory lock, releasing it on every
 * path — an audit crash must never leave a shared hold that blocks the next
 * provisioning run for the session's lifetime.
 */
export async function withSharedLiveDbLock<T>(sql: LiveSql, fn: () => Promise<T>): Promise<T> {
  await sql`SELECT pg_advisory_lock_shared(hashtext(${LIVE_DB_LOCK_KEY}))`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock_shared(hashtext(${LIVE_DB_LOCK_KEY}))`;
  }
}

/**
 * Live relrowsecurity check against a real database. Owns the connection
 * lifecycle and returns the tables whose RLS is actually disabled or missing.
 * A missing or stale provisioning marker short-circuits to ONE actionable
 * line instead of a per-table failure flood.
 */
async function auditLiveRls(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { statement_timeout: LIVE_AUDIT_STATEMENT_TIMEOUT_MS },
  });
  // postgres.js's Sql is structurally a LiveSql at runtime (tagged template →
  // thenable rows); its declared parameter types are narrower, hence the cast.
  const liveSql = sql as unknown as LiveSql;
  try {
    return await withSharedLiveDbLock(liveSql, async () => {
      const provisionFailure = findProvisionFailure(
        await readProvisionMarker(liveSql),
        expectedProvisionHash(),
      );
      if (provisionFailure) return [provisionFailure];

      const rows = await sql<RlsRow[]>`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
      `;
      return findRlsFailures(rows);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A failing audit arm: the label `reportFailures` prints, and its lines. */
export interface RlsArmFailure {
  label: string;
  failures: string[];
}

/**
 * The two DB-free arms, in order, short-circuiting on the first that fails —
 * these are the authoritative CI checks, since `lint` has no database.
 *
 * 1. Coverage: every `RLS_REQUIRED_TABLES` entry enables RLS in some migration.
 * 2. The deny-all recurrence guard, which for the reason in its section header
 *    CANNOT be a live check — the test container never carries Supabase's
 *    default client-role grants.
 */
export function findStaticRlsFailures(
  migrationsSql: readonly string[],
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): RlsArmFailure | undefined {
  const coverage = findRlsCoverageFailures(collectRlsEnabledTables(migrationsSql), requiredTables);
  if (coverage.length > 0) return { label: 'static RLS coverage', failures: coverage };

  const denyAll = findDenyAllRevokeFailures(analyzeRlsPosture(migrationsSql));
  if (denyAll.length > 0) return { label: 'deny-all client-role revoke', failures: denyAll };

  return undefined;
}

async function main(): Promise<void> {
  const staticFailure = findStaticRlsFailures(readMigrationsSql());
  if (staticFailure) {
    reportFailures(staticFailure.label, staticFailure.failures);
    process.exitCode = 1;
    return;
  }
  console.log(
    `rls-audit: static coverage passed (${REQUIRED_RLS_TABLES.length} registered tables enable RLS in migrations)`,
  );
  console.log('rls-audit: deny-all client-role revoke guard passed');

  // Live relrowsecurity check — only when an explicit test database is set. We
  // require TEST_DATABASE_POOL_URL (not the always-present DATABASE_POOL_URL
  // placeholder) so CI's lint job runs the static gates without attempting a
  // connection. Those gates already fail closed, so this path can never
  // silently pass. It is also the only arm that sees a STALE registry entry: a
  // table dropped from the schema still has its ENABLE RLS in the migration
  // that made it.
  const databaseUrl = process.env.TEST_DATABASE_POOL_URL;
  if (!databaseUrl) {
    console.log(
      'rls-audit: live DB check skipped (TEST_DATABASE_POOL_URL unset); static gates enforced above',
    );
    return;
  }

  const liveFailures = await auditLiveRls(databaseUrl);
  if (liveFailures.length > 0) {
    reportFailures('live DB check', liveFailures);
    process.exitCode = 1;
    return;
  }
  console.log('rls-audit: live DB check passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('rls-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
