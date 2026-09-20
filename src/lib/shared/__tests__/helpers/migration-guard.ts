// Shared machinery for the migration-guard suites (#1301): read the `public`
// catalogue, prove a degrade landed, prove nothing else moved, read the
// checked-in migration verbatim, and roll back.
//
// WHY THIS EXISTS. Six suites proved their migration by pattern-matching its
// SQL TEXT, and that approach lost five red-team passes on #1171: each pass
// defeated a hand-rolled approximation of a SQL lexer — line-anchored counting,
// then `CREATE\nPOLICY` split across a newline, then
// `DISABLE/**/ROW LEVEL SECURITY`, then `--` inside a string literal, then a
// comment standing in as evidence. The verdict was that the APPROACH was wrong,
// not the code. A suite built on this module stops parsing the file and starts
// running it: PostgreSQL is the parser.
//
// ── THIS MODULE EXECUTES NO DDL, AND THAT BOUNDARY IS LOAD-BEARING ──────────
//
// It reads (SELECT), compares (pure functions) and wraps a transaction. Every
// `unsafe(<ddl>)` call stays in the calling SUITE. `scripts/ci/live-db-suites-audit.ts`
// treats any live-DB file that executes DDL as needing membership in
// `MIGRATION_SHAPE_FILES`, and it enforces that every member names a
// cross-process lock marker IN ITS OWN TEXT (`text.includes(SHARED_LOCK_MARKER)`;
// inheriting a caller's lock would need an import graph, which that audit's
// `OWN_APPLY_LOCK` JSDoc states it deliberately does not build). This helper
// does not acquire the lock — the suite does, in `beforeAll` — so DDL here
// would have to claim a lock it does not own. Keep the split.
//
// Test-helper only — never imported by production code, the same convention
// `schema-ready.ts` states at its own top.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';

/**
 * Every catalogue property is a list of NAMED entries, never a flat string.
 * Flat strings were rejected twice in review. `columns` rendered as
 * "<name> <type> <NULL|NOT NULL>" means a selector written
 * "zernio_account_ids NULL" never matches "zernio_account_ids text[] NULL" —
 * the type sits between the two halves. And substring matching cannot
 * establish identity: `idx_impersonation_actor_started` is a substring of
 * `idx_impersonation_actor_started_v2`. A named entry makes selection an
 * EXACT match on `name` and keeps the full rendering in `definition`.
 */
export interface CatalogueEntry {
  name: string;
  definition: string;
}

export interface CataloguedTable {
  /** The key. Never an OID: one suite drops and recreates its table, which
   * changes the OID while nothing meaningful changed. */
  table: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  /** name -> cmd, PERMISSIVE|RESTRICTIVE, target roles, qual, with-check. */
  policies: readonly CatalogueEntry[];
  /** name -> type, NULL|NOT NULL, identity, generated + its expression. */
  columns: readonly CatalogueEntry[];
  /** Column names with `attnotnull`, sorted — bare names, so a caller has an
   * exact name to select on with no type string in the way. */
  notNullColumns: readonly string[];
  /** name -> default expression. */
  columnDefaults: readonly CatalogueEntry[];
  /** name -> comment. */
  columnComments: readonly CatalogueEntry[];
  /** index name -> `pg_get_indexdef`. */
  indexes: readonly CatalogueEntry[];
  /** constraint name -> `pg_get_constraintdef`. */
  constraints: readonly CatalogueEntry[];
  /** `obj_description` on the table. */
  comment: string | null;
  /** "<grantee>:<privilege>[:<column>]" -> "<grantor>[:GRANT OPTION]". */
  grants: readonly CatalogueEntry[];
}

export interface PublicCatalogue {
  tables: Readonly<Record<string, CataloguedTable>>;
}

/**
 * The catalogue properties that hold a list of NAMED entries — the only ones a
 * selector list can name. `table` and `comment` are scalars and the two
 * row-security flags are booleans, so none of them has names to select on.
 */
type CatalogueListProperty = Exclude<
  keyof CataloguedTable,
  'table' | 'comment' | 'rowSecurity' | 'forceRowSecurity'
>;

/**
 * A selector list that CANNOT be empty. The emptiness is the whole point: an
 * empty list degrades `assertDegradeLanded` to "the named property changed
 * somehow", which is contract 2 of the three below — and three review rounds
 * rejected it.
 */
type NamedObjects = readonly [string, ...string[]];

