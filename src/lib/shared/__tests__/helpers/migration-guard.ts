// Shared machinery for the migration-guard suites (#1301): read the `public`
// catalogue, prove a degrade landed, prove nothing else moved, read the
// checked-in migration verbatim, and roll back — then prove the rollback.
//
// WHAT THE CATALOGUE COVERS, after review round 1. Four things it did not read
// each let a real mutation survive the whole suite family, and each is now
// read, with a case that proves the mutation fails:
//   - VIEWS (`relkind` `v`/`m`). A view over a deny-all table with
//     `GRANT SELECT TO anon` re-opens the boundary migration 049 exists to
//     close, and the catalogue saw nothing (RT-5).
//   - `pg_default_acl`. `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO
//     anon, authenticated` is schema-level, so no per-table comparison reaches
//     it — and migration 118's own degrade performs that exact statement
//     (RT-4).
//   - ROWS, as a per-relation digest. The catalogue was pure schema, so an
//     off-target `UPDATE`/`DELETE`/`INSERT` moved nothing it read (RT-3).
//   - The rollback itself. A migration carrying its own `BEGIN … COMMIT`
//     commits everything before that `COMMIT`, because the inner `COMMIT` ends
//     the transaction this module opened (the adversarial P1).
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
  /** `pg_class.relkind`: `r` table, `p` partitioned table, `v` view,
   * `m` materialized view. Compared like any other property, so a table
   * REPLACED by a view of the same name reads as a change rather than as a
   * coincidence of names (#1301 RT-5). */
  kind: string;
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
  /**
   * `"<md5 of the row set> rows=<count>"`, order-independent, or `'(none)'`
   * for a relation that stores no rows of its own (a view).
   *
   * The catalogue is otherwise pure SCHEMA, and that was a hole: appending
   * `UPDATE accounts SET display_name = …` to a migration moved nothing any
   * catalogue property reads, and the mutation survived 5 of 5 red-team runs
   * (#1301 RT-3). A digest rather than a bare count on purpose — the test
   * container is nearly empty, so a count alone passes an UPDATE that rewrites
   * every row it has.
   */
  rowDigest: string;
}

export interface PublicCatalogue {
  tables: Readonly<Record<string, CataloguedTable>>;
  /**
   * `pg_default_acl` — the privileges a role grants automatically on objects
   * it creates LATER. Schema-level, so it belongs to the catalogue rather than
   * to any one table.
   *
   * `"<schema>:<objtype>:<grantee>:<privilege>" -> "<granting role>"`.
   * `<schema>` is `(global)` for an `ALTER DEFAULT PRIVILEGES` with no
   * `IN SCHEMA` clause, which reaches `public` as well.
   *
   * Read because it was not: appending
   * `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
   * authenticated` survived 4 of 4 red-team runs (#1301 RT-4). Migration 118's
   * own degrade performs that exact statement, so the suite family was
   * deliberately doing the thing it could not detect.
   */
  schemaDefaultAcls: readonly CatalogueEntry[];
}

/**
 * The catalogue properties that hold a list of NAMED entries — the only ones a
 * selector list can name. `table` and `comment` are scalars and the two
 * row-security flags are booleans, so none of them has names to select on.
 */
