// The half of `migration-guard.ts` that cannot be proven without a database:
// `withRolledBackTransaction` and `readPublicCatalogue`. A fake handle would
// prove only that the fake was called — the guarantee is that the row really is
// gone from PostgreSQL after the wrapper returns, that a callback error reaches
// the caller unchanged, and that the catalogue reader really renders all eleven
// `CataloguedTable` dimensions out of the system catalogues. The pure half
// lives in `migration-guard.test.ts`, which opens no connection and therefore
// builds its `PublicCatalogue` fixtures BY HAND — which is exactly why the
// reader needs a case here: a hand-built fixture cannot notice the reader
// dropping a dimension, and six migration-shape suites would go blind to that
// dimension while still reporting green.
//
// It executes NO DDL, deliberately: every statement here is DML on `users`, so
// `ci:live-db-suites` R2 is satisfied without a `MIGRATION_SHAPE_FILES` entry —
// `auditLiveDbFile` returns before the allowlist is consulted when a file
// carries no executed DDL. It takes the cross-process live-DB lock anyway,
// because it asserts that a row it inserted is ABSENT afterwards, and a sibling
// process writing `users` concurrently is noise this case cannot distinguish
// from a rollback that did not happen.
//
// Named `*.integration.test.ts` so vitest's serialized `integration` project
// runs it (R1).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertOnlyTablesMoved,
  readPublicCatalogue,
  withRolledBackTransaction,
  type CatalogueEntry,
  type CataloguedTable,
  type PublicCatalogue,
} from './migration-guard';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration-guard integration database was not initialized');
  return db;
}

/** EXACT-name lookup, never a substring — the contract `CatalogueEntry` exists for. */
function definitionOf(entries: readonly CatalogueEntry[], name: string): string | undefined {
  return entries.find((entry) => entry.name === name)?.definition;
}

function tableOf(catalogue: PublicCatalogue, name: string): CataloguedTable {
  const table = catalogue.tables[name];
  if (!table) {
    throw new Error(
      `readPublicCatalogue did not return ${name} — the test database is not at migrations head`,
    );
  }
  return table;
}

/** The grantee half of a `"<grantee>:<privilege>[:<column>]"` grant name. */
function granteeOf(entry: CatalogueEntry): string {
  return entry.name.split(':')[0] ?? '';
}

async function countUser(id: string): Promise<number> {
  const [row] = await sql()<{ total: string }[]>`
    SELECT count(*)::text AS total FROM users WHERE id = ${id}
  `;
  return Number(row?.total ?? '-1');
}