/**
 * What the degrade is expected to have done to ONE table.
 *
 * `{ property: 'presence' }` is the only form that tolerates an absent table on
 * the `after` side. Every other form requires the table on BOTH sides, so an
 * unexpectedly missing table stays a loud failure rather than a silent pass.
 *
 * A BOOLEAN property (`rowSecurity`, `forceRowSecurity`) is its OWN variant
 * with no selector list at all: the value comparison is the entire proof, so
 * there is nothing to name. That variant exists because the type previously
 * expressed no boolean case, and four suites each invented a different
 * placeholder (`absent: []`) to stand in for one — the same empty list that
 * made the vacuous contract writable by accident.
 *
 * For a list property the selector list is a NON-EMPTY tuple, so `absent: []`
 * is a COMPILE error. §3 of the review record states the three candidate
 * contracts and why only the third is adequate:
 *   1. "the table changed somehow" — passes when the degrade perturbed an
 *      unrelated column and the guarded index stayed intact;
 *   2. "the named property changed" — passes when the degrade dropped ONE of
 *      four indexes and the other three were never challenged;
 *   3. "each named object was present in BEFORE and is absent now" — the only
 *      one that proves the degrade reached every object the re-apply gets
 *      credit for restoring.
 */
export type DegradeTarget =
  | { table: string; property: 'presence' }
  | { table: string; property: 'rowSecurity' | 'forceRowSecurity' }
  | { table: string; property: CatalogueListProperty; absent: NamedObjects }
  | { table: string; property: CatalogueListProperty; present: NamedObjects };

/**
 * A computed list of names — `Object.keys(...)`, a `flatMap`, anything whose
 * type is `string[]` rather than a literal — narrowed to the non-empty tuple
 * `DegradeTarget` demands, throwing if it turns out to be empty.
 *
 * It is a CHECKED narrowing, not a cast: a selector list that computes to
 * empty fails here, at the call site that built it, instead of reaching
 * `assertDegradeLanded` and quietly weakening its contract.
 */
export function nonEmptyNames(names: readonly string[]): NamedObjects {
  const [first, ...rest] = names;
  if (first === undefined) {
    throw new Error(
      'nonEmptyNames received an empty selector list — a degrade must name every object it ' +
        'is expected to have moved, or the check degrades to "the property differs somehow"',
    );
  }
  return [first, ...rest];
}

const MIGRATIONS_DIR = ['supabase', 'migrations'] as const;

/** Separators that cannot occur in a catalogue name or definition. */
const FIELD = '\u0000';
const RECORD = '\u0001';

/**
 * Exhaustive by construction: `satisfies` makes a property added to
 * `CataloguedTable` and forgotten here a COMPILE error, so
 * `assertOnlyTablesMoved` can never quietly stop comparing one.
 */
const TABLE_PROPERTY_SET = {
  table: true,
  rowSecurity: true,
  forceRowSecurity: true,
  policies: true,
  columns: true,
  notNullColumns: true,
  columnDefaults: true,
  columnComments: true,
  indexes: true,
  constraints: true,
  comment: true,
  grants: true,
} as const satisfies Record<keyof CataloguedTable, true>;

const TABLE_PROPERTIES: readonly (keyof CataloguedTable)[] = Object.keys(
  TABLE_PROPERTY_SET,
).filter((key): key is keyof CataloguedTable => key in TABLE_PROPERTY_SET);

interface RelationRow {
  table_name: string;
  row_security: boolean;
  force_row_security: boolean;
  comment: string | null;
}

interface EntryRow {
  table_name: string;
  property: string;
  name: string;
  definition: string | null;
}

type MutableTable = {
  -readonly [K in keyof CataloguedTable]: CataloguedTable[K] extends readonly (infer Item)[]
    ? Item[]
    : CataloguedTable[K];
};

function emptyTable(row: RelationRow): MutableTable {
  return {
    table: row.table_name,
    rowSecurity: row.row_security,
    forceRowSecurity: row.force_row_security,
    policies: [],
    columns: [],
    notNullColumns: [],
    columnDefaults: [],
    columnComments: [],
    indexes: [],
    constraints: [],
    comment: row.comment,
    grants: [],
  };
}

function byNameThenDefinition(left: CatalogueEntry, right: CatalogueEntry): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.definition === right.definition) return 0;
  return left.definition < right.definition ? -1 : 1;
}

