import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';
import {
  attestPostalAddress,
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  readPostalAddressState,
} from '../postal-address';

// The Attested postal address WRITE path against the real schema (#656 T3).
// Written as pending placeholders by T1 (the eval task); T3 fills them in once
// `src/lib/solicitation/postal-address.ts` exists. T2 added the live-DB harness
// below — the schema assertion is T2's obligation, the fixtures and the
// assertions are T3's.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions to head and
// this suite asserts MIGRATION_099_SOLICITATION_POSTAL_ADDRESS with
// assertSchemaReady, so a behind-head DB fails with the actionable setup
// message rather than an undefined-column error.
//
// What decides whether these tests are real, rather than restatements of the
// implementation:
//
//  - "one account-scoped UPDATE" is a STATEMENT-COUNT claim. Capture the issued
//    SQL and assert exactly one `UPDATE businesses` carrying both the `id` and
//    the `account_id` predicate. An outcome-only assertion would pass against a
//    read-then-write that races.
//
//  - "never covers stale bytes" needs three facts after a second attestation
//    with different bytes: `_attested_at` ADVANCED, the stored address equals
//    the new bytes, and `_attested_digest` equals sha256 of the new bytes
//    (node:crypto — invariant #10, never crypto-js).
//
//  - "preserves the previous tuple byte-for-byte" must be driven by BOTH
//    failure modes — a lint-invalid address and an actor outside the account —
//    with all five columns snapshotted before and after and compared with
//    toEqual.
//
//  - the two rejections must stay DISTINGUISHABLE: `actor_not_in_account` vs
//    `business_not_found`. `_attested_by_user_id` carries no FK, so the actor
//    membership predicate on the UPDATE is the only thing stopping a
//    cross-tenant UUID being stamped as legal provenance — collapsing the two
//    statuses would hide which guard fired.
//
// Every timestamp comparison is made BY POSTGRES against a `::text` round trip,
// never against a JS Date: postgres.js truncates timestamptz microseconds to
// milliseconds, and "did the re-attestation advance the clock" is exactly the
// sub-millisecond comparison that class of bug hides in.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
/** A second client whose `debug` hook records every statement it issues. */
let recorder: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

interface RecordedStatement {
  query: string;
  parameters: readonly unknown[];
}

const recorded: RecordedStatement[] = [];

const businessId = randomUUID();
const otherBusinessId = randomUUID();
let accountId: string | undefined;
let userId: string | undefined;
let secondUserId: string | undefined;
let otherAccountId: string | undefined;
let otherUserId: string | undefined;

const FIXTURE_ADDRESS = '123 Main St\nAustin, TX 78701';
const REPLACEMENT_ADDRESS = '999 Other Rd\nSuite 4\nAustin, TX 78702';
/** Raw owner input whose normalized form is FIXTURE_ADDRESS. */
const UNTIDY_FIXTURE_ADDRESS = '  123 Main St  \r\n  Austin, TX 78701  ';
/** The §7.5 service-area trap: one line, no postal code. Never lint-valid. */
const SERVICE_AREA_ADDRESS = 'Austin, TX, USA';

/** Invariant #10: node:crypto, never crypto-js. */
function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('postal-address integration database was not initialized');
  return db;
}

/** All five columns as TEXT, so a snapshot compares bytes rather than Dates. */
interface AttestationSnapshot {
  address: string | null;
  attested_at: string | null;
  attested_by: string | null;
  version: string | null;
  digest: string | null;
}

async function snapshot(forBusinessId: string): Promise<AttestationSnapshot> {
  const [row] = await sql()<AttestationSnapshot[]>`
    SELECT solicitation_postal_address                            AS address,
           solicitation_postal_address_attested_at::text          AS attested_at,
           solicitation_postal_address_attested_by_user_id::text  AS attested_by,
           solicitation_postal_address_attestation_version        AS version,
           solicitation_postal_address_attested_digest            AS digest
    FROM businesses
    WHERE id = ${forBusinessId}::uuid
  `;
  if (!row) throw new Error(`postal-address fixture business ${forBusinessId} is missing`);
  return row;
}

