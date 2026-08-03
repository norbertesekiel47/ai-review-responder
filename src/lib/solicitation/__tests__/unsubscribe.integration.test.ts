import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fc from 'fast-check';
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
import { recordSuppression } from '../suppression';
import {
  findRedeemableUnsubscribeToken,
  hashUnsubscribeToken,
  mintUnsubscribeRawToken,
  redeemUnsubscribeToken,
  type UnsubscribeRedemption,
  type UnsubscribeRedemptionSource,
} from '../unsubscribe';

// Live-DB suite for Unsubscribe redemption (#644 T1b; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §5.2/§5.4,
// plan §1.3). Four things can only be proven against a real database:
//
//  1. CLAIM-FIRST ORDERING. The `redeemed_at` claim is the only write-ordering
//     primitive. Suppressing first would let a replayed spent link silently undo
//     an audited Correction path removal, and would let a concurrent purge
//     produce a ledger row carrying stale non-null provenance.
//  2. READ COMMITTED RE-SNAPSHOTTING. A token minted after the claim's snapshot
//     is visible to the follow-up read, unredeemed. Branching on `redeemed_at`
//     rather than on bare existence is what turns that into a retryable
//     `unknown_token` instead of a success-shaped no-op with no suppression.
//  3. THE ROW LOCK. Two overlapping redemptions must serialise on the token row,
//     not race into two ledger rows or two `redeemed_at` stamps.
//  4. GLOBAL-ONLY LEDGER SCOPE. An `account`-scoped row satisfies the send-time
//     gate (`suppressionMatchSql`) while making the §5.5 success sentence false.
//
// Three tests therefore run GENUINELY CONCURRENT transactions on separate
// connections — a sequential test passes while the race is broken.
//
// No migration SQL is applied (#573): `pnpm test:db:setup` provisions to head
// and this suite ASSERTS with assertSchemaReady. Fixtures COMMIT (the races
// require it) and are swept per test by Normalized handle, so parallel writers
// never collide on a key and no ledger row is left behind.

// unsubscribe.ts signs every token with SESSION_COOKIE_SECRET, read lazily
// through the memoized getServerConfig(). Set before any call so the suite does
// not depend on the developer's .env.local carrying one.
process.env.SESSION_COOKIE_SECRET =
  process.env.SESSION_COOKIE_SECRET ?? 'repworth-unsubscribe-integration-secret-32b';

const testDatabaseUrl = resolveTestDatabaseUrl();

const OWNING_BUSINESS_ID = randomUUID();
const OWNING_BUSINESS_NAME = 'Unsubscribe Fixture Diner';
const FOREIGN_BUSINESS_ID = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;

/** Handles written this test, swept in afterEach so no two tests share a key. */
const handlesInPlay = new Set<string>();