/**
 * Every relation in schema `public` with `relkind in ('r', 'p')`, keyed by table
 * NAME, with every array sorted so a diff is order-independent.
 *
 * Read-only — two SELECTs over the system catalogues, nothing stronger than
 * ACCESS SHARE, so this can never be the blocking side of a deadlock.
 *
 * BOUND, stated rather than tolerated: `grants` reads
 * `coalesce(relacl, acldefault('r', relowner))`, so a table whose `relacl` is
 * NULL (built-in defaults) renders as the owner's full default grants rather
 * than as an empty list. That is strictly stronger than reading `relacl` raw,
 * where NULL and `{}` — "nobody touched it" and "someone revoked from the
 * owner" — both render empty and a revoke-from-owner would be invisible.
 * Column ACLs are NOT coalesced: columns have no default privileges, so
 * `acldefault('c', …)` is empty (the fact migration 119's ARM C rests on).
 */
export async function readPublicCatalogue(tx: TransactionSql): Promise<PublicCatalogue> {
  const relations = await tx<RelationRow[]>`
    SELECT cls.relname AS table_name,
           cls.relrowsecurity AS row_security,
           cls.relforcerowsecurity AS force_row_security,
           obj_description(cls.oid, 'pg_class') AS comment
      FROM pg_class cls
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public' AND cls.relkind IN ('r', 'p')
     ORDER BY cls.relname
  `;

  const entries = await tx<EntryRow[]>`
    WITH relations AS (
      SELECT cls.oid, cls.relname, cls.relowner, cls.relacl
        FROM pg_class cls
        JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
       WHERE nsp.nspname = 'public' AND cls.relkind IN ('r', 'p')
    ),
    attributes AS (
      SELECT rel.relname,
             att.attrelid,
             att.attnum,
             att.attname,
             att.attnotnull,
             att.attidentity,
             att.attgenerated,
             att.attacl,
             format_type(att.atttypid, att.atttypmod) AS attribute_type
        FROM relations rel
        JOIN pg_attribute att ON att.attrelid = rel.oid
       WHERE att.attnum > 0 AND NOT att.attisdropped
    )
    SELECT rel.relname AS table_name,
           'policies' AS property,
           pol.polname AS name,
           (CASE pol.polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END)
           || ' ' || (CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END)
           || ' roles=' || coalesce((
                SELECT string_agg(role_name, ',' ORDER BY role_name)
                  FROM (
                    SELECT (CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_oid::regrole::text END)
                             AS role_name
                      FROM unnest(pol.polroles) AS role_oid
                  ) roles
              ), '(none)')
           || ' using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '(none)')
           || ' check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '(none)')
             AS definition
      FROM relations rel
      JOIN pg_policy pol ON pol.polrelid = rel.oid
    UNION ALL
    SELECT att.relname,
           'columns',
           att.attname,
           att.attribute_type
           || ' ' || (CASE WHEN att.attnotnull THEN 'NOT NULL' ELSE 'NULL' END)
           || ' identity=' || (CASE WHEN att.attidentity = '' THEN 'none'
                                    ELSE att.attidentity::text END)
           || ' generated=' || (CASE WHEN att.attgenerated = '' THEN 'none'
                                     ELSE att.attgenerated::text END)
           || (CASE WHEN att.attgenerated = '' THEN ''
                    ELSE ' expression=' || coalesce((
                           SELECT pg_get_expr(def.adbin, def.adrelid)
                             FROM pg_attrdef def
                            WHERE def.adrelid = att.attrelid AND def.adnum = att.attnum
                         ), '(none)')
               END)
      FROM attributes att
    UNION ALL
    SELECT att.relname, 'notNullColumns', att.attname, ''
      FROM attributes att
     WHERE att.attnotnull
    UNION ALL
    SELECT att.relname, 'columnDefaults', att.attname, pg_get_expr(def.adbin, def.adrelid)
      FROM attributes att
      JOIN pg_attrdef def ON def.adrelid = att.attrelid AND def.adnum = att.attnum
    UNION ALL
    SELECT att.relname, 'columnComments', att.attname, col_description(att.attrelid, att.attnum)
      FROM attributes att
     WHERE col_description(att.attrelid, att.attnum) IS NOT NULL
    UNION ALL
    SELECT rel.relname, 'indexes', idx.relname, pg_get_indexdef(idx.oid)
      FROM relations rel
      JOIN pg_index ind ON ind.indrelid = rel.oid
      JOIN pg_class idx ON idx.oid = ind.indexrelid
    UNION ALL
    SELECT rel.relname, 'constraints', con.conname, pg_get_constraintdef(con.oid)
      FROM relations rel
      JOIN pg_constraint con ON con.conrelid = rel.oid
    UNION ALL
    SELECT rel.relname,
           'grants',
           (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END)
             || ':' || acl.privilege_type,
           acl.grantor::regrole::text
             || (CASE WHEN acl.is_grantable THEN ':GRANT OPTION' ELSE '' END)
      FROM relations rel
      CROSS JOIN LATERAL aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) AS acl
    UNION ALL
    SELECT att.relname,
           'grants',
           (CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END)
             || ':' || acl.privilege_type || ':' || att.attname,
           acl.grantor::regrole::text
             || (CASE WHEN acl.is_grantable THEN ':GRANT OPTION' ELSE '' END)
      FROM attributes att
      CROSS JOIN LATERAL aclexplode(att.attacl) AS acl
  `;

  const tables = new Map<string, MutableTable>();
  for (const row of relations) tables.set(row.table_name, emptyTable(row));

  for (const row of entries) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    const entry: CatalogueEntry = { name: row.name, definition: row.definition ?? '' };
    switch (row.property) {
      case 'policies':
        table.policies.push(entry);
        break;
      case 'columns':
        table.columns.push(entry);
        break;
      case 'notNullColumns':
        table.notNullColumns.push(row.name);
        break;
      case 'columnDefaults':
        table.columnDefaults.push(entry);
        break;
      case 'columnComments':
        table.columnComments.push(entry);
        break;
      case 'indexes':
        table.indexes.push(entry);
        break;
      case 'constraints':
        table.constraints.push(entry);
        break;
      case 'grants':
        table.grants.push(entry);
        break;
      default:
        throw new Error(`readPublicCatalogue read an unknown property "${row.property}"`);
    }
  }

  const out: Record<string, CataloguedTable> = {};
  for (const [name, table] of [...tables.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    table.policies.sort(byNameThenDefinition);
    table.columns.sort(byNameThenDefinition);
    table.columnDefaults.sort(byNameThenDefinition);
    table.columnComments.sort(byNameThenDefinition);
    table.indexes.sort(byNameThenDefinition);
    table.constraints.sort(byNameThenDefinition);
    table.grants.sort(byNameThenDefinition);
    table.notNullColumns.sort();
    out[name] = table;
  }
  return { tables: out };
}

