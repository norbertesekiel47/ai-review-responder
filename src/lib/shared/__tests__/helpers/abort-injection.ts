// Non-DDL transaction-abort injection for live-DB suites.
//
// Forcing a writer's transaction to abort used to be done by adding a temporary
// CHECK constraint and dropping it in a `finally`. A vitest TIMEOUT skips the
// `finally`, so the constraint strands on the shared container — one such
// stranded `tmp_block_import_topic_analytics` blocked every sibling suite that
// enqueues `zernio_initial_backfill` and produced 14 spurious failures across
// three suites (#679 deviations D20, ticket #694). It also took ACCESS EXCLUSIVE
// on the most contended relation in the live-DB set, against suites in other
// vitest processes that nothing serializes it against.
//
// This injection holds no schema, takes no ACCESS EXCLUSIVE lock, and leaves
// nothing behind whether its test passes, fails, or times out.
//
// THE FAILURE MUST ORIGINATE IN POSTGRES, not in JS. A plain JS throw does not
// poison a Postgres transaction, so a test built on one proves nothing about a
// transaction that is actually in aborted state — the state the real hazard
// produces. Callers supply a `poison` that raises a REAL Postgres error.
//
// WHY ITS OWN FILE. The alternatives are `helpers/schema-ready.ts`, which owns
// the assert-never-apply contract, and `live-db-tenant.ts`, which owns tenant
// seeding. Transaction-abort injection is a third concern; adding it to either
// widens a focused module's interface for an unrelated reason. This directory
// already holds one concern per file (`live-db-lock`, `schema-ready`,
// `outreach-fixture`), so a further file follows the established pattern.
//
// The MECHANISM lives here; the POISON does not. A deterministic SQLSTATE
// depends on which constraints the caller's own fixture satisfies, so each
// caller owns the statement that raises.
//
// Test-helper only — never imported by production code.
import type postgresType from 'postgres';

/**
 * Wraps `base` so that `.begin(cb)` runs `cb` to completion and THEN runs
 * `poison` on the same transaction, aborting it after the writer's work.
 *
 * A `Proxy` over a REAL `Sql`, never a `{ begin } as unknown as Sql` cast: a
 * bare object cast would typecheck the caller against a local restatement of
 * the interface instead of the shipped one (#679 deviations D22). A `get`-only
 * trap does not intercept `apply`, so the tagged-template call form forwards
 * untouched.
 */
export function abortingExecutor(
  base: postgresType.Sql,
  poison: (tx: postgresType.TransactionSql) => Promise<unknown>,
): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        return target.begin(async (tx) => {
          const result = await callback(tx);
          await poison(tx);
          return result;
        });
      };
    },
  });
}
