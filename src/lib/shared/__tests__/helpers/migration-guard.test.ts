// Unit coverage for the pure half of `migration-guard.ts` — the vacuity guard
// (`assertDegradeLanded`), the off-target guard (`assertOnlyTablesMoved`) and
// the verbatim migration read.
//
// DELIBERATELY DB-FREE. It builds `PublicCatalogue` fixtures by hand, imports
// no live-DB helper and never names the test-database env var, so
// `ci:live-db-suites` does not classify it as a live-DB file and vitest runs it
// in the parallel project. `withRolledBackTransaction` and
// `readPublicCatalogue` cannot be proven without a real database and are
// covered by `migration-guard.integration.test.ts` instead — a fake handle
// would prove only that the fake was called.
//
// Every title here is a contract title: six migration-guard suites import this
// module, and the gate for #1301 checks these strings verbatim.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDegradeLanded,
  assertOnlyTablesMoved,
  readMigrationSql,
  type CatalogueEntry,
  type CataloguedTable,
  type DegradeTarget,
  type PublicCatalogue,
} from './migration-guard';

/** A migration file that exists on disk, used as the verbatim-read subject. */
const REAL_MIGRATION = '119_job_outbox_rls.sql';

function entry(name: string, definition: string): CatalogueEntry {
  return { name, definition };
}

function catalogued(table: string, overrides: Partial<CataloguedTable> = {}): CataloguedTable {
  return {
    table,
    kind: 'r',
    rowSecurity: false,
    forceRowSecurity: false,
    policies: [],
    columns: [],
    notNullColumns: [],
    columnDefaults: [],
    columnComments: [],
    indexes: [],
    constraints: [],
    comment: null,
    grants: [],
    rowDigest: 'empty rows=0',
    ...overrides,
  };
}

function catalogue(...tables: readonly CataloguedTable[]): PublicCatalogue {
  return {
    tables: Object.fromEntries(tables.map((table) => [table.table, table])),
    schemaDefaultAcls: [],
  };
}

/** A catalogue whose schema default ACLs are non-empty — the shape an
 * `ALTER DEFAULT PRIVILEGES … GRANT ALL` leaves behind. */
function catalogueWithDefaultAcls(
  defaultAcls: readonly CatalogueEntry[],
  ...tables: readonly CataloguedTable[]
): PublicCatalogue {
  return {
    tables: Object.fromEntries(tables.map((table) => [table.table, table])),
    schemaDefaultAcls: defaultAcls,
  };
}

const INDEX_A = entry('idx_reviews_account', 'INDEX DEFINITION A');
const INDEX_B = entry('idx_reviews_business', 'INDEX DEFINITION B');