/**
 * One property, rendered so that two renderings are equal exactly when the
 * property is unchanged. Order-independent for both list shapes.
 */
function renderValue(value: CataloguedTable[keyof CataloguedTable]): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return '(null)';
  if (typeof value === 'string') return value;
  return [...value]
    .map((item) => (typeof item === 'string' ? item : `${item.name}${FIELD}${item.definition}`))
    .sort()
    .join(RECORD);
}

/** The entry NAMES of a list property, or null when the property is a scalar. */
function namedEntries(value: CataloguedTable[keyof CataloguedTable]): string[] | null {
  if (typeof value === 'boolean' || value === null || typeof value === 'string') return null;
  return [...value].map((item) => (typeof item === 'string' ? item : item.name));
}

/**
 * The vacuity guard. Three progressively weaker contracts were rejected in
 * review, so this implements the strongest: the property must DIFFER between
 * the two catalogues, and every name the caller selects on must have moved in
 * the stated direction.
 *
 * Names are matched EXACTLY, never as a substring. Both directions are checked,
 * because the reverse — a typo'd name that was never in `before` — is what
 * makes a substring implementation pass while establishing nothing.
 */
export function assertDegradeLanded(
  before: PublicCatalogue,
  after: PublicCatalogue,
  target: DegradeTarget,
): void {
  const beforeTable = before.tables[target.table];
  const afterTable = after.tables[target.table];

  if (target.property === 'presence') {
    if (!beforeTable) {
      throw new Error(
        `degrade target ${target.table} (property presence) was already absent from the ` +
          'before catalogue — the removal proves nothing',
      );
    }
    if (afterTable) {
      throw new Error(
        `degrade target ${target.table} (property presence) is still present in the ` +
          'after catalogue — the removal did not land',
      );
    }
    return;
  }

  const label = `${target.table}.${target.property}`;

  // The selector list, or null for the boolean variant which has none. Read
  // BEFORE the catalogue is consulted: an empty list is a malformed call, and a
  // malformed call must not be reported as a catalogue finding. The type makes
  // the empty literal a compile error; this is the same rule for a JavaScript
  // caller and for anyone who casts past the type.
  const selectors =
    'absent' in target ? target.absent : 'present' in target ? target.present : null;
  if (selectors !== null && selectors.length === 0) {
    throw new Error(
      `${label}: an empty selector list degrades this check to "the named property changed ` +
        'somehow", which passes when the degrade dropped one of several guarded objects — ' +
        'name every object the re-apply gets credit for restoring',
    );
  }

  if (!beforeTable) {
    throw new Error(`degrade target ${label} is absent from the before catalogue`);
  }
  if (!afterTable) {
    throw new Error(
      `degrade target ${label} is absent from the after catalogue — use ` +
        "{ property: 'presence' } for a deliberate table removal",
    );
  }

  if (renderValue(beforeTable[target.property]) === renderValue(afterTable[target.property])) {
    throw new Error(
      `${label} did not change between before and after — the degrade did not land, so the ` +
        'case would pass against a no-op migration',
    );
  }

  // The boolean variant carries no names: the value comparison above IS the
  // proof, and it has already thrown if the value did not flip.
  if (selectors === null) return;

  const beforeNames = namedEntries(beforeTable[target.property]);
  const afterNames = namedEntries(afterTable[target.property]);
  if (beforeNames === null || afterNames === null) {
    throw new Error(
      `${label} is a scalar property and cannot be selected on by name ` +
        `(${selectors.join(', ')}) — a boolean or scalar property is proven by the value ` +
        "comparison alone, so pass { property: 'rowSecurity' } with no selector list",
    );
  }
  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);

  if ('absent' in target) {
    for (const name of target.absent) {
      if (!beforeSet.has(name)) {
        throw new Error(
          `${label}: ${name} was already absent from the before catalogue — a misspelled ` +
            'or renamed object makes the absence check vacuous',
        );
      }
      if (afterSet.has(name)) {
        throw new Error(`${label}: ${name} survived into the after catalogue`);
      }
    }
    return;
  }

  // `selectors` is `target.present` here — the only remaining variant with a
  // list — and is already narrowed to non-null above.
  for (const name of selectors) {
    if (beforeSet.has(name)) {
      throw new Error(
        `${label}: ${name} was already present in the before catalogue — an additive degrade ` +
          'must ADD it, or the check is vacuous',
      );
    }
    if (!afterSet.has(name)) {
      throw new Error(`${label}: ${name} is missing from the after catalogue`);
    }
  }
}