type CatalogueListProperty = {
  [K in keyof CataloguedTable]: CataloguedTable[K] extends readonly CatalogueEntry[]
    ? K
    : CataloguedTable[K] extends readonly string[]
      ? K
      : never;
}[keyof CataloguedTable];

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
 * Every form requires the table on BOTH sides, so an unexpectedly missing table
 * stays a loud failure rather than a silent pass. A degrade that REMOVES the
 * table has its own function, `assertTableRemoved` — it used to be a
 * `{ property: 'presence' }` variant here, but `'presence'` is not a
 * `keyof CataloguedTable`: it was a table smuggled into the property slot,
 * which bought a fifteen-line branch inside this function for one caller and
 * made every other reader check whether `property` meant a property (#1301 S-6).
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
 *
 * THE SEAM EXISTS FOR ONE CALLER, and naming it is the point: migration 117's
 * `clientGrantNames(await deriveTablePrivileges(...))` is built from a live
 * `acldefault` read, so its length is genuinely unknowable until the query
 * returns. A list a reader can COUNT in the source belongs in an `as const`
 * tuple instead — migration 048's four index names were `Object.keys` over a
 * literal six lines above and now are (#1301 S-7).
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

/**
 * Renders one entry so that two renderings are equal EXACTLY when the entry is.
 *
 * It was `name + '\u0000' + definition`, joined on `'\u0001'`, under a comment
 * claiming those two characters "cannot occur in a catalogue name or
 * definition". That claim is false: a `COMMENT ON COLUMN` body is arbitrary
 * text and PostgreSQL accepts U+0001 in it, so two different entries could
 * render identically and a real difference would compare equal (#1301 RT-17).
 *
 * `JSON.stringify` of the pair is injective for any string content, so there
 * is no separator to reason about and no claim to keep true.
 */
function renderEntry(name: string, definition: string): string {
  return JSON.stringify([name, definition]);
}

/**
 * Every property, with its KIND. Exhaustive by construction: `satisfies` makes
 * a property added to `CataloguedTable` and forgotten here a COMPILE error, so
 * `assertOnlyTablesMoved` can never quietly stop comparing one.
 *
 * The kind is carried here rather than sniffed from the runtime value. The
 * previous shape mapped every property to `true` and asked `typeof value` at
 * the point of use, which bought an unreachable error branch:
 * `CatalogueListProperty` already excludes every scalar, so the "this is a
 * scalar" throw could not fire and sat permanently uncovered in the report
 * `ci:fallow:coverage` consumes (#1301 S-5). The kind of a property is
 * statically known from its key; read it from the key.
 */
const TABLE_PROPERTY_KINDS = {
  table: 'scalar',
  kind: 'scalar',
  rowSecurity: 'scalar',
  forceRowSecurity: 'scalar',
  comment: 'scalar',
  rowDigest: 'scalar',
  policies: 'list',
  columns: 'list',
  notNullColumns: 'list',
  columnDefaults: 'list',
  columnComments: 'list',
  indexes: 'list',
  constraints: 'list',
  grants: 'list',
} as const satisfies Record<keyof CataloguedTable, 'scalar' | 'list'>;

const TABLE_PROPERTIES: readonly (keyof CataloguedTable)[] = Object.keys(
  TABLE_PROPERTY_KINDS,
) as (keyof CataloguedTable)[];

interface RelationRow {
  table_name: string;
  kind: string;
  row_security: boolean;
  force_row_security: boolean;
  comment: string | null;
  row_digest: string | null;
}

interface DefaultAclRow {
  name: string;
  definition: string;
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
    kind: row.kind,
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
    rowDigest: row.row_digest ?? '(none)',
  };
}

function byNameThenDefinition(left: CatalogueEntry, right: CatalogueEntry): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.definition === right.definition) return 0;
  return left.definition < right.definition ? -1 : 1;
}

/**
 * Every relation in schema `public` with `relkind in ('r', 'p', 'v', 'm')` —
 * tables, partitioned tables, VIEWS and materialized views — keyed by relation
 * NAME, with every array sorted so a diff is order-independent. Plus the
 * schema's `pg_default_acl` entries, which belong to no single table.
 *
 * Views are included because excluding them was a hole: a migration could add
 * a view over a deny-all table and `GRANT SELECT` on it to `anon`, and the
 * catalogue saw nothing — which re-opens exactly the boundary migration 049
 * exists to close (#1301 RT-5). A view carries no rows of its own, so its
 * `rowDigest` is `'(none)'`; its ACL is read like any other relation's.
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
 *
 * SECOND BOUND, also stated rather than tolerated: `rowDigest` is computed for
 * `relkind in ('r', 'p')` only, through `query_to_xml`, which EXECUTES a count
 * and an md5 aggregate per table. On the local test container every table is
 * near-empty and the whole read stays in the tens of milliseconds. A view's
 * rows are derived, and a materialized view's are a snapshot refreshed on its
 * own schedule, so neither is digested — a `REFRESH` is not a migration
 * regression.
 */
