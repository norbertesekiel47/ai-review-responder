import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  assertSchemaReady,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  recordSuppression,
  suppressionMatchSql,
  type RecordSuppressionInput,
} from '../suppression';

// Live-DB suite for the Suppression ledger's domain core (#643; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §1.2/§2.1
// /§3.1/§9.4). It is `recordSuppression`'s only consumer today (G6): the writer
// ships ahead of #644/#645/#627 precisely so its byte-for-byte ON CONFLICT
// predicates are proven against the real partial unique indexes the moment
// those indexes exist, not three tickets later.
//
// Three things can only be proven here, never by a type:
//
//  1. ON CONFLICT INFERENCE. A predicate that is not byte-for-byte identical to
//     the index does not fail to compile — it throws "no unique or exclusion
//     constraint matching the ON CONFLICT specification" at runtime, turning a
//     first-write-wins no-op into a hard error on the second opt-out.
//  2. THE DB CHECKs. A reversed or two-directional constraint is present and
//     wrong. The two rejection tests below therefore deliberately push an
//     illegal input past the type system, because the DB is the last line of
//     defence for a caller that lost it.
//  3. GLOBAL WINS (G3). Reporting the account row would let an owner clear it
//     under §7.6, watch the contact stay suppressed, and have no idea why.
//
// No migration SQL is applied (#573): `pnpm test:db:setup` provisions to head
// and this suite ASSERTS with assertSchemaReady. Every write runs inside a
// transaction that is ALWAYS rolled back — a Suppression ledger row has no
// expiry and no ordinary delete path, so a leaked one is a permanent record.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('suppression integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('suppression integration tenant was not seeded');
  return tenant.accountId;
}

function otherAccountId(): string {
  if (!otherTenant) throw new Error('suppression integration second tenant was not seeded');
  return otherTenant.accountId;
}

/** A fresh Normalized handle per test, so no two tests contend on one key. */
function freshHandle(): string {
  return `suppressed-${randomUUID()}@test.local`;
}

/**
 * Runs the body inside a transaction that is ALWAYS rolled back and returns its
 * result. Never swallows an error — rejection is not the subject of the tests
 * that use it, so a constraint violation must surface as itself rather than as
 * a false negative.
 */
async function inRolledBackTx<T>(
  run: (tx: postgresType.TransactionSql) => Promise<T>,
): Promise<T> {
  let result!: T;
  try {
    await sql().begin(async (tx) => {
      result = await run(tx);
      throw new RollbackProbe();
    });
  } catch (error) {
    if ((error as { name?: string })?.name !== 'RollbackProbe') throw error;
  }
  return result;
}

interface RejectedWrite {
  code?: string;
  constraint?: string;
}

/**
 * Runs one write attempt in an always-rolled-back transaction and reports the
 * Postgres rejection. Fails loudly if the database ACCEPTED the write, so a
 * dropped or reversed CHECK cannot read as a pass.
 */
async function expectRejectedWrite(
  run: (tx: postgresType.TransactionSql) => Promise<unknown>,
): Promise<RejectedWrite> {
  let rejection: RejectedWrite | undefined;
  try {
    await sql().begin(async (tx) => {
      try {
        await run(tx);
      } catch (error) {
        const pgError = error as { code?: string; constraint_name?: string };
        rejection = { code: pgError.code, constraint: pgError.constraint_name };
      }
      throw new RollbackProbe();
    });
  } catch (error) {
    if ((error as { name?: string })?.name !== 'RollbackProbe') throw error;
  }
  expect(rejection, 'the database accepted a write the CHECK must reject').toBeDefined();
  return rejection!;
}

/**
 * Composes `suppressionMatchSql` exactly as the batch build will (§4.2 populate
 * seam): a LEFT JOIN LATERAL against an outer row carrying the already-
 * normalized handle. Testing the fragment through its real composition shape is
 * the point — a fragment that only works standalone is a fragment T4 cannot
 * use.
 *
 * `scope` is projected alongside `source` because §7.4's display seam reads it
 * off this fragment (#645). The display mapper's own tests hand-build their
 * input, so only a probe through the real SQL can prove the fragment projects
 * the scope of the row its ORDER BY actually picked.
 */