/**
 * The off-target guard. A migration may harden the one table it names while
 * doing arbitrary damage elsewhere — appending `GRANT ALL ON admin_audit_log TO
 * anon;` to migration 119 passed its whole suite once, and the grant really
 * landed (#1171). Every table outside `tables` must come out byte-identical,
 * and no table may appear or disappear outside that list.
 */
export function assertOnlyTablesMoved(
  before: PublicCatalogue,
  after: PublicCatalogue,
  tables: readonly string[],
): void {
  const allowed = new Set(tables);
  const everyName = [
    ...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]),
  ].sort();

  const offenders: string[] = [];
  for (const name of everyName) {
    if (allowed.has(name)) continue;
    const beforeTable = before.tables[name];
    const afterTable = after.tables[name];
    if (!beforeTable) {
      offenders.push(`${name} (appeared)`);
      continue;
    }
    if (!afterTable) {
      offenders.push(`${name} (disappeared)`);
      continue;
    }
    const changed = TABLE_PROPERTIES.filter(
      (property) => renderValue(beforeTable[property]) !== renderValue(afterTable[property]),
    );
    if (changed.length > 0) offenders.push(`${name} (${changed.join(', ')})`);
  }

  if (offenders.length === 0) return;
  throw new Error(
    `migration moved tables outside [${[...allowed].sort().join(', ')}]: ${offenders.join('; ')}`,
  );
}

/** Rollback marker. Module-private, so no caller can throw it by accident. */
const ROLLBACK_SENTINEL = new Error('migration-guard rolled-back transaction sentinel');

/**
 * Runs `fn` inside `db.begin` and ALWAYS rolls back, by throwing a
 * module-private sentinel after the callback returns.
 *
 * It re-throws any OTHER error UNCHANGED. That is load-bearing rather than
 * tidy: a wrapper that swallowed a callback error would turn every failing
 * executing case in six suites into a pass.
 */
export async function withRolledBackTransaction<T>(
  db: Sql,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<void> {
  try {
    await db.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error === ROLLBACK_SENTINEL) return;
    throw error;
  }
}

/**
 * The checked-in migration, VERBATIM. No normalising, trimming or splitting:
 * the whole point is that PostgreSQL parses what ships, not that we do.
 */
export function readMigrationSql(fileName: string): string {
  const path = join(process.cwd(), ...MIGRATIONS_DIR, fileName);
  if (!existsSync(path)) {
    throw new Error(`migration SQL not found at ${path}`);
  }
  return readFileSync(path, 'utf8');
}