export async function readPublicCatalogue(tx: TransactionSql): Promise<PublicCatalogue> {
  const relations = await tx<RelationRow[]>`
    SELECT cls.relname AS table_name,
           cls.relkind::text AS kind,
           cls.relrowsecurity AS row_security,
           cls.relforcerowsecurity AS force_row_security,
           obj_description(cls.oid, 'pg_class') AS comment,
           CASE WHEN cls.relkind IN ('r', 'p') THEN (
             xpath(
               '/row/d/text()',
               query_to_xml(
                 format(
                   'SELECT coalesce(md5(string_agg(md5(t.*::text), '''' ORDER BY md5(t.*::text))), ''empty'')'
                   || ' || '' rows='' || count(*)::text AS d FROM public.%I t',
                   cls.relname
                 ),
                 false, true, ''
               )
             )
           )[1]::text END AS row_digest
      FROM pg_class cls
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY cls.relname
  `;

  const defaultAcls = await tx<DefaultAclRow[]>`
    SELECT coalesce(nsp.nspname, '(global)')
           || ':' || dac.defaclobjtype::text
           || ':' || (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                           ELSE acl.grantee::regrole::text END)
           || ':' || acl.privilege_type AS name,
           dac.defaclrole::regrole::text
             || (CASE WHEN acl.is_grantable THEN ':GRANT OPTION' ELSE '' END) AS definition
      FROM pg_default_acl dac
      LEFT JOIN pg_namespace nsp ON nsp.oid = dac.defaclnamespace
      CROSS JOIN LATERAL aclexplode(dac.defaclacl) AS acl
     WHERE dac.defaclnamespace = 0
        OR nsp.nspname = 'public'
  `;

  const entries = await tx<EntryRow[]>`
    WITH relations AS (
      SELECT cls.oid, cls.relname, cls.relowner, cls.relacl
        FROM pg_class cls
        JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
       WHERE nsp.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm')
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

  const schemaDefaultAcls: CatalogueEntry[] = defaultAcls
    .map((row) => ({ name: row.name, definition: row.definition }))
    .sort(byNameThenDefinition);

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
  return { tables: out, schemaDefaultAcls };
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
    .map((item) => (typeof item === 'string' ? renderEntry(item, '') : renderEntry(item.name, item.definition)))
    .sort()
    .join('\n');
}

/** One list of named entries, rendered order-independently, exactly as
 * `renderValue` renders a list property. Used for the schema-level default
 * ACLs, which hang off the catalogue rather than off any one table. */
function renderEntries(entries: readonly CatalogueEntry[]): string {
  return [...entries]
    .map((entry) => renderEntry(entry.name, entry.definition))
    .sort()
    .join('\n');
}

/**
 * The entry NAMES of a LIST property. It takes the list type rather than the
 * whole property union, so there is no scalar case to reject at runtime —
 * `CatalogueListProperty` already excludes every scalar key, and the rejection
 * branch this replaces was unreachable and permanently uncovered (#1301 S-5).
 */
function listNames(value: readonly CatalogueEntry[] | readonly string[]): string[] {
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
 *
 * WHY EVERY DEGRADE/RE-APPLY CASE CALLS THIS, stated once here so the seven
 * suites do not each restate it: four of the seven "moves no other table"
 * cases ran the cycle WITHOUT proving the degrade landed while three proved
 * it — one plan, three shapes, and a reader could not tell a deliberate
 * omission from an oversight (#1301 S-1/F-F/RT-15). All seven now prove it,
 * each with the same targets its sibling case uses. A call site needs a
 * pointer here, not a copy of this paragraph.
 */
export function assertDegradeLanded(
  before: PublicCatalogue,
  after: PublicCatalogue,
  target: DegradeTarget,
): void {
  const beforeTable = before.tables[target.table];
  const afterTable = after.tables[target.table];

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
        'assertTableRemoved(before, after, table) for a deliberate table removal',
    );
  }

  if (renderValue(beforeTable[target.property]) === renderValue(afterTable[target.property])) {
    throw new Error(
      `${label} did not change between before and after — the degrade did not land, so the ` +
        'case would pass against a no-op migration',
    );
  }

  // The boolean variant carries no names: the value comparison above IS the
  // proof, and it has already thrown if the value did not flip. Narrowing on
  // TARGET rather than on `selectors` is what makes `target.property` a
  // `CatalogueListProperty` below, so the list read needs no runtime "is this a
  // scalar" rejection — the branch that used to sit there was unreachable and
  // permanently uncovered (#1301 S-5).
  if (!('absent' in target) && !('present' in target)) return;

  const beforeSet = new Set(listNames(beforeTable[target.property]));
  const afterSet = new Set(listNames(afterTable[target.property]));

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

  // `target.present` is the only remaining variant with a list: the boolean
  // variant returned above and the `absent` variant returned just now.
  for (const name of target.present) {
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
 * What the caller expects to have happened to `pg_default_acl`.
 *
 * `'unchanged'` is the default and is what every ordinary case wants.
 * `'changed'` is NOT an escape hatch: it THROWS when the default ACLs did not
 * move, so a case that claims a widening must still prove one. That asymmetry
 * is deliberate — migration 118's degrade performs
 * `ALTER DEFAULT PRIVILEGES … GRANT ALL` on purpose, and before this parameter
 * existed the only way to express that was for the guard not to look, which is
 * how the statement survived 4 of 4 red-team runs (#1301 RT-4).
 */
export type SchemaDefaultAclExpectation = 'unchanged' | 'changed';

export interface OnlyTablesMovedOptions {
  schemaDefaultAcls?: SchemaDefaultAclExpectation;
}

/**
 * One relation's SCHEMA — every catalogue property except `rowDigest`.
 *
 * Narrow, and deliberately awkward to reach for. Two cases legitimately need
 * it, and both are about the CASE's own doing rather than the migration's:
 *
 *   - a case that SEEDS ITS OWN ROWS between the two readings it compares.
 *     Migration 053's idempotence case plants role fixtures after its `before`
 *     reading, so the two sides differ in rows while the schema must not. It
 *     owes a stronger row assertion of its own, and has one: it deep-compares
 *     every column of every seeded row.
 *   - a case whose DEGRADE destroys rows by construction. Migration 118's
 *     degrade is `DROP TABLE`, so the re-applied table is empty whatever the
 *     table held before. Row loss there is the degrade, not a regression.
 *
 * `assertOnlyTablesMoved` still compares `rowDigest` for every relation it
 * guards; this only narrows one deliberate whole-table equality.
 *
 * Never use it to quiet a `rowDigest` difference a MIGRATION caused. That
 * difference is the finding (#1301 RT-3).
 */
export function schemaOnly(table: CataloguedTable): Omit<CataloguedTable, 'rowDigest'> {
  const { rowDigest: _rowDigest, ...schema } = table;
  return schema;
}

/**
 * The degrade REMOVED the table. Both halves are checked, for the same reason
 * `assertDegradeLanded` checks both directions: a table already absent from
 * `before` makes the removal prove nothing, and a table still present in
 * `after` means the removal did not land.
 *
 * Its own function rather than a `DegradeTarget` variant, because a removal is
 * not a property of a table — it is the table (#1301 S-6).
 */
export function assertTableRemoved(
  before: PublicCatalogue,
  after: PublicCatalogue,
  table: string,
): void {
  if (!before.tables[table]) {
    throw new Error(
      `assertTableRemoved(${table}): it was already absent from the before catalogue — the ` +
        'removal proves nothing',
    );
  }
  if (after.tables[table]) {
    throw new Error(
      `assertTableRemoved(${table}): it is still present in the after catalogue — the ` +
        'removal did not land',
    );
  }
}

/**
 * The off-target guard. A migration may harden the one table it names while
 * doing arbitrary damage elsewhere — appending `GRANT ALL ON admin_audit_log TO
 * anon;` to migration 119 passed its whole suite once, and the grant really
 * landed (#1171). Every relation outside `tables` must come out
 * byte-identical, no relation may appear or disappear outside that list, and
 * the schema default ACLs must match `options.schemaDefaultAcls`.
 *
 * "Relation" means tables, partitioned tables, VIEWS and materialized views,
 * so a new view granting `SELECT` to a client role is an offender rather than
 * an invisible (#1301 RT-5). Each relation's comparison includes its
 * `rowDigest`, so an off-target `UPDATE` or `DELETE` is an offender rather
 * than an invisible (#1301 RT-3).
 */
export function assertOnlyTablesMoved(
  before: PublicCatalogue,
  after: PublicCatalogue,
  tables: readonly string[],
  options: OnlyTablesMovedOptions = {},
): void {
  const expectation = options.schemaDefaultAcls ?? 'unchanged';
  const defaultAclsMoved =
    renderEntries(before.schemaDefaultAcls) !== renderEntries(after.schemaDefaultAcls);

  if (expectation === 'unchanged' && defaultAclsMoved) {
    throw new Error(
      'migration changed the schema default ACLs (pg_default_acl). ALTER DEFAULT PRIVILEGES ' +
        'grants every table created AFTERWARDS, so it is off-target damage that no per-table ' +
        "comparison can see. Pass { schemaDefaultAcls: 'changed' } only where the case itself " +
        'performs the widening and means to prove it landed.',
    );
  }
  if (expectation === 'changed' && !defaultAclsMoved) {
    throw new Error(
      "this case declared { schemaDefaultAcls: 'changed' }, but pg_default_acl is identical " +
        'before and after — the widening it claims to prove did not land, so the case would ' +
        'pass against a degrade that did nothing',
    );
  }

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
    `migration moved relations outside [${[...allowed].sort().join(', ')}]: ` +
      offenders.join('; '),
  );
}

/**
 * The two browser-reachable Supabase roles. Every "grants none of them"
 * assertion in this family enumerates them.
 */
export const CLIENT_ROLES = ['anon', 'authenticated'] as const;

/**
 * Every table privilege THIS PostgreSQL major defines, derived from
 * `acldefault('r', <owner>)` rather than spelled out.
 *
 * Deriving rather than spelling is what lets a `REVOKE ALL` assertion tell
 * itself apart from `REVOKE SELECT`: the expected set grows with the server.
 * PostgreSQL 16 defines seven; 17 adds MAINTAIN for eight, which is the major
 * both Supabase projects and the CI lane now run.
 *
 * It throws on a short list rather than returning one. An empty or truncated
 * list makes every "grants none of them" assertion pass vacuously, which is the
 * failure mode this suite family keeps rediscovering — so the floor is checked
 * here, once, instead of at each call site.
 *
 * It lived in BOTH the 117 and the 118 suite, byte-for-byte including this
 * guard, which put two owners on one anti-vacuity check in the family whose
 * failure mode IS the vacuous pass (#1301 S-2).
 */
export async function deriveTablePrivileges(tx: TransactionSql, table: string): Promise<string[]> {
  const rows = await tx<{ privilege_type: string }[]>`
    SELECT DISTINCT acl.privilege_type
      FROM aclexplode(acldefault('r', (
             SELECT cls.relowner FROM pg_class cls WHERE cls.oid = to_regclass(${`public.${table}`})
           ))) AS acl
     ORDER BY 1
  `;
  const privileges = rows.map((row) => row.privilege_type);
  if (privileges.length < PRIVILEGE_FLOOR) {
    throw new Error(
      `deriveTablePrivileges(${table}) returned ${privileges.length} privileges, below the ` +
        `PostgreSQL 16 floor of ${PRIVILEGE_FLOOR} — every "grants none of them" assertion ` +
        'built on this list would be vacuous. A short list means the table name did not ' +
        'resolve, not that the server defines fewer privileges.',
    );
  }
  return privileges;
}

/** The PostgreSQL 16 floor: SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
 * REFERENCES, TRIGGER. 17 adds MAINTAIN, so a lane on 17 derives eight. */
const PRIVILEGE_FLOOR = 7;

/**
 * Which of this major's table privileges are also COLUMN-level privileges,
 * DERIVED from the server rather than spelled out.
 *
 * `acldefault('c', …)` is empty — columns have no default privileges — so the
 * column set cannot be derived the way `deriveTablePrivileges` derives the
 * table set. It is derived here by asking `has_column_privilege` about each
 * table privilege: PostgreSQL raises `22023 invalid_parameter_value`
 * ("unrecognized privilege type") for one that is not column-level, and
 * answers for one that is. Each probe runs in its own SAVEPOINT, because an
 * error otherwise aborts the caller's transaction.
 *
 * It replaces `expect(['SELECT','INSERT','UPDATE','REFERENCES']).toHaveLength(4)`,
 * which restated its own literal's length while its comment claimed it would
 * "fail loudly" if PostgreSQL added a fifth. It could not: the literal and the
 * expectation were the same four names (#1301 RT-7). This can — a fifth
 * column-level privilege appears in the returned list.
 *
 * On PostgreSQL 16 and 17 alike this returns SELECT, INSERT, UPDATE and
 * REFERENCES; 17's new MAINTAIN is table-level only.
 *
 * IT THROWS BELOW A FLOOR OF FOUR, and that half is as load-bearing as the
 * derivation. A derivation catches the set GROWING — the thing the literal it
 * replaced could not do — but on its own it lets the set silently SHRINK: red
 * team round 2 narrowed this function to `SELECT` alone and every caller still
 * passed, because each only asserts that the roles hold none of whatever it
 * returns (#1301 RT2-1). A shorter list is never a smaller SQL standard; it is
 * a broken probe.
 */
export async function deriveColumnPrivileges(
  db: Sql,
  table: string,
  column: string,
): Promise<string[]> {
  const supported: string[] = [];
  // Its own transaction, so a caller outside one can use it and so the
  // SAVEPOINTs below have something to roll back to. Read-only throughout.
  await db.begin(async (tx) => {
    for (const privilege of await deriveTablePrivileges(tx, table)) {
      try {
        await tx.savepoint(
          async (probe) =>
            probe`
              SELECT has_column_privilege(
                current_user, ${`public.${table}`}, ${column}, ${privilege}
              )
            `,
        );
        supported.push(privilege);
      } catch (error) {
        // Narrow, never silent: 22023 is "unrecognized privilege type", which
        // is the ANSWER — this privilege has no column-level form on this
        // major. Anything else is a real failure and must not be read as one.
        if (!isUnrecognizedPrivilegeType(error)) throw error;
      }
    }
  });
  if (supported.length < COLUMN_PRIVILEGE_FLOOR) {
    throw new Error(
      `deriveColumnPrivileges(${table}.${column}) returned ${supported.length} privileges ` +
        `(${supported.join(', ') || 'none'}), below the SQL-standard floor of ` +
        `${COLUMN_PRIVILEGE_FLOOR} — every "grants none of them" assertion built on this ` +
        'list would under-cover. A short list means the probe broke, not that the standard ' +
        'shrank.',
    );
  }
  return supported;
}

/** SELECT, INSERT, UPDATE, REFERENCES — the four column-level privileges the
 * SQL standard defines, present on PostgreSQL 16 and 17 alike. A FLOOR, not a
 * spelled expectation: the derivation is what admits a fifth. */
const COLUMN_PRIVILEGE_FLOOR = 4;

/** `22023 invalid_parameter_value`, raised by `has_column_privilege` for a
 * privilege type with no column-level form. */
function isUnrecognizedPrivilegeType(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '22023' && typeof message === 'string' && message.includes('privilege type');
}

/** `"<client role>:<privilege>"` for every pair — the `grants` entry names a
 * client role would hold if a migration granted it these privileges. */
export function clientGrantNames(privileges: readonly string[]): string[] {
  return CLIENT_ROLES.flatMap((role) => privileges.map((privilege) => `${role}:${privilege}`));
}

/** Rollback marker. Module-private, so no caller can throw it by accident. */
const ROLLBACK_SENTINEL = new Error('migration-guard rolled-back transaction sentinel');

/**
 * A cheap fingerprint of the schema-level state a LEAKED transaction would
 * leave behind, read OUTSIDE any transaction.
 *
 * `withRolledBackTransaction` promises the database is untouched afterwards.
 * That promise rests on the rollback sentinel firing, and a migration carrying
 * its OWN `BEGIN … COMMIT` breaks it: the inner `COMMIT` ends the transaction
 * the wrapper opened, so everything up to that point is already durable when
 * the sentinel is finally thrown. This is not hypothetical — migration 119
 * carries its own `BEGIN`/`COMMIT` today (#1301, adversarial P1).
 *
 * TEXT DETECTION WAS CONSIDERED AND REJECTED. Refusing a migration whose text
 * contains `BEGIN` cannot be written without a SQL lexer: `DO $$ BEGIN … END
 * $$` is ordinary PL/pgSQL and migration 053 uses it. Hand-rolled SQL lexing is
 * precisely the approach that lost five red-team passes on #1171 and that this
 * whole module exists to replace. So the leak is DETECTED after the fact
 * rather than predicted from the file.
 *
 * WHAT IT COVERS, stated rather than implied: the relation set with each
 * relation's kind, ACL and row-security flags, plus every `pg_default_acl`
 * entry. Those are the two things a leaked migration changes that no later
 * case would notice — a dropped-and-recreated table and a widened schema
 * default ACL are exactly what migration 118's degrade performs. It does NOT
 * fingerprint columns, indexes, policies or rows: a full catalogue read on
 * every call would roughly triple the suite family's runtime, and a leak large
 * enough to matter moves one of the two things above.
 */
async function readLeakSentinel(db: Sql): Promise<string> {
  const [row] = await db<{ fingerprint: string }[]>`
    SELECT md5(
             coalesce((
               SELECT string_agg(
                        cls.relname || ':' || cls.relkind::text
                          || ':' || coalesce(cls.relacl::text, '(default)')
                          || ':' || cls.relrowsecurity::text
                          || ':' || cls.relforcerowsecurity::text,
                        '\u0001' ORDER BY cls.relname
                      )
                 FROM pg_class cls
                 JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
                WHERE nsp.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm')
             ), '(no relations)')
             || '\u0002'
             || coalesce((
               SELECT string_agg(
                        coalesce(nsp.nspname, '(global)') || ':' || dac.defaclobjtype::text
                          || ':' || dac.defaclacl::text,
                        '\u0001' ORDER BY 1
                      )
                 FROM pg_default_acl dac
                 LEFT JOIN pg_namespace nsp ON nsp.oid = dac.defaclnamespace
                WHERE dac.defaclnamespace = 0 OR nsp.nspname = 'public'
             ), '(no default acls)')
           ) AS fingerprint
  `;
  if (!row) throw new Error('readLeakSentinel returned no row');
  return row.fingerprint;
}

/**
 * Runs `fn` inside `db.begin` and ALWAYS rolls back, by throwing a
 * module-private sentinel after the callback returns.
 *
 * It re-throws any OTHER error UNCHANGED. That is load-bearing rather than
 * tidy: a wrapper that swallowed a callback error would turn every failing
 * executing case in six suites into a pass.
 *
 * Afterwards it VERIFIES the rollback against a fingerprint read outside the
 * transaction — see `readLeakSentinel`.
 *
 * The callback's return value is discarded, so its type is `unknown`: the
 * generic parameter this signature used to declare appeared only in the
 * callback's own return type and never in this function's, which is a type
 * parameter that constrains nothing (#1301 S-11).
 */
export async function withRolledBackTransaction(
  db: Sql,
  fn: (tx: TransactionSql) => Promise<unknown>,
): Promise<void> {
  const before = await readLeakSentinel(db);
  try {
    // REPEATABLE READ, and it is load-bearing rather than tidy. Every
    // comparison in this family reads the catalogue twice inside one
    // transaction and attributes the difference to the migration. Under READ
    // COMMITTED that attribution is false: each statement takes a fresh
    // snapshot, so a row another process COMMITS between the two readings
    // shows up as a difference the migration did not cause. `rowDigest` made
    // that reachable — the shared advisory lock serializes the sibling suites,
    // but nothing serializes an unrelated suite writing `job_outbox`,
    // `analytics_events` or a poller heartbeat on the same container, and all
    // three carry committed rows today.
    //
    // A single snapshot for the whole transaction makes the comparison mean
    // what it claims: everything the migration did is visible, because it
    // happened in THIS transaction, and nothing anybody else did is.
    await db.begin('isolation level repeatable read', async (tx) => {
      await fn(tx);
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error !== ROLLBACK_SENTINEL) throw error;
  }

  // The rollback is VERIFIED, not assumed. See `readLeakSentinel`'s JSDoc for
  // why a migration carrying its own COMMIT defeats the sentinel, and why this
  // detects the condition instead of predicting it from the file's text.
  //
  // It runs after a callback error too: a case that failed mid-transaction is
  // exactly when a leak is most likely, and the leak must not be reported as
  // the callback's failure. If both happen, the callback error wins — it is
  // re-thrown above — which is deliberate: the wrapper must never swallow a
  // failing assertion, and a leak with a red suite is a second finding on an
  // already-red run.
  const after = await readLeakSentinel(db);
  if (after !== before) {
    throw new Error(
      'withRolledBackTransaction did not leave the database untouched: the public relation ' +
        'set, a relation ACL, a row-security flag or pg_default_acl differs after the ' +
        'rollback. A migration that carries its own BEGIN/COMMIT commits everything before ' +
        'its COMMIT, because the inner COMMIT ends the transaction this wrapper opened.',
    );
  }
}

/**
 * The checked-in migration, VERBATIM. No normalising, trimming or splitting:
 * the whole point is that PostgreSQL parses what ships, not that we do.
 *
 * WHY EVERY SUITE ON THIS MODULE OPENS ITS CLIENT WITH `max: 1`, stated once
 * here rather than in each `beforeAll`: the text this returns is executed
 * through `tx.unsafe` inside a transaction the suite also owns, and
 * postgres.js REFUSES a transaction-bearing `unsafe` on a pooled client
 * (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`) because
 * it cannot guarantee the statements land on one backend. Every case in these
 * suites is sequential, so a single connection costs nothing.
 */
export function readMigrationSql(fileName: string): string {
  const path = join(process.cwd(), ...MIGRATIONS_DIR, fileName);
  if (!existsSync(path)) {
    throw new Error(`migration SQL not found at ${path}`);
  }
  return readFileSync(path, 'utf8');
}