function sql(): postgresType.Sql {
  if (!db) throw new Error('unsubscribe integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('unsubscribe integration tenant was not seeded');
  return tenant.accountId;
}

function freshHandle(): string {
  const handle = `unsubscribed-${randomUUID()}@test.local`;
  handlesInPlay.add(handle);
  return handle;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface SeededToken {
  rawToken: string;
  tokenHash: string;
  handle: string;
}

interface SeedTokenOptions {
  handle?: string;
  /** Reuse a token minted earlier — for the mint-race, which mints before seeding. */
  rawToken?: string;
  /** Defaults to the fixture tenant; `null` models a purge-scrubbed row. */
  accountId?: string | null;
  /** Defaults to the fixture tenant's business. */
  businessId?: string | null;
}

async function seedToken(options: SeedTokenOptions = {}): Promise<SeededToken> {
  const rawToken = options.rawToken ?? mintUnsubscribeRawToken();
  const tokenHash = hashUnsubscribeToken(rawToken);
  const handle = options.handle ?? freshHandle();
  const tokenAccountId = options.accountId === undefined ? accountId() : options.accountId;
  // The provenance-scrub CHECK is one-way: a NULL account_id forces the rest NULL.
  const tokenBusinessId =
    tokenAccountId === null
      ? null
      : (options.businessId === undefined ? OWNING_BUSINESS_ID : options.businessId);

  await sql()`
    INSERT INTO solicitation_unsubscribe_tokens
      (id, token_hash, normalized_handle, channel, account_id, business_id, sent_at)
    VALUES (
      ${randomUUID()}::uuid, ${tokenHash}, ${handle}, 'email',
      ${tokenAccountId}::uuid, ${tokenBusinessId}::uuid, NOW()
    )
  `;
  return { rawToken, tokenHash, handle };
}

function redeem(
  rawToken: string,
  source: UnsubscribeRedemptionSource,
): Promise<UnsubscribeRedemption> {
  return sql().begin((tx) => redeemUnsubscribeToken(tx, { rawToken, source }));
}

async function countGlobalRows(handle: string): Promise<number> {
  const [row] = await sql()<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM solicitation_suppressions
    WHERE normalized_handle = ${handle} AND scope = 'global'
  `;
  return Number(row!.count);
}

async function globalSuppressionRow(
  handle: string,
): Promise<{ source: string; account_id: string | null; scope: string }> {
  const [row] = await sql()<{ source: string; account_id: string | null; scope: string }[]>`
    SELECT source, account_id, scope FROM solicitation_suppressions
    WHERE normalized_handle = ${handle} AND scope = 'global'
  `;
  expect(row, 'expected exactly one global suppression row').toBeDefined();
  return row!;
}

/**
 * `::text` deliberately: postgres.js truncates timestamptz MICROSECONDS on the
 * way into a JS Date, so a Date round-trip could report two distinct stamps as
 * equal — the exact thing the "leaves redeemed_at at the first redemption"
 * assertions exist to detect.
 */
async function tokenRedeemedAt(tokenHash: string): Promise<string | null> {
  const [row] = await sql()<{ redeemed_at: string | null }[]>`
    SELECT redeemed_at::text AS redeemed_at FROM solicitation_unsubscribe_tokens
    WHERE token_hash = ${tokenHash}
  `;
  expect(row, 'expected the token row to still exist').toBeDefined();
  return row!.redeemed_at;
}

/** The audited Correction path (§8.2), reduced to its effect on the ledger. */
async function removeGlobalSuppressionByCorrection(handle: string): Promise<void> {
  await sql()`
    DELETE FROM solicitation_suppressions
    WHERE normalized_handle = ${handle} AND scope = 'global'
  `;
}

/**
 * Resolves once some backend is BLOCKED on a lock while touching the token
 * table. That is the contention these tests exist to observe: the second writer
 * must be genuinely parked behind the first's row lock, not merely slower.
 */
async function waitForTokenRowLockWaiter(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [waiting] = await sql()<{ waiters: number }[]>`
      SELECT COUNT(*)::int AS waiters
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%solicitation_unsubscribe_tokens%'
    `;
    if ((waiting?.waiters ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('no backend ever blocked on the unsubscribe token row lock');
    }
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/**
 * Wraps a transaction executor so `commitConcurrently` runs — on a DIFFERENT
 * connection, as a real committed transaction — immediately after the subject's
 * FIRST statement resolves. The subject's first statement is the claim UPDATE,
 * so the follow-up read then takes its own Read Committed snapshot with the
 * concurrent write already visible.
 *
 * The interleaving is choreographed rather than raced because wall-clock timing
 * cannot hit this window reliably; the concurrency itself is real, and so is the
 * snapshot boundary being tested.
 */
function commitBetweenStatements(
  tx: postgresType.TransactionSql,
  commitConcurrently: () => Promise<void>,
): postgresType.TransactionSql {
  let statements = 0;
  const handler: ProxyHandler<postgresType.TransactionSql> = {
    apply(target, thisArg, argArray) {
      const query = Reflect.apply(
        target as unknown as (...args: unknown[]) => Promise<unknown>,
        thisArg,
        argArray,
      );
      statements += 1;
      if (statements !== 1) return query;
      return (async () => {
        const rows = await query;
        await commitConcurrently();
        return rows;
      })();
    },
  };
  return new Proxy(tx, handler);
}

describeWithDb(
  'Unsubscribe redemption (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      // Serialises against the sibling solicitation live-DB suites, and keeps
      // pg_stat_activity readable for the two lock-contention tests.
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      // Six connections: a parked writer, the blocked redemption, the
      // pg_stat_activity probe, and the fixture/assertion queries.
      db = postgres(databaseUrl, { max: 6, prepare: false });
      await assertSchemaReady(db, [MIGRATION_096_SOLICITATION_SUPPRESSIONS]);
      tenant = await seedTenantAccount(db, { accountDisplayName: 'Unsubscribe Fixture' });
      otherTenant = await seedTenantAccount(db, {
        accountDisplayName: 'Unsubscribe Fixture Neighbour',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${OWNING_BUSINESS_ID}::uuid, ${OWNING_BUSINESS_NAME}, 'Fixture Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'restaurant'
        ), (
          ${FOREIGN_BUSINESS_ID}::uuid, 'Unsubscribe Neighbour Cafe', 'Neighbour Owner',
          ${otherTenant.ownerEmail}, ${otherTenant.accountId}::uuid, 'active', 'restaurant'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db || handlesInPlay.size === 0) return;
      const handles = [...handlesInPlay];
      handlesInPlay.clear();
      // Ledger rows first, and their analytics events by the id just deleted —
      // sweeping analytics by account would miss the purge-scrubbed rows, whose
      // account_id is NULL by construction.
      const removed = await db<{ id: string }[]>`
        DELETE FROM solicitation_suppressions
        WHERE normalized_handle IN ${db(handles)}
        RETURNING id
      `;
      if (removed.length > 0) {
        await db`
          DELETE FROM analytics_events
          WHERE event_key IN ${db(removed.map((row) => `solicitation_suppressed_${row.id}`))}
        `;
      }
      await db`
        DELETE FROM solicitation_unsubscribe_tokens WHERE normalized_handle IN ${db(handles)}
      `;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          // `solicitation_suppressions.account_id` is a NO-ACTION FK to
          // `accounts`, so any stray ledger row would wedge teardown. afterEach
          // should have swept everything; this is the cost-of-being-wrong net.
          for (const seed of [tenant, otherTenant]) {
            if (!seed) continue;
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${seed.accountId}::uuid`;
            await db`DELETE FROM analytics_events WHERE account_id = ${seed.accountId}::uuid`;
          }
          await db`
            DELETE FROM businesses
            WHERE id IN (${OWNING_BUSINESS_ID}::uuid, ${FOREIGN_BUSINESS_ID}::uuid)
          `;
          for (const seed of [tenant, otherTenant]) {
            if (!seed) continue;
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

    // ── the ordinary redemption, both surfaces ───────────────────────────────

    it('redeeming at the ingress writes a global suppression row with source unsubscribe_one_click', async () => {
      const seeded = await seedToken();

      const outcome = await redeem(seeded.rawToken, 'unsubscribe_one_click');

      expect(outcome.status).toBe('redeemed');
      expect(outcome.tokenHashPrefix).toBe(seeded.tokenHash.slice(0, 12));
      const row = await globalSuppressionRow(seeded.handle);
      expect(row.scope).toBe('global');
      expect(row.source).toBe('unsubscribe_one_click');
      // Provenance is retained on a live account (§6.3); only the purge nulls it.
      expect(row.account_id).toBe(accountId());
      expect(await tokenRedeemedAt(seeded.tokenHash)).not.toBeNull();
    });

    it('redeeming through the landing page writes source unsubscribe_link', async () => {
      const seeded = await seedToken();

      const outcome = await redeem(seeded.rawToken, 'unsubscribe_link');

      expect(outcome.status).toBe('redeemed');
      // The two surfaces differ ONLY in the recorded source — same token, same
      // ledger row shape, same global scope.
      expect((await globalSuppressionRow(seeded.handle)).source).toBe('unsubscribe_link');
    });

    it('a second redemption is a no-op success and leaves redeemed_at at the first redemption', async () => {
      const seeded = await seedToken();
      await redeem(seeded.rawToken, 'unsubscribe_one_click');
      const firstStamp = await tokenRedeemedAt(seeded.tokenHash);

      const replay = await redeem(seeded.rawToken, 'unsubscribe_one_click');

      expect(replay.status).toBe('already_suppressed');
      // A re-stamp would be a silent rewrite of when the recipient actually
      // opted out — the one timestamp a compliance record must not drift.
      expect(await tokenRedeemedAt(seeded.tokenHash)).toBe(firstStamp);
      expect(await countGlobalRows(seeded.handle)).toBe(1);
    });

    it('an existing complaint row wins first-write-wins and redemption still reports success', async () => {
      const handle = freshHandle();
      await sql().begin((tx) =>
        recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'complaint',
        }),
      );
      const seeded = await seedToken({ handle });

      const outcome = await redeem(seeded.rawToken, 'unsubscribe_link');

      expect(outcome.status).toBe('redeemed');
      // The earlier row is the surviving record of the fact (§2.1); redemption
      // adds nothing and must not report a failure for that.
      expect(await countGlobalRows(handle)).toBe(1);
      expect((await globalSuppressionRow(handle)).source).toBe('complaint');
    });

    it('a token whose account was purged still writes a ledger row with account_id NULL', async () => {
      // The recipient's revocation is global and stands on its own — it must not
      // depend on the sender still existing (§5.2).
      const seeded = await seedToken({ accountId: null });

      const outcome = await redeem(seeded.rawToken, 'unsubscribe_one_click');

      expect(outcome.status).toBe('redeemed');
      expect((await globalSuppressionRow(seeded.handle)).account_id).toBeNull();
    });

    it('an unknown token hash reports not found without writing', async () => {
      // Well formed and unforged, but never minted into the table.
      const rawToken = mintUnsubscribeRawToken();
      const before = await sql()<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM solicitation_suppressions
      `;

      const outcome = await redeem(rawToken, 'unsubscribe_link');

      expect(outcome.status).toBe('unknown_token');
      const after = await sql()<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM solicitation_suppressions
      `;
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    it('any sequence of redemptions over one token yields exactly one success-shaped outcome', async () => {
      // Property, not example: whatever order and however many times the two
      // surfaces redeem one token, exactly one attempt may land a ledger row.
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.constantFrom<UnsubscribeRedemptionSource>(
              'unsubscribe_one_click',
              'unsubscribe_link',
            ),
            { minLength: 1, maxLength: 5 },
          ),
          async (sources) => {
            const seeded = await seedToken();
            const statuses: string[] = [];
            for (const source of sources) {
              statuses.push((await redeem(seeded.rawToken, source)).status);
            }

            expect(statuses.filter((status) => status === 'redeemed')).toHaveLength(1);
            expect(statuses[0]).toBe('redeemed');
            expect(await countGlobalRows(seeded.handle)).toBe(1);
          },
        ),
        { numRuns: 10 },
      );
    });

    it('stamps redeemed_at even when an existing suppression row wins first-write-wins', async () => {
      // recordSuppression returns null when an existing row wins. That return
      // value must NOT gate the stamp — the claim already made it. Gating on it
      // would leave this token redeemable forever.
      const handle = freshHandle();
      await sql().begin((tx) =>
        recordSuppression(tx, {
          scope: 'global',
          channel: 'email',
          normalizedHandle: handle,
          accountId: accountId(),
          source: 'bounce_permanent',
        }),
      );
      const seeded = await seedToken({ handle });

      await redeem(seeded.rawToken, 'unsubscribe_one_click');

      expect(await tokenRedeemedAt(seeded.tokenHash)).not.toBeNull();
      const replay = await redeem(seeded.rawToken, 'unsubscribe_one_click');
      expect(replay.status).toBe('already_suppressed');
    });

    // ── genuinely concurrent transactions ────────────────────────────────────

    it('two overlapping redemptions write exactly one ledger row and one redeemed_at', async () => {
      const seeded = await seedToken();
      const firstClaimed = deferred();
      const firstMayCommit = deferred();
      const order: string[] = [];

      let firstOutcome: UnsubscribeRedemption | undefined;
      let stampInsideFirst: string | null = null;
      const first = sql()
        .begin(async (tx) => {
          firstOutcome = await redeemUnsubscribeToken(tx, {
            rawToken: seeded.rawToken,
            source: 'unsubscribe_one_click',
          });
          const [row] = await tx<{ redeemed_at: string | null }[]>`
            SELECT redeemed_at::text AS redeemed_at FROM solicitation_unsubscribe_tokens
            WHERE token_hash = ${seeded.tokenHash}
          `;
          stampInsideFirst = row!.redeemed_at;
          firstClaimed.resolve();
          await firstMayCommit.promise;
        })
        .then(() => {
          order.push('first');
        });

      await firstClaimed.promise;

      let secondOutcome: UnsubscribeRedemption | undefined;
      const second = sql()
        .begin(async (tx) => {
          secondOutcome = await redeemUnsubscribeToken(tx, {
            rawToken: seeded.rawToken,
            source: 'unsubscribe_link',
          });
        })
        .then(() => {
          order.push('second');
        });

      // The second must be BLOCKED on the first's row lock, not merely slow.
      await waitForTokenRowLockWaiter();
      firstMayCommit.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual(['first', 'second']);
      expect(firstOutcome?.status).toBe('redeemed');
      // Its claim matched nothing once the first committed, and the ledger read
      // that followed saw the first's row — no second write of either kind.
      expect(secondOutcome?.status).toBe('already_suppressed');
      expect(await countGlobalRows(seeded.handle)).toBe(1);
      expect(await tokenRedeemedAt(seeded.tokenHash)).toBe(stampInsideFirst);
    });

    it('a token minted after the claim snapshot reports unknown rather than already suppressed', async () => {
      // The token does not exist when the claim UPDATE runs; a real concurrent
      // transaction commits the mint before the follow-up read, whose fresh Read
      // Committed snapshot therefore sees an UNREDEEMED token. Branching on bare
      // existence would report success here with no suppression in existence.
      const rawToken = mintUnsubscribeRawToken();
      const handle = freshHandle();

      let outcome: UnsubscribeRedemption | undefined;
      await sql().begin(async (tx) => {
        const racing = commitBetweenStatements(tx, async () => {
          await seedToken({ rawToken, handle });
        });
        outcome = await redeemUnsubscribeToken(racing, {
          rawToken,
          source: 'unsubscribe_one_click',
        });
      });

      expect(outcome?.status).toBe('unknown_token');
      expect(await countGlobalRows(handle)).toBe(0);
      // Retryable, not a permanent dead end: the provider's next attempt lands.
      const retry = await redeem(rawToken, 'unsubscribe_one_click');
      expect(retry.status).toBe('redeemed');
      expect(await countGlobalRows(handle)).toBe(1);
    });

    it('a concurrent purge yields a suppression row with account_id NULL', async () => {
      const seeded = await seedToken();
      const scrubbed = deferred();
      const purgeMayCommit = deferred();

      const purge = sql().begin(async (tx) => {
        await tx`
          UPDATE solicitation_unsubscribe_tokens
             SET account_id = NULL, business_id = NULL, ask_id = NULL
           WHERE token_hash = ${seeded.tokenHash}
        `;
        scrubbed.resolve();
        await purgeMayCommit.promise;
      });

      await scrubbed.promise;
      let outcome: UnsubscribeRedemption | undefined;
      const redemption = sql().begin(async (tx) => {
        outcome = await redeemUnsubscribeToken(tx, {
          rawToken: seeded.rawToken,
          source: 'unsubscribe_link',
        });
      });

      // The claim parks behind the purge's row lock, then re-evaluates against
      // the scrubbed row version.
      await waitForTokenRowLockWaiter();
      purgeMayCommit.resolve();
      await Promise.all([purge, redemption]);

      expect(outcome?.status).toBe('redeemed');
      // Proves the ledger row is built from the claim's RETURNING, not from
      // provenance read before the purge committed.
      expect((await globalSuppressionRow(seeded.handle)).account_id).toBeNull();
    });

    // ── a spent token is not proof of a live suppression ─────────────────────

    it('a replayed spent token does not re-insert a suppression removed by the correction path', async () => {
      const seeded = await seedToken();
      await redeem(seeded.rawToken, 'unsubscribe_one_click');
      await removeGlobalSuppressionByCorrection(seeded.handle);

      await redeem(seeded.rawToken, 'unsubscribe_one_click');

      // Re-inserting here would silently undo an audited removal — the whole
      // reason the claim comes before the suppression.
      expect(await countGlobalRows(seeded.handle)).toBe(0);
    });

    it('a spent token whose suppression was removed by the correction path does not re-suppress', async () => {
      const seeded = await seedToken();
      await redeem(seeded.rawToken, 'unsubscribe_link');
      const firstStamp = await tokenRedeemedAt(seeded.tokenHash);
      await removeGlobalSuppressionByCorrection(seeded.handle);

      const replay = await redeem(seeded.rawToken, 'unsubscribe_link');

      // Distinct from already_suppressed on purpose: this outcome must not mint
      // a success receipt, because no suppression exists to be truthful about.
      expect(replay.status).toBe('already_redeemed_not_suppressed');
      expect(await tokenRedeemedAt(seeded.tokenHash)).toBe(firstStamp);
    });

    it('an account scoped suppression alone does not justify the global success sentence', async () => {
      const seeded = await seedToken();
      await redeem(seeded.rawToken, 'unsubscribe_link');
      await removeGlobalSuppressionByCorrection(seeded.handle);
      await sql().begin((tx) =>
        recordSuppression(tx, {
          scope: 'account',
          channel: 'email',
          normalizedHandle: seeded.handle,
          accountId: accountId(),
          source: 'owner_manual',
          createdByUserId: tenant!.userId,
        }),
      );

      const replay = await redeem(seeded.rawToken, 'unsubscribe_link');

      // `suppressionMatchSql` WOULD match this row — it answers the send-time
      // gate question. The success sentence asserts the recipient's own global
      // opt-out still stands, which an owner's do-not-contact does not.
      expect(replay.status).toBe('already_redeemed_not_suppressed');
    });

    // ── findRedeemableUnsubscribeToken ───────────────────────────────────────

    it('falls back to generic copy when the token business belongs to a different account', async () => {
      const own = await seedToken();
      const foreign = await seedToken({ businessId: FOREIGN_BUSINESS_ID });

      // The control proves the join resolves at all, so the null below is the
      // cross-account guard doing the work rather than a broken query.
      expect(await findRedeemableUnsubscribeToken(sql(), own.rawToken)).toEqual({
        businessName: OWNING_BUSINESS_NAME,
      });
      expect(await findRedeemableUnsubscribeToken(sql(), foreign.rawToken)).toEqual({
        businessName: null,
      });
    });

    it('resolves nothing for an unknown token or one already redeemed', async () => {
      // §5.4's enumeration rule, enforced structurally: the landing page cannot
      // tell "never existed" from "already used" because both are the same null.
      const neverMinted = mintUnsubscribeRawToken();
      const spent = await seedToken();
      await redeem(spent.rawToken, 'unsubscribe_link');

      expect(await findRedeemableUnsubscribeToken(sql(), neverMinted)).toBeNull();
      expect(await findRedeemableUnsubscribeToken(sql(), spent.rawToken)).toBeNull();
    });
  },
);