describe('migration-guard', () => {
  it('assertDegradeLanded throws when the target table did not change', () => {
    const before = catalogue(catalogued('reviews', { indexes: [INDEX_A, INDEX_B] }));
    const after = catalogue(catalogued('reviews', { indexes: [INDEX_A, INDEX_B] }));

    // The vacuity guard's whole reason to exist: a degrade that silently did
    // not land makes the "the migration reinstated it" assertion pass against a
    // no-op migration.
    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: [INDEX_A.name],
      }),
    ).toThrow(/reviews.*indexes.*did not change/);
  });

  it('assertDegradeLanded passes when the target table lost an index', () => {
    const before = catalogue(catalogued('reviews', { indexes: [INDEX_A, INDEX_B] }));
    const after = catalogue(catalogued('reviews', { indexes: [INDEX_B] }));

    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: [INDEX_A.name],
      }),
    ).not.toThrow();
  });

  it('assertDegradeLanded rejects an unrelated table change when the guarded property remains intact', () => {
    // The degrade hit the WRONG table. `reviews.indexes` is byte-identical on
    // both sides, so the target's own diff is the only thing that may count as
    // proof — a change anywhere else must not stand in for it.
    const before = catalogue(
      catalogued('reviews', { indexes: [INDEX_A] }),
      catalogued('users', { indexes: [entry('idx_users_email', 'INDEX DEFINITION U')] }),
    );
    const after = catalogue(
      catalogued('reviews', { indexes: [INDEX_A] }),
      catalogued('users'),
    );

    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: [INDEX_A.name],
      }),
    ).toThrow(/reviews.*indexes.*did not change/);
  });

  it('assertDegradeLanded requires every named object to be absent after the degrade', () => {
    const before = catalogue(catalogued('reviews', { indexes: [INDEX_A, INDEX_B] }));
    const after = catalogue(catalogued('reviews', { indexes: [INDEX_B] }));

    // One of the two named indexes survived. The property DID change, so a
    // change-only contract passes here — which is exactly the weak form this
    // case rules out.
    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: [INDEX_A.name, INDEX_B.name],
      }),
    ).toThrow(new RegExp(`${INDEX_B.name}`));
  });

  it('assertDegradeLanded requires every named object to be present after an additive degrade', () => {
    // Reversed polarity, for the degrades that ADD rather than remove: one
    // caller reinstates NOT NULL, one grants privileges.
    const grant = entry('anon:SELECT', 'postgres');
    const other = entry('anon:INSERT', 'postgres');
    const before = catalogue(catalogued('reviews'));
    const after = catalogue(catalogued('reviews', { grants: [grant] }));

    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'grants',
        present: [grant.name],
      }),
    ).not.toThrow();

    // `anon:INSERT` never arrived.
    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'grants',
        present: [grant.name, other.name],
      }),
    ).toThrow(new RegExp(other.name));

    // And the other polarity's vacuity trap: a name that was ALREADY there
    // before the degrade proves nothing about the degrade.
    const alreadyThere = catalogue(catalogued('reviews', { grants: [grant] }));
    const wider = catalogue(catalogued('reviews', { grants: [grant, other] }));
    expect(() =>
      assertDegradeLanded(alreadyThere, wider, {
        table: 'reviews',
        property: 'grants',
        present: [grant.name],
      }),
    ).toThrow(new RegExp(grant.name));
  });

  it('assertDegradeLanded matches object names exactly and not by substring', () => {
    // `idx_reviews_account` is a SUBSTRING of `idx_reviews_account_v2`, so a
    // substring implementation reads the typo'd name as present in `before` and
    // gone from `after` — a pass that establishes nothing. Exact matching sees
    // that the named index was never in `before` and says so.
    const versioned = entry('idx_reviews_account_v2', 'INDEX DEFINITION V2');
    const before = catalogue(catalogued('reviews', { indexes: [versioned] }));
    const after = catalogue(catalogued('reviews'));

    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: ['idx_reviews_account'],
      }),
    ).toThrow(/idx_reviews_account was already absent from the before catalogue/);
  });

  it('assertDegradeLanded accepts deliberate target-table removal without dereferencing a missing table', () => {
    const before = catalogue(catalogued('reviews'), catalogued('users'));
    const after = catalogue(catalogued('users'));

    expect(() =>
      assertDegradeLanded(before, after, { table: 'reviews', property: 'presence' }),
    ).not.toThrow();

    // Every OTHER form needs the table on both sides, so an unexpectedly
    // missing table stays a loud failure instead of a silent pass.
    expect(() =>
      assertDegradeLanded(before, after, {
        table: 'reviews',
        property: 'indexes',
        absent: [INDEX_A.name],
      }),
    ).toThrow(/reviews/);

    // And presence is not satisfied by a table that never went away.
    expect(() =>
      assertDegradeLanded(before, after, { table: 'users', property: 'presence' }),
    ).toThrow(/users/);
  });

  it('assertDegradeLanded cannot be called with an empty object list', () => {
    const before = catalogue(catalogued('reviews', { indexes: [INDEX_A, INDEX_B] }));
    const after = catalogue(catalogued('reviews', { indexes: [INDEX_B] }));

    // THE TYPE-LEVEL HALF, and the load-bearing one. An empty selector list
    // degenerates `assertDegradeLanded` to "the property differs somehow" —
    // contract 2 of the module's own §3 reasoning, which accepts a degrade
    // that dropped ONE of four indexes while the other three were never
    // challenged. Three review rounds rejected that contract, so the selector
    // list is a NON-EMPTY tuple and the empty literal is a compile error.
    //
    // `@ts-expect-error` IS the assertion: if `DegradeTarget` ever widens back
    // to `readonly string[]`, this line type-checks, the directive becomes an
    // unused-directive error, and `pnpm typecheck` fails. A runtime assertion
    // alone could not say this — the point is that the mistake cannot be
    // WRITTEN.
    // @ts-expect-error an empty selector list is not a DegradeTarget
    const vacuous: DegradeTarget = { table: 'reviews', property: 'indexes', absent: [] };

    // THE RUNTIME HALF, because the compiler is not the only door: a
    // JavaScript caller, or anyone who casts past the type, reaches the
    // function with the same empty list. The guard throws rather than
    // returning on the weaker contract.
    expect(() => assertDegradeLanded(before, after, vacuous)).toThrow(
      /empty selector list/,
    );
  });

  it('assertOnlyTablesMoved throws when an unlisted table changed', () => {
    const before = catalogue(
      catalogued('reviews', { indexes: [INDEX_A] }),
      catalogued('users', { rowSecurity: false }),
    );
    const after = catalogue(
      catalogued('reviews'),
      catalogued('users', { rowSecurity: true }),
    );

    expect(() => assertOnlyTablesMoved(before, after, ['reviews'])).toThrow(/users/);
  });

  it('assertOnlyTablesMoved passes when only the named table changed', () => {
    const before = catalogue(
      catalogued('reviews', { indexes: [INDEX_A] }),
      catalogued('users', { notNullColumns: ['id', 'email'] }),
    );
    const after = catalogue(
      catalogued('reviews'),
      // Same members, different order — the catalogue is sorted, so an
      // order-only difference must never read as a change.
      catalogued('users', { notNullColumns: ['id', 'email'] }),
    );

    expect(() => assertOnlyTablesMoved(before, after, ['reviews'])).not.toThrow();
  });

  it('assertOnlyTablesMoved rejects newly created and dropped unlisted tables', () => {
    const before = catalogue(catalogued('reviews'), catalogued('users'));
    const after = catalogue(catalogued('reviews'), catalogued('shadow_audit'));

    let message = '';
    try {
      assertOnlyTablesMoved(before, after, ['reviews']);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('users');
    expect(message).toContain('shadow_audit');
  });

  it('assertOnlyTablesMoved rejects a same-name policy definition change on an unlisted table', () => {
    // The name is unchanged; the effect is not. A policy rewritten in place, or
    // flipped to RESTRICTIVE, or retargeted to another role, is invisible to a
    // name-only comparison.
    const before = catalogue(
      catalogued('reviews'),
      catalogued('users', {
        policies: [entry('users_owner_select', 'SELECT PERMISSIVE roles=authenticated using=(x)')],
      }),
    );
    const after = catalogue(
      catalogued('reviews'),
      catalogued('users', {
        policies: [entry('users_owner_select', 'SELECT PERMISSIVE roles=anon using=(true)')],
      }),
    );

    expect(() => assertOnlyTablesMoved(before, after, ['reviews'])).toThrow(/users/);
  });

  it('assertOnlyTablesMoved detects grant-option changes and grants to roles outside the client-role list', () => {
    const before = catalogue(
      catalogued('reviews'),
      catalogued('users', { grants: [entry('service_role:SELECT', 'postgres')] }),
      catalogued('accounts', { grants: [entry('postgres:SELECT', 'postgres')] }),
    );

    // A grant option added under an unchanged grantee:privilege name.
    const grantOptionAdded = catalogue(
      catalogued('reviews'),
      catalogued('users', { grants: [entry('service_role:SELECT', 'postgres:GRANT OPTION')] }),
      catalogued('accounts', { grants: [entry('postgres:SELECT', 'postgres')] }),
    );
    expect(() => assertOnlyTablesMoved(before, grantOptionAdded, ['reviews'])).toThrow(/users/);

    // A grantee nobody enumerated: neither `anon` nor `authenticated`.
    const publicGranted = catalogue(
      catalogued('reviews'),
      catalogued('users', { grants: [entry('service_role:SELECT', 'postgres')] }),
      catalogued('accounts', {
        grants: [entry('postgres:SELECT', 'postgres'), entry('PUBLIC:SELECT', 'postgres')],
      }),
    );
    expect(() => assertOnlyTablesMoved(before, publicGranted, ['reviews'])).toThrow(/accounts/);
  });

  it('assertOnlyTablesMoved rejects a new view granting select to a client role', () => {
    // #1301 RT-5. The catalogue used to read `relkind in ('r','p')` only, so a
    // migration could add a view over a deny-all table, GRANT SELECT on it to
    // `anon`, and move nothing the guard compared. Confirmed in psql against
    // the live container before the fix: the table privilege read false, the
    // view privilege read true, and the catalogue held zero rows for the view.
    const before = catalogue(
      catalogued('reviews'),
      catalogued('analytics_events', { grants: [] }),
    );
    const leaked = catalogue(
      catalogued('reviews'),
      catalogued('analytics_events', { grants: [] }),
      catalogued('analytics_events_leak', {
        kind: 'v',
        rowDigest: '(none)',
        grants: [entry('anon:SELECT', 'postgres')],
      }),
    );

    expect(() => assertOnlyTablesMoved(before, leaked, ['reviews'])).toThrow(
      /analytics_events_leak \(appeared\)/,
    );
  });

  it('assertOnlyTablesMoved rejects a relation replaced by a view of the same name', () => {
    // The `kind` property exists so the swap is a CHANGE, not a coincidence of
    // names: a table dropped and re-created as a view keeps its key.
    const before = catalogue(catalogued('reviews'), catalogued('accounts'));
    const swapped = catalogue(
      catalogued('reviews'),
      catalogued('accounts', { kind: 'v', rowDigest: '(none)' }),
    );

    expect(() => assertOnlyTablesMoved(before, swapped, ['reviews'])).toThrow(/accounts \(kind/);
  });

  it('assertOnlyTablesMoved rejects an off-target row update', () => {
    // #1301 RT-3. `UPDATE accounts SET display_name = …` appended to migration
    // 051 survived 5 of 5 red-team runs: the catalogue was pure schema, and no
    // schema property moves when rows change. A count alone would not have
    // caught this one either — the row count is identical on both sides.
    const before = catalogue(
      catalogued('reviews'),
      catalogued('accounts', { rowDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rows=3' }),
    );
    const mutated = catalogue(
      catalogued('reviews'),
      catalogued('accounts', { rowDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb rows=3' }),
    );

    expect(() => assertOnlyTablesMoved(before, mutated, ['reviews'])).toThrow(
      /accounts \(rowDigest\)/,
    );
  });

  it('assertOnlyTablesMoved rejects a widened schema default ACL', () => {
    // #1301 RT-4. `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
    // TABLES TO anon, authenticated` survived 4 of 4 runs. It is schema-level,
    // so no per-table comparison can see it, and migration 118's own degrade
    // performs that exact statement.
    const widened = entry('public:r:anon:SELECT', 'postgres');
    const before = catalogue(catalogued('reviews'));
    const after = catalogueWithDefaultAcls([widened], catalogued('reviews'));

    expect(() => assertOnlyTablesMoved(before, after, ['reviews'])).toThrow(/pg_default_acl/);
  });

  it("assertOnlyTablesMoved with schemaDefaultAcls 'changed' proves the widening rather than excusing it", () => {
    const widened = entry('public:r:anon:SELECT', 'postgres');
    const before = catalogue(catalogued('reviews'));
    const after = catalogueWithDefaultAcls([widened], catalogued('reviews'));

    // The declared widening landed: accepted.
    expect(() =>
      assertOnlyTablesMoved(before, after, ['reviews'], { schemaDefaultAcls: 'changed' }),
    ).not.toThrow();

    // The declared widening did NOT land: rejected. This is the half that
    // stops the option being an escape hatch — a case that claims to prove a
    // default-ACL change cannot pass against a degrade that did nothing.
    expect(() =>
      assertOnlyTablesMoved(before, before, ['reviews'], { schemaDefaultAcls: 'changed' }),
    ).toThrow(/did not land/);
  });

  it('readMigrationSql throws when the migration file is missing', () => {
    let message = '';
    try {
      readMigrationSql('999_this_migration_does_not_exist.sql');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The RESOLVED path, so a suite naming a file that was renamed or never
    // existed reads the answer off the failure instead of an ENOENT with no
    // statement of what was expected where.
    expect(message).toContain(join('supabase', 'migrations'));
    expect(message).toContain('999_this_migration_does_not_exist.sql');
    expect(message).toMatch(/migration SQL not found/);
  });

  it('readMigrationSql returns every byte of an existing migration unchanged', () => {
    const direct = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', REAL_MIGRATION),
      'utf8',
    );

    // Byte equality, not "contains the statements": the point of executing the
    // checked-in file is that PostgreSQL parses exactly what ships, so a helper
    // that trimmed, normalised or split the SQL would break that guarantee
    // silently.
    expect(readMigrationSql(REAL_MIGRATION)).toBe(direct);
    expect(Buffer.from(readMigrationSql(REAL_MIGRATION), 'utf8')).toEqual(
      Buffer.from(direct, 'utf8'),
    );
    expect(direct.length).toBeGreaterThan(0);
  });
});