describeWithDb(
  'migration-guard rolled-back transaction',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('withRolledBackTransaction preserves callback errors and rolls back successful and failed callbacks', async () => {
      // `users` needs only id, name and email: `account_id` is nullable and
      // `role` defaults to `owner`.
      const committedLooking = randomUUID();
      let seenInsideTransaction: string | undefined;

      // ARM 1 — the callback RETURNS NORMALLY and the write is still undone.
      // The inner SELECT is the part that makes the outer count meaningful: it
      // proves the INSERT really reached PostgreSQL, so 0 afterwards is a
      // rollback rather than an INSERT that never ran.
      await withRolledBackTransaction(sql(), async (tx) => {
        await tx`
          INSERT INTO users (id, name, email)
          VALUES (${committedLooking}, 'migration guard rollback', ${`${committedLooking}@example.test`})
        `;
        const [row] = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${committedLooking}
        `;
        seenInsideTransaction = row?.id;
      });

      expect(seenInsideTransaction).toBe(committedLooking);
      expect(await countUser(committedLooking)).toBe(0);

      // ARM 2 — the callback THROWS. The wrapper must re-throw that exact error
      // object, unchanged, and still leave nothing behind. A wrapper that
      // swallowed it would turn every failing executing case in the six
      // migration-guard suites into a pass.
      const failing = randomUUID();
      const callbackError = new Error('migration-guard integration callback failure');

      await expect(
        withRolledBackTransaction(sql(), async (tx) => {
          await tx`
            INSERT INTO users (id, name, email)
            VALUES (${failing}, 'migration guard failure', ${`${failing}@example.test`})
          `;
          throw callbackError;
        }),
      ).rejects.toBe(callbackError);

      expect(await countUser(failing)).toBe(0);
    });

    // The reader is the most complex function in the module and the one every
    // migration-shape suite rests on. Nothing here executes DDL — reading the
    // catalogue is SELECT-only — so this file still needs no
    // `MIGRATION_SHAPE_FILES` entry.
    //
    // Every assertion below is on CONTENT. `toBeDefined()` would be worthless:
    // the failure this case exists to catch is the reader silently returning an
    // empty list for a dimension, which `toBeDefined()` happily passes.
    //
    // Three tables, chosen because between them they exercise all eleven
    // dimensions: `poller_heartbeats` (migration 118) carries a table comment,
    // a column comment, a `now()` default and a natural-key primary index;
    // `flagged_responses` (migration 051) carries a partial unique index with a
    // predicate, a plain index, three CHECKs and five foreign keys including an
    // `ON DELETE SET NULL`; and `users` is the policy carrier, because both
    // deny-all tables have ZERO policies and so can prove nothing about the
    // policy renderer.
    it('readPublicCatalogue reports every catalogue dimension for a known table', async () => {
      let read: PublicCatalogue | undefined;
      await withRolledBackTransaction(sql(), async (tx) => {
        read = await readPublicCatalogue(tx);
      });
      if (!read) throw new Error('readPublicCatalogue returned nothing');
      const catalogue = read;

      const heartbeats = tableOf(catalogue, 'poller_heartbeats');
      const flagged = tableOf(catalogue, 'flagged_responses');
      const users = tableOf(catalogue, 'users');

      // ── rowSecurity / forceRowSecurity ────────────────────────────────────
      // Both deny-all tables enable RLS without forcing it (FORCE binds the
      // owner too, and neither migration asks for that). A reader that dropped
      // either field yields `undefined`, which fails `toBe`.
      expect(heartbeats.rowSecurity).toBe(true);
      expect(heartbeats.forceRowSecurity).toBe(false);
      expect(flagged.rowSecurity).toBe(true);
      expect(flagged.forceRowSecurity).toBe(false);

      // ── policies ──────────────────────────────────────────────────────────
      // Name, command, permissive mode, target roles and BOTH expressions, in
      // one exact rendering.
      expect(definitionOf(users.policies, 'users_self_select')).toBe(
        'SELECT PERMISSIVE roles=authenticated using=((auth_id)::text = (auth.uid())::text) check=(none)',
      );
      // And the deny-all pair really is policy-free, so the empty list above is
      // the truth about them rather than the reader losing rows.
      expect(heartbeats.policies).toEqual([]);
      expect(flagged.policies).toEqual([]);

      // ── columns ───────────────────────────────────────────────────────────
      // Type, nullability, identity and generated-ness, all four in one string.
      expect(definitionOf(heartbeats.columns, 'poller_name')).toBe(
        'text NOT NULL identity=none generated=none',
      );
      expect(definitionOf(heartbeats.columns, 'last_cycle_at')).toBe(
        'timestamp with time zone NOT NULL identity=none generated=none',
      );
      // The NULL side of the rendering, from the one nullable FK column.
      expect(definitionOf(flagged.columns, 'api_cost_id')).toBe(
        'uuid NULL identity=none generated=none',
      );
      expect(heartbeats.columns.map((entry) => entry.name)).toEqual([
        'last_cycle_at',
        'poller_name',
      ]);

      // ── notNullColumns ────────────────────────────────────────────────────
      expect(heartbeats.notNullColumns).toEqual(['last_cycle_at', 'poller_name']);
      // A reader that returned EVERY column would pass the line above, since
      // both of `poller_heartbeats`' columns are NOT NULL. `api_cost_id` is the
      // nullable column that catches it.
      expect(flagged.notNullColumns).toContain('response_id');
      expect(flagged.notNullColumns).not.toContain('api_cost_id');

      // ── columnDefaults ────────────────────────────────────────────────────
      expect(definitionOf(heartbeats.columnDefaults, 'last_cycle_at')).toBe('now()');
      expect(heartbeats.columnDefaults.map((entry) => entry.name)).toEqual(['last_cycle_at']);
      expect(definitionOf(flagged.columnDefaults, 'status')).toBe("'open'::text");

      // ── columnComments ────────────────────────────────────────────────────
      expect(definitionOf(heartbeats.columnComments, 'last_cycle_at')).toMatch(
        /^Set to NOW\(\) after a cycle finishes WITHOUT throwing/,
      );
      // Distinct from the table comment: `flagged_responses` has a table
      // comment but no column comments, so a reader conflating the two shows up
      // here rather than passing.
      expect(flagged.columnComments).toEqual([]);

      // ── indexes ───────────────────────────────────────────────────────────
      expect(definitionOf(heartbeats.indexes, 'poller_heartbeats_pkey')).toBe(
        'CREATE UNIQUE INDEX poller_heartbeats_pkey ON public.poller_heartbeats USING btree (poller_name)',
      );
      // The predicate is the part a reader that reconstructed an index from
      // `pg_index` columns instead of calling `pg_get_indexdef` would lose.
      expect(definitionOf(flagged.indexes, 'idx_flagged_responses_open_response')).toBe(
        "CREATE UNIQUE INDEX idx_flagged_responses_open_response ON public.flagged_responses USING btree (response_id) WHERE (status = 'open'::text)",
      );
      expect(definitionOf(flagged.indexes, 'idx_flagged_responses_status_created')).toBe(
        'CREATE INDEX idx_flagged_responses_status_created ON public.flagged_responses USING btree (status, created_at DESC)',
      );
      expect(flagged.indexes.map((entry) => entry.name)).toEqual([
        'flagged_responses_pkey',
        'idx_flagged_responses_open_response',
        'idx_flagged_responses_status_created',
      ]);

      // ── constraints ───────────────────────────────────────────────────────
      expect(definitionOf(heartbeats.constraints, 'poller_heartbeats_pkey')).toBe(
        'PRIMARY KEY (poller_name)',
      );
      // The referential ACTION is the part that must survive: an FK rendered
      // without `ON DELETE SET NULL` is a different constraint.
      expect(definitionOf(flagged.constraints, 'flagged_responses_api_cost_id_fkey')).toBe(
        'FOREIGN KEY (api_cost_id) REFERENCES api_costs(id) ON DELETE SET NULL',
      );
      expect(definitionOf(flagged.constraints, 'flagged_responses_severity_check')).toBe(
        "CHECK ((severity = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))",
      );
      expect(
        flagged.constraints
          .filter((entry) => entry.definition.startsWith('FOREIGN KEY'))
          .map((entry) => entry.name),
      ).toEqual([
        'flagged_responses_account_id_fkey',
        'flagged_responses_api_cost_id_fkey',
        'flagged_responses_business_id_fkey',
        'flagged_responses_response_id_fkey',
        'flagged_responses_review_id_fkey',
        'flagged_responses_reviewed_by_user_id_fkey',
      ]);
      expect(
        flagged.constraints
          .filter((entry) => entry.definition.startsWith('CHECK'))
          .map((entry) => entry.name),
      ).toEqual([
        'flagged_responses_severity_check',
        'flagged_responses_source_check',
        'flagged_responses_status_check',
      ]);

      // ── comment ───────────────────────────────────────────────────────────
      expect(heartbeats.comment).toMatch(/^Durable background-loop liveness \(#949\)/);
      expect(flagged.comment).toMatch(/^High-confidence unsafe drafts held out of the owner/);

      // ── grants ────────────────────────────────────────────────────────────
      // Owner-name agnostic on purpose: the local container and CI both own the
      // schema as `test`, but the INVARIANT is "exactly one grantee, and it is
      // the owner", not the owner's name. `granteesOf(...).size === 1` is what
      // fails when the reader returns an empty grant list.
      const heartbeatGrantees = new Set(heartbeats.grants.map(granteeOf));
      expect(heartbeatGrantees.size).toBe(1);
      const owner = [...heartbeatGrantees][0] as string;
      const heartbeatGrantNames = heartbeats.grants.map((entry) => entry.name);
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        expect(heartbeatGrantNames).toContain(`${owner}:${privilege}`);
      }
      // The grantor half of the rendering, and no GRANT OPTION anywhere.
      expect(heartbeats.grants.map((entry) => entry.definition)).toEqual(
        heartbeats.grants.map(() => owner),
      );
      // Invariant #4's deny-all half: no client role holds ANY privilege on
      // either admin-only table, table-wide or per-column.
      for (const table of [heartbeats, flagged]) {
        for (const role of ['anon', 'authenticated', 'PUBLIC']) {
          expect(table.grants.filter((entry) => granteeOf(entry) === role)).toEqual([]);
        }
      }
      expect(new Set(flagged.grants.map(granteeOf))).toEqual(new Set([owner]));
    });

    it('assertOnlyTablesMoved reports an off-target row write once the table holds a row', async () => {
      // #1301 RT-3, proven live rather than on a fixture. The proving mutation
      // the red team ran — `UPDATE accounts SET display_name = …` appended to
      // migration 051 — survived 5 of 5 runs because the catalogue was pure
      // schema. `rowDigest` closes that, and this case proves it end to end.
      //
      // STATED LIMIT, and the reason this case seeds first: the local test
      // container holds ZERO rows in EVERY public table, measured. An `UPDATE`
      // or `DELETE` against an empty table changes nothing that any oracle can
      // read, because there is nothing to change. The emptiness is the limit,
      // not the catalogue. An off-target INSERT is caught without seeding —
      // appending one to 051 fails three of its five cases — and so is an
      // UPDATE or DELETE against a table a case seeded itself, which is what
      // this case establishes.
      await withRolledBackTransaction(sql(), async (tx) => {
        // `poller_heartbeats` is the seed target because it carries no foreign
        // key: seeding `accounts` would need a `users` row, and
        // `users.fk_users_account` is DEFERRABLE INITIALLY DEFERRED, whose
        // pending trigger events a never-committing transaction never settles.
        const pollerName = `rt-3-off-target-probe-${randomUUID()}`;
        await tx`INSERT INTO poller_heartbeats (poller_name) VALUES (${pollerName})`;

        const before = await readPublicCatalogue(tx);
        // Nothing moved yet: the same reading compares equal to itself, so a
        // failure below cannot be an artefact of the seeding.
        expect(() => assertOnlyTablesMoved(before, before, [])).not.toThrow();

        await tx`
          UPDATE poller_heartbeats
             SET last_cycle_at = last_cycle_at + interval '1 hour'
           WHERE poller_name = ${pollerName}
        `;
        const afterUpdate = await readPublicCatalogue(tx);

        // The row COUNT is identical on both sides, so a count alone would
        // pass here. The digest is what fails. That is the reason the fix is a
        // digest and not a count.
        expect(before.tables.poller_heartbeats?.rowDigest).toMatch(/ rows=1$/);
        expect(afterUpdate.tables.poller_heartbeats?.rowDigest).toMatch(/ rows=1$/);
        expect(afterUpdate.tables.poller_heartbeats?.rowDigest).not.toBe(
          before.tables.poller_heartbeats?.rowDigest,
        );

        expect(() => assertOnlyTablesMoved(before, afterUpdate, [])).toThrow(
          /poller_heartbeats \(rowDigest\)/,
        );
        // Naming the table in the allowed list is what a suite does for the
        // table its own migration owns, and that still passes.
        expect(() =>
          assertOnlyTablesMoved(before, afterUpdate, ['poller_heartbeats']),
        ).not.toThrow();

        await tx`DELETE FROM poller_heartbeats WHERE poller_name = ${pollerName}`;
        const afterDelete = await readPublicCatalogue(tx);
        expect(afterDelete.tables.poller_heartbeats?.rowDigest).toMatch(/ rows=0$/);
        expect(() => assertOnlyTablesMoved(before, afterDelete, [])).toThrow(
          /poller_heartbeats \(rowDigest\)/,
        );
      });
    });

    it('withRolledBackTransaction detects a callback that commits its own transaction', async () => {
      // #1301, the adversarial P1. `withRolledBackTransaction` rolls back by
      // throwing a sentinel AFTER the callback returns. A migration carrying
      // its own `BEGIN … COMMIT` ends the wrapper's transaction early, so
      // everything before that COMMIT is already durable when the sentinel
      // fires. Migration 119 carries its own BEGIN/COMMIT today, so this is
      // one migration away from being reached for real.
      //
      // The probe genuinely COMMITS, which is the only way to prove the
      // detector. It is safe to do here and nowhere else: this file holds the
      // shared advisory lock for its whole run, so no sibling suite is live;
      // the table name belongs to no migration; and the cleanup runs in a
      // `finally` with a defensive drop before the probe as well.
      const probeTable = 'migration_guard_commit_leak_probe';
      await sql().unsafe(`DROP TABLE IF EXISTS ${probeTable};`); // live-db-ddl-ignore: defensive pre-clean of this case's own probe table, which belongs to no migration

      try {
        await expect(
          withRolledBackTransaction(sql(), async (tx) => {
            await tx.unsafe(`COMMIT; CREATE TABLE ${probeTable} (id integer);`); // live-db-ddl-ignore: the leak being detected; cleaned up in the finally below
          }),
        ).rejects.toThrow(/did not leave the database untouched/);

        // And the leak really happened — otherwise the detector would be
        // reporting a condition that cannot occur, which is the vacuous pass
        // this whole branch exists to remove.
        const [leaked] = await sql()<{ present: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_class cls
              JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
             WHERE nsp.nspname = 'public' AND cls.relname = ${probeTable}
          ) AS present
        `;
        expect(leaked?.present).toBe(true);
      } finally {
        await sql().unsafe(`DROP TABLE IF EXISTS ${probeTable};`); // live-db-ddl-ignore: mandatory cleanup of this case's own probe table
      }

      // The container is back where it started, verified rather than assumed.
      const [remaining] = await sql()<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_class cls
            JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
           WHERE nsp.nspname = 'public' AND cls.relname = ${probeTable}
        ) AS present
      `;
      expect(remaining?.present).toBe(false);
    });

    it('readPublicCatalogue sees a view and the schema default ACLs', async () => {
      // #1301 RT-5 and RT-4 at the reader, below the assertions. A view over a
      // deny-all table with `GRANT SELECT TO anon` is the access path migration
      // 049 exists to close, and the catalogue read `relkind in ('r','p')`
      // only, so it saw nothing. `pg_default_acl` was never read at all.
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        expect(before.tables.analytics_events_rt5_probe).toBeUndefined();

        // Each pragma sits on the line its own DDL verb is on, which is what
        // `live-db-suites-audit` matches. The probe view carries a name no
        // other suite uses, `CREATE VIEW` takes only ACCESS SHARE on
        // `analytics_events`, `ALTER DEFAULT PRIVILEGES` locks no relation at
        // all, this file holds the shared advisory lock throughout, and the
        // transaction always rolls back — so none of the three can be the
        // ACCESS EXCLUSIVE deadlock the audit exists to prevent.
        const probeView =
          'CREATE VIEW analytics_events_rt5_probe AS SELECT * FROM analytics_events;';
        const probeGrant = 'GRANT SELECT ON analytics_events_rt5_probe TO anon;';
        const probeDefaultAcl =
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;';
        await tx.unsafe(probeView); // live-db-ddl-ignore: new relation, name used by no other suite, ACCESS SHARE only on analytics_events, rolled back under the shared lock
        await tx.unsafe(probeGrant); // live-db-ddl-ignore: grants on the probe view this case just created, never on a shared relation
        await tx.unsafe(probeDefaultAcl); // live-db-ddl-ignore: schema-level default ACL, locks no relation, rolled back under the shared lock
        const after = await readPublicCatalogue(tx);

        const probe = after.tables.analytics_events_rt5_probe;
        expect(probe?.kind).toBe('v');
        // A view stores no rows of its own, so it is not digested.
        expect(probe?.rowDigest).toBe('(none)');
        // The leak itself: `anon` can SELECT through the view while the
        // underlying table grants it nothing.
        expect(probe?.grants.map((grant) => grant.name)).toContain('anon:SELECT');
        expect(
          after.tables.analytics_events?.grants.filter((grant) => granteeOf(grant) === 'anon'),
        ).toEqual([]);

        // And the schema default ACL, which no per-table property can carry.
        expect(before.schemaDefaultAcls).toEqual([]);
        expect(after.schemaDefaultAcls.map((acl) => acl.name)).toContain('public:r:anon:SELECT');
      });
    });
  },
);