async function matchSuppression(
  tx: postgresType.TransactionSql,
  handle: string,
  forAccountId: string,
): Promise<{ scope: string | null; source: string | null; suppressed_at: Date | null }> {
  const rows = await tx<
    { scope: string | null; source: string | null; suppressed_at: Date | null }[]
  >`
    SELECT hit.scope, hit.source, hit.suppressed_at
    FROM (SELECT ${handle}::text AS handle) AS probe
    LEFT JOIN LATERAL (
      ${suppressionMatchSql(tx, tx`probe.handle`, forAccountId, 'email')}
    ) AS hit ON TRUE
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function countRows(
  tx: postgresType.TransactionSql,
  handle: string,
): Promise<number> {
  const [row] = await tx<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM solicitation_suppressions
    WHERE normalized_handle = ${handle}
  `;
  return Number(row!.count);
}

async function analyticsEventCount(
  tx: postgresType.TransactionSql,
  suppressionId: string,
): Promise<number> {
  const [row] = await tx<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM analytics_events
    WHERE event_name = 'solicitation_suppressed'
      AND event_key = ${`solicitation_suppressed_${suppressionId}`}
  `;
  return Number(row!.count);
}

describeWithDb(
  'Suppression ledger domain core (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      // Serialises against the sibling solicitation live-DB suites, which write
      // the same `solicitation_*` tables from other vitest processes.
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_096_SOLICITATION_SUPPRESSIONS]);
      tenant = await seedTenantAccount(db, { accountDisplayName: 'Suppression Core Fixture' });
      otherTenant = await seedTenantAccount(db, {
        accountDisplayName: 'Suppression Core Neighbour',
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          // `solicitation_suppressions.account_id` is a NO-ACTION FK to
          // `accounts`, and `cleanupTenantAccount` deletes accounts directly —
          // so ledger rows MUST go first or teardown throws and strands the
          // fixture. Every test rolls back, so this should sweep nothing; it is
          // here because the cost of being wrong is a wedged test DB.
          for (const seed of [tenant, otherTenant]) {
            if (!seed) continue;
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${seed.accountId}::uuid`;
            await db`DELETE FROM analytics_events WHERE account_id = ${seed.accountId}::uuid`;
            await cleanupTenantAccount(db, { accountId: seed.accountId, userId: seed.userId });
          }
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── first write wins, per partial unique index ───────────────────────────

    it('ON CONFLICT infers the global partial unique index and a second write is a no-op', async () => {
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        const first = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'unsubscribe_one_click',
        });
        const second = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: null,
          source: 'bounce_permanent',
        });
        return { first, second, rows: await countRows(tx, handle) };
      });

      expect(outcome.first).not.toBeNull();
      // A throw here would mean the predicate is not byte-for-byte identical to
      // `solicitation_suppressions_global_uniq`; a non-null id would mean the
      // ledger now holds two rows for one recipient.
      expect(outcome.second).toBeNull();
      expect(outcome.rows).toBe(1);
    });

    it('ON CONFLICT infers the account partial unique index scoped to account_id', async () => {
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        const first = await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        const repeat = await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        // The index is keyed on account_id, so the SAME handle is writable
        // again by a different owner — one owner's do-not-contact must never
        // consume another owner's key.
        const neighbour = await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: otherAccountId(),
          source: 'owner_manual',
          createdByUserId: otherTenant!.userId,
        });
        return { first, repeat, neighbour, rows: await countRows(tx, handle) };
      });

      expect(outcome.first).not.toBeNull();
      expect(outcome.repeat).toBeNull();
      expect(outcome.neighbour).not.toBeNull();
      expect(outcome.rows).toBe(2);
    });

    it('a global row and an account row for the same handle coexist', async () => {
      // Two DIFFERENT partial indexes, so the recipient's own opt-out and the
      // owner's do-not-contact are independent records of independent facts.
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        const global = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'complaint',
        });
        const account = await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        return { global, account, rows: await countRows(tx, handle) };
      });

      expect(outcome.global).not.toBeNull();
      expect(outcome.account).not.toBeNull();
      expect(outcome.rows).toBe(2);
    });

    it('first write wins: a later complaint does not overwrite an earlier unsubscribe row', async () => {
      // The surviving row's SOURCE is the assertion. A row count of 1 is also
      // true of a writer that overwrote in place, which would silently rewrite
      // history the provider webhook records already own (§2.1).
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'unsubscribe_link',
        });
        const later = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: null,
          source: 'complaint',
        });
        const [row] = await tx<{ source: string; account_id: string | null }[]>`
          SELECT source, account_id FROM solicitation_suppressions
          WHERE normalized_handle = ${handle}
        `;
        return { later, row: row!, rows: await countRows(tx, handle) };
      });

      expect(outcome.later).toBeNull();
      expect(outcome.rows).toBe(1);
      expect(outcome.row.source).toBe('unsubscribe_link');
      // The loser's provenance did not leak into the winner either.
      expect(outcome.row.account_id).toBe(accountId());
    });

    // ── §9.4 analytics, same transaction ─────────────────────────────────────

    it('recordSuppression writes the solicitation_suppressed analytics row in the same transaction', async () => {
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        const id = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'provider_suppressed',
        });
        // Read INSIDE the same transaction: an event enqueued anywhere else
        // could be lost if the ledger write rolled back.
        const [event] = await tx<
          { account_id: string | null; distinct_id: string; properties: unknown }[]
        >`
          SELECT account_id, distinct_id, properties
          FROM analytics_events
          WHERE event_key = ${`solicitation_suppressed_${id}`}
        `;
        return { id, event };
      });

      expect(outcome.id).not.toBeNull();
      expect(outcome.event).toBeDefined();
      expect(outcome.event!.account_id).toBe(accountId());
      expect(outcome.event!.distinct_id).toBe(accountId());
      const properties = outcome.event!.properties;
      const parsed = (
        typeof properties === 'string' ? JSON.parse(properties) : properties
      ) as Record<string, unknown>;
      expect(parsed).toEqual({
        source: 'provider_suppressed',
        scope: 'global',
        channel: 'email',
      });
      // §9.4/§9.5: the Normalized handle is never a property. Asserting the
      // whole object above already pins this; spelled out because it is the
      // rule most likely to be relaxed by a well-meaning later edit.
      expect(JSON.stringify(parsed)).not.toContain(handle);
    });

    it('a repeat recordSuppression mints no duplicate analytics event', async () => {
      const handle = freshHandle();
      const outcome = await inRolledBackTx(async (tx) => {
        const id = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'unsubscribe_link',
        });
        const repeat = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'complaint',
        });
        const [total] = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM analytics_events
          WHERE event_name = 'solicitation_suppressed'
            AND account_id = ${accountId()}::uuid
        `;
        return {
          repeat,
          forFirst: await analyticsEventCount(tx, id!),
          totalForAccount: Number(total!.count),
        };
      });

      expect(outcome.repeat).toBeNull();
      expect(outcome.forFirst).toBe(1);
      // The no-op path skips the enqueue entirely, so the second call mints
      // nothing at all — not a second row deduped by event_key.
      expect(outcome.totalForAccount).toBe(1);
    });

    // ── the DB CHECKs (the last line of defence) ─────────────────────────────

    it("the CHECK pairing rejects scope='account' with a NULL account_id", async () => {
      // The union type makes this unrepresentable, so the cast is the point:
      // it models a caller that lost the type (a JS boundary, a later refactor,
      // a hand-written INSERT) and proves the database still refuses.
      const illegal = {
        scope: 'account',
        channel: 'email',
        normalizedHandle: freshHandle(),
        accountId: null,
        source: 'owner_manual',
        createdByUserId: tenant!.userId,
      } as unknown as RecordSuppressionInput;

      const rejection = await expectRejectedWrite((tx) => recordSuppression(tx, illegal));

      expect(rejection.code).toBe('23514');
      expect(rejection.constraint).toBe('solicitation_suppressions_account_scope_pairing');
    });

    it('the source-scope CHECK rejects owner_manual at global scope', async () => {
      // Without this pairing, one owner's do-not-contact inserts cleanly as a
      // global row and silently degrades EVERY other tenant's reach with no
      // recipient having spoken (G11).
      const illegal = {
        scope: 'global',
        channel: 'email',
        normalizedHandle: freshHandle(),
        accountId: accountId(),
        source: 'owner_manual',
        createdByUserId: tenant!.userId,
      } as unknown as RecordSuppressionInput;

      const rejection = await expectRejectedWrite((tx) => recordSuppression(tx, illegal));

      expect(rejection.code).toBe('23514');
      expect(rejection.constraint).toBe('solicitation_suppressions_source_scope_pairing');
    });

    it('a global row may carry account_id as provenance', async () => {
      // The pairing CHECK is ONE-DIRECTIONAL. A reversed or two-directional
      // constraint would reject this, and every machine-authored row would
      // lose the provenance §6.3 retains through the offboarding purge — a
      // failure no type-level assertion can see.
      const handle = freshHandle();
      const row = await inRolledBackTx(async (tx) => {
        const id = await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'bounce_permanent',
        });
        const [written] = await tx<{ scope: string; account_id: string | null }[]>`
          SELECT scope, account_id FROM solicitation_suppressions WHERE id = ${id}::uuid
        `;
        return written!;
      });

      expect(row.scope).toBe('global');
      expect(row.account_id).toBe(accountId());
    });

    // ── §1.2 lookup contract, through suppressionMatchSql ────────────────────

    it('suppressionMatchSql returns the global row when both a global and an account row match', async () => {
      // G3 — global wins. The account row is aged BACKWARDS a day first, so a
      // fragment that ordered by suppressed_at alone would return it: the test
      // fails unless scope precedence is doing the work.
      const handle = freshHandle();
      const hit = await inRolledBackTx(async (tx) => {
        const ownerRowId = await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        await tx`
          UPDATE solicitation_suppressions
          SET suppressed_at = NOW() - INTERVAL '1 day'
          WHERE id = ${ownerRowId}::uuid
        `;
        await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: null,
          source: 'complaint',
        });
        return matchSuppression(tx, handle, accountId());
      });

      expect(hit.source).toBe('complaint');
    });

    it('suppressionMatchSql ignores an account row belonging to a different account', async () => {
      // An account row is the OWNER's do-not-contact — no recipient spoke — so
      // it must not reach across the tenant boundary. If it did, Owner A could
      // silently degrade Owner B's reach.
      const handle = freshHandle();
      const results = await inRolledBackTx(async (tx) => {
        await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: otherAccountId(),
          source: 'owner_manual',
          createdByUserId: otherTenant!.userId,
        });
        return {
          forThisAccount: await matchSuppression(tx, handle, accountId()),
          forOwningAccount: await matchSuppression(tx, handle, otherAccountId()),
        };
      });

      expect(results.forThisAccount.source).toBeNull();
      // Same fragment, same handle, the owning account: the row IS found, so
      // the miss above is scoping and not a broken predicate.
      expect(results.forOwningAccount.source).toBe('owner_manual');
    });

    // ── §7.4 projection: the scope column the display seam reads ─────────────
    //
    // The display mapper's unit tests hand-build their input, so the fragment
    // could project the WRONG scope and every one of them would still pass.
    // These two probe the real SQL, which is the only place that gap closes.

    it('global wins the display state when both a global and an account row match', async () => {
      // The G3 contract, proven where a real double match exists: two rows on
      // one Normalized handle, and the scope the §7.4 display seam reads comes
      // back `global`. The mapper's unit suite cannot hold this title — it
      // never sees two rows — so it lives here, on the PROJECTION rather than
      // just the ordering: the previous test reads `source`, and a fragment
      // that returned the global row's source beside the account row's scope
      // would satisfy it while telling the owner their own reversible row is
      // what suppressed the contact (§7.6).
      const handle = freshHandle();
      const hit = await inRolledBackTx(async (tx) => {
        await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        await recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: null,
          source: 'complaint',
        });
        return matchSuppression(tx, handle, accountId());
      });

      expect(hit.scope).toBe('global');
      // Both columns come from ONE row — asserting them together is what makes
      // a mismatched pairing visible.
      expect(hit.source).toBe('complaint');
    });

    it('suppressionMatchSql projects account scope only for the matching account', async () => {
      // The account row is the only one that maps to a clearable display state,
      // so a scope that leaked across the tenant boundary would offer Owner B a
      // "clear this" control over a row Owner A wrote.
      const handle = freshHandle();
      const results = await inRolledBackTx(async (tx) => {
        await recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        });
        return {
          forOwningAccount: await matchSuppression(tx, handle, accountId()),
          forNeighbour: await matchSuppression(tx, handle, otherAccountId()),
        };
      });

      expect(results.forOwningAccount.scope).toBe('account');
      expect(results.forOwningAccount.source).toBe('owner_manual');
      expect(results.forNeighbour.scope).toBeNull();
      expect(results.forNeighbour.source).toBeNull();
    });
  },
);