/** Postgres decides whether the clock advanced, against the µs-exact text. */
async function attestedAtAdvancedSince(previous: string): Promise<boolean> {
  const [row] = await sql()<{ advanced: boolean }[]>`
    SELECT solicitation_postal_address_attested_at > ${previous}::timestamptz AS advanced
    FROM businesses
    WHERE id = ${businessId}::uuid
  `;
  return row!.advanced;
}

/** All five together — the all-or-nothing CHECK rejects any partial reset. */
async function clearAttestations(): Promise<void> {
  await sql()`
    UPDATE businesses SET
      solicitation_postal_address                      = NULL,
      solicitation_postal_address_attested_at          = NULL,
      solicitation_postal_address_attested_by_user_id  = NULL,
      solicitation_postal_address_attestation_version  = NULL,
      solicitation_postal_address_attested_digest      = NULL
    WHERE id = ANY(${[businessId, otherBusinessId]}::uuid[])
  `;
}

describeWithDb(
  'postal address attestation writes',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_099_SOLICITATION_POSTAL_ADDRESS]);

      recorder = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        debug: (_connection, query, parameters) => {
          recorded.push({ query, parameters: parameters as readonly unknown[] });
        },
      });

      const seed = await seedTenantAccount(db, {
        userName: 'Postal Address Owner',
        accountDisplayName: 'Postal Address Fixture',
      });
      accountId = seed.accountId;
      userId = seed.userId;

      // A SECOND owner inside the same account: re-attestation must record the
      // actor who actually clicked, not the one who first attested.
      secondUserId = randomUUID();
      await db`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (
          ${secondUserId}::uuid, 'Postal Address Co-Owner',
          ${`co-owner-${secondUserId}@test.local`}, 'owner', ${seed.accountId}::uuid
        )
      `;

      const otherSeed = await seedTenantAccount(db, {
        userName: 'Rival Postal Address Owner',
        accountDisplayName: 'Rival Postal Address Fixture',
      });
      otherAccountId = otherSeed.accountId;
      otherUserId = otherSeed.userId;

      for (const [id, tenantSeed] of [
        [businessId, seed],
        [otherBusinessId, otherSeed],
      ] as const) {
        await db`
          INSERT INTO businesses (
            id, name, owner_name, owner_email, account_id, subscription_status,
            category, google_place_address
          ) VALUES (
            ${id}::uuid, 'Postal Address Business', 'Postal Owner',
            ${tenantSeed.ownerEmail}, ${tenantSeed.accountId}::uuid, 'active',
            'automotive', ${SERVICE_AREA_ADDRESS}
          )
        `;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      recorded.length = 0;
      await clearAttestations();
    });

    afterAll(async () => {
      try {
        if (db && accountId && otherAccountId) {
          await db`DELETE FROM businesses WHERE id = ANY(${[businessId, otherBusinessId]}::uuid[])`;
          await db`DELETE FROM users WHERE id = ${secondUserId!}::uuid`;
          await cleanupTenantAccount(db, { accountId, userId: userId! });
          await cleanupTenantAccount(db, { accountId: otherAccountId, userId: otherUserId! });
        }
      } finally {
        try {
          if (recorder) await recorder.end({ timeout: 5 });
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('attestPostalAddress writes the whole attestation tuple in one account-scoped UPDATE', async () => {
      // Warm the recorded client BEFORE clearing the buffer, so connection
      // setup traffic can never be mistaken for a statement the module issued.
      await recorder!`SELECT 1`;
      recorded.length = 0;

      const result = await attestPostalAddress(recorder!, {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: UNTIDY_FIXTURE_ADDRESS,
      });
      expect(result).toEqual({ status: 'attested' });

      // ONE statement, total. A read-then-write would produce two and still
      // reach the same row state, which is why the outcome alone proves nothing.
      expect(recorded).toHaveLength(1);
      const statement = recorded[0]!.query.replace(/\s+/g, ' ').trim();
      expect(statement).toContain('UPDATE businesses');
      // Both tenant predicates on the write itself.
      expect(statement).toMatch(/WHERE id = \$\d+::uuid AND account_id = \$\d+::uuid/);
      // The actor-membership predicate rides the SAME statement — there is no
      // FK on _attested_by_user_id (093's lesson), so this is the only thing
      // stopping an arbitrary UUID being stamped as legal provenance.
      expect(statement).toMatch(
        /EXISTS \( ?SELECT 1 FROM users WHERE id = \$\d+::uuid AND account_id = \$\d+::uuid ?\)/,
      );
      // The digest is computed SERVER-SIDE from the same bound value the column
      // stores, so it cannot disagree with what migration 099's CHECK
      // recomputes. Asserting the expression is present is half the claim; the
      // other half is that no parameter carries a precomputed hex digest.
      expect(statement).toContain("encode(sha256(convert_to($");
      expect(statement).toContain("'UTF8')), 'hex')");
      expect(recorded[0]!.parameters).not.toContain(sha256Hex(FIXTURE_ADDRESS));

      const row = await snapshot(businessId);
      // The stored bytes are the NORMALIZED ones — the footer bakes them in
      // verbatim, so a stray trailing space would ship to every recipient.
      expect(row.address).toBe(FIXTURE_ADDRESS);
      expect(row.attested_by).toBe(userId);
      expect(row.version).toBe(POSTAL_ADDRESS_ATTESTATION_VERSION);
      expect(row.digest).toBe(sha256Hex(FIXTURE_ADDRESS));
      expect(row.attested_at).not.toBeNull();
    });

    it('attestPostalAddress re-attests on edit so the attestation never covers stale bytes', async () => {
      const first = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: FIXTURE_ADDRESS,
      });
      expect(first).toEqual({ status: 'attested' });
      const before = await snapshot(businessId);

      const second = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: REPLACEMENT_ADDRESS,
      });
      expect(second).toEqual({ status: 'attested' });

      const after = await snapshot(businessId);
      expect(after.address).toBe(REPLACEMENT_ADDRESS);
      expect(after.digest).toBe(sha256Hex(REPLACEMENT_ADDRESS));
      // …and NOT the old digest, which is what a writer that forgot to
      // recompute would leave behind (migration 099's digest CHECK also
      // rejects it — this asserts the module never gets there).
      expect(after.digest).not.toBe(before.digest);
      expect(await attestedAtAdvancedSince(before.attested_at!)).toBe(true);
    });

    it('attestPostalAddress records the new actor on re-attestation', async () => {
      await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: FIXTURE_ADDRESS,
      });
      expect((await snapshot(businessId)).attested_by).toBe(userId);

      const second = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: secondUserId!,
        address: REPLACEMENT_ADDRESS,
      });
      expect(second).toEqual({ status: 'attested' });

      // The attestation names whoever assented to THESE bytes. Keeping the
      // original attester would credit a compliance assertion to someone who
      // never made it.
      expect((await snapshot(businessId)).attested_by).toBe(secondUserId);
    });

    it('a failed re-attestation preserves the previous attestation tuple byte-for-byte', async () => {
      await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: FIXTURE_ADDRESS,
      });
      const before = await snapshot(businessId);
      expect(before.address).toBe(FIXTURE_ADDRESS);

      // Failure mode 1 — the lint refuses the new bytes.
      const invalid = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: userId!,
        address: SERVICE_AREA_ADDRESS,
      });
      expect(invalid).toEqual({ status: 'invalid', reason: 'single_line' });
      expect(await snapshot(businessId)).toEqual(before);

      // Failure mode 2 — the bytes are fine but the actor is not in the
      // account. A partial write here would leave a valid-looking attestation
      // over an address nobody in this account ever saw.
      const rejected = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: otherUserId!,
        address: REPLACEMENT_ADDRESS,
      });
      expect(rejected).toEqual({ status: 'actor_not_in_account' });
      expect(await snapshot(businessId)).toEqual(before);
    });

    it("attestPostalAddress rejects an attesting user outside the caller's account", async () => {
      // The business and the account agree; only the actor is foreign. Nothing
      // in the SCHEMA stops this — migration 099 deliberately declares no FK on
      // _attested_by_user_id — so the UPDATE's membership predicate is the
      // whole defence.
      const result = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: otherUserId!,
        address: FIXTURE_ADDRESS,
      });
      expect(result).toEqual({ status: 'actor_not_in_account' });

      const row = await snapshot(businessId);
      expect(row).toEqual({
        address: null,
        attested_at: null,
        attested_by: null,
        version: null,
        digest: null,
      });

      // A UUID belonging to no user at all is the same refusal, and is
      // distinguishable from the business case below.
      const unknownActor = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId,
        userId: randomUUID(),
        address: FIXTURE_ADDRESS,
      });
      expect(unknownActor).toEqual({ status: 'actor_not_in_account' });
    });

    it("attestPostalAddress refuses to write for a business outside the caller's account", async () => {
      // Mirror image of the case above: the actor is legitimate, the target
      // location belongs to another tenant. The two refusals must not collapse
      // into one status, or a failing deploy cannot tell which guard fired.
      const result = await attestPostalAddress(sql(), {
        accountId: accountId!,
        businessId: otherBusinessId,
        userId: userId!,
        address: FIXTURE_ADDRESS,
      });
      expect(result).toEqual({ status: 'business_not_found' });

      const victim = await snapshot(otherBusinessId);
      expect(victim.address).toBeNull();
      expect(victim.attested_at).toBeNull();

      // Non-vacuity: the rival location is attestable by ITS own account, so
      // the refusal above was scoping rather than a broken fixture.
      const rightful = await attestPostalAddress(sql(), {
        accountId: otherAccountId!,
        businessId: otherBusinessId,
        userId: otherUserId!,
        address: FIXTURE_ADDRESS,
      });
      expect(rightful).toEqual({ status: 'attested' });
    });

    it('readPostalAddressState returns no data for a business outside the supplied account', async () => {
      await attestPostalAddress(sql(), {
        accountId: otherAccountId!,
        businessId: otherBusinessId,
        userId: otherUserId!,
        address: REPLACEMENT_ADDRESS,
      });

      // Cross-tenant read: the row exists and is attested, and this account
      // still learns nothing about it — not even that it is there.
      expect(
        await readPostalAddressState(sql(), {
          accountId: accountId!,
          businessId: otherBusinessId,
        }),
      ).toBeNull();

      // Non-vacuity: the same call from the owning account returns the row, so
      // the null above is scoping rather than a function that always returns
      // null.
      const rightful = await readPostalAddressState(sql(), {
        accountId: otherAccountId!,
        businessId: otherBusinessId,
      });
      expect(rightful).toMatchObject({
        address: REPLACEMENT_ADDRESS,
        attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
        // Google's formattedAddress is withheld once an owner has attested:
        // re-offering a service-area string beside a compliance record invites
        // overwriting the second with the first.
        suggestion: null,
      });
      expect(rightful?.attestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Unattested, same account: the suggestion IS offered, and nothing was
      // persisted to get there.
      const unattested = await readPostalAddressState(sql(), {
        accountId: accountId!,
        businessId,
      });
      expect(unattested).toEqual({
        address: null,
        attestedAt: null,
        attestationVersion: null,
        suggestion: SERVICE_AREA_ADDRESS,
      });
    });
  },
);
