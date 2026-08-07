// src/lib/locations/__tests__/add-location-tx.integration.test.ts
//
// T0 EVAL suite for #677 — titles 44, 46, 47, 48 and 65 of the intake's 69,
// authored VERBATIM before implementation.
//
// Import consent LINEAGE: when an archived location is re-added, the new
// `businesses` row inherits the archived sibling's consent columns verbatim, so a
// declined place cannot be re-offered (and re-imported) by archiving and
// re-adding it.
//
// WHY FIVE OF SIX LIVE (owner decision, 2026-08-07, deviations D6): the match is
// a **disjunction over non-NULL keys** with an ORDER BY tie-break and an
// account-scope predicate — pure SQL semantics. A mocked `sql` tag can prove the
// template was interpolated; it cannot prove the sibling actually selected is the
// right one. Only title 45 (no archived sibling → stays pending) is a mocked
// binding assertion, and it lives in add-location-tx.test.ts.
//
// The lineage key, corrected twice (round-1 F103, then round-2 Medium):
// revision 2 chose the key from the NEW row only — place id if present, else maps
// url — which still missed the cross-representation case. URL-mode adds
// deliberately store a `google_maps_url` with a NULL `google_place_id` until
// validate_place_id resolves it (add-location-tx.ts:263-279), so BOTH directions
// occur in practice. A sibling therefore qualifies when its `google_place_id`
// equals the new row's (both non-NULL) OR its `google_maps_url` equals the new
// row's (both non-NULL) — never NULL to NULL, in either column.
//
// Titles 47 and 65 are the two directions, and they are NOT redundant:
//   47 — new row has the place id, archived sibling's place id is NULL
//   65 — the same shape stated from the new row's side, which is the case
//        revision 3's title 66 claimed to cover but did not (it asserted equal
//        place ids with differing URLs — the ordinary branch). Round 3 retargeted
//        it; do not re-merge them.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { addLocationTransaction, type AddLocationTxInput } from '../add-location-tx';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let foreign: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('add-location lineage database was not initialized');
  return db;
}

const PLACE_A = 'ChIJ_lineage_place_A';
const URL_A = 'https://maps.google.com/?cid=lineage-a';

/**
 * Insert an ARCHIVED sibling carrying a consent decision. Written through raw
 * SQL, never through the module under test, so a broken writer cannot construct
 * its own passing precondition.
 */
async function seedArchivedSibling(opts: {
  accountId: string;
  placeId?: string | null;
  mapsUrl?: string | null;
  decision: 'pending' | 'accepted' | 'declined';
  decidedAtSql?: string | null;
  expiresAtSql?: string | null;
  archivedAtSql?: string;
  ownerEmail: string;
}): Promise<string> {
  const id = randomUUID();
  await sql().unsafe(
    `INSERT INTO businesses (
       id, account_id, is_primary, display_label, name,
       google_place_id, google_maps_url, owner_name, owner_email,
       subscription_status, archived_at,
       import_decision, import_decision_at, import_offer_expires_at
     ) VALUES (
       '${id}'::uuid, '${opts.accountId}'::uuid, FALSE, 'Archived Sibling',
       'Archived Sibling',
       ${opts.placeId ? `'${opts.placeId}'` : 'NULL'},
       ${opts.mapsUrl ? `'${opts.mapsUrl}'` : 'NULL'},
       'Owner', '${opts.ownerEmail}', 'active',
       ${opts.archivedAtSql ?? 'now()'},
       '${opts.decision}',
       ${opts.decidedAtSql ? `(${opts.decidedAtSql})` : 'NULL'},
       ${opts.expiresAtSql ? `(${opts.expiresAtSql})` : 'NULL'}
     )`,
  );
  return id;
}

function mkInput(overrides: Partial<AddLocationTxInput> = {}): AddLocationTxInput {
  return {
    accountId: tenant!.accountId,
    displayLabel: 'New Location',
    googlePlaceId: null,
    placeIdVerified: false,
    googleMapsUrl: null,
    actorUserId: tenant!.userId,
    ownerName: 'Owner',
    ownerEmail: tenant!.ownerEmail,
    subscriptionTier: 'copilot',
    subscriptionStatus: 'active',
    activeLocationsBefore: 1,
    ...overrides,
  };
}

async function consentOf(businessId: string) {
  const [row] = await sql()<{
    import_decision: string;
    import_decision_at: Date | null;
    import_offer_expires_at: Date | null;
  }[]>`
    SELECT import_decision, import_decision_at, import_offer_expires_at
    FROM businesses WHERE id = ${businessId}::uuid
  `;
  return row!;
}

describeWithDb('add-location Import consent lineage against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'Lineage Owner',
      accountDisplayName: 'Lineage Account',
    });
    foreign = await seedTenantAccount(db, {
      userName: 'Foreign Owner',
      accountDisplayName: 'Foreign Account',
    });
  });

  /**
   * Drop every location row for both tenants, children first.
   * `account_audit_log.location_id` FKs to `businesses`, so businesses must go
   * LAST — a bare `DELETE FROM businesses` raises
   * `account_audit_log_location_id_fkey`. One helper, used by `afterEach` and by
   * the one test that needs a mid-test reset, so the two orderings cannot drift.
   */
  async function resetLocations(): Promise<void> {
    for (const t of [tenant, foreign]) {
      if (!t) continue;
      await sql()`DELETE FROM account_audit_log WHERE account_id = ${t.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id IN (
        SELECT id FROM businesses WHERE account_id = ${t.accountId}::uuid
      )`;
      await sql()`DELETE FROM businesses WHERE account_id = ${t.accountId}::uuid`;
    }
  }

  // Each test seeds its own siblings and adds its own location; the ORDER BY and
  // account-scope assertions only mean something against a known row set.
  afterEach(resetLocations);

  afterAll(async () => {
    if (!db) return;
    for (const t of [tenant, foreign]) {
      if (t) await cleanupTenantAccount(sql(), t);
    }
    await db.end({ timeout: 5 });
  });
  // The D8 hole this whole task closes: declined must survive a re-add.
  it("add-location inherits a declined sibling's import consent when re-adding an archived place", async () => {
    await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: PLACE_A,
      decision: 'declined',
      decidedAtSql: "now() - interval '2 days'",
      expiresAtSql: "now() + interval '5 days'",
    });

    const result = await addLocationTransaction(
      sql(),
      mkInput({ googlePlaceId: PLACE_A, placeIdVerified: true }),
    );

    const consent = await consentOf(result.businessId);
    // Without this the owner archives, re-adds, and gets a fresh offer — a D8
    // violation reachable from the locations UI with no SQL.
    expect(consent.import_decision).toBe('declined');
    expect(consent.import_decision_at).not.toBeNull();
  });

  // Round-1 Medium (F104): `archived_at` alone is nondeterministic on a tie, so
  // the ordering is `archived_at DESC, created_at DESC, id DESC`. The
  // foreign-account half is invariant #8.
  it('add-location inherits consent from the most recently archived sibling in the same account and ignores foreign-account siblings', async () => {
    // Older sibling ACCEPTED, newer sibling DECLINED — so "most recent wins" and
    // "first row wins" give different answers, which is what makes this a real
    // ordering assertion rather than a coincidence.
    await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: PLACE_A,
      decision: 'accepted',
      decidedAtSql: "now() - interval '20 days'",
      archivedAtSql: "now() - interval '20 days'",
    });
    await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: PLACE_A,
      decision: 'declined',
      decidedAtSql: "now() - interval '1 day'",
      archivedAtSql: "now() - interval '1 day'",
    });
    // A DIFFERENT account's archived row for the SAME place, answered the other
    // way. It must never donate consent.
    await seedArchivedSibling({
      accountId: foreign!.accountId,
      ownerEmail: foreign!.ownerEmail,
      placeId: PLACE_A,
      decision: 'accepted',
      decidedAtSql: 'now()',
      archivedAtSql: 'now()',
    });

    const result = await addLocationTransaction(
      sql(),
      mkInput({ googlePlaceId: PLACE_A, placeIdVerified: true }),
    );

    expect((await consentOf(result.businessId)).import_decision).toBe('declined');
  });

  it('add-location inherits consent through google_maps_url when the archived sibling has a NULL google_place_id', async () => {
    // URL-mode adds store a maps url with a NULL place id until validate_place_id
    // resolves it, so this shape is ordinary, not exotic.
    await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: null,
      mapsUrl: URL_A,
      decision: 'declined',
      decidedAtSql: 'now()',
    });

    const result = await addLocationTransaction(sql(), mkInput({ googleMapsUrl: URL_A }));

    expect((await consentOf(result.businessId)).import_decision).toBe('declined');
  });

  // "Verbatim including both timestamps" is the load-bearing phrase: copying the
  // decision without `import_offer_expires_at` would hand an inherited `pending`
  // row a NULL deadline, which is the round-1 Critical (a NULL deadline was
  // answerable) reintroduced through the side door.
  it('add-location copies accepted and live-pending sibling consent verbatim including both timestamps', async () => {
    const acceptedSibling = await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: PLACE_A,
      decision: 'accepted',
      decidedAtSql: "now() - interval '3 days'",
      expiresAtSql: "now() + interval '4 days'",
    });
    const source = await consentOf(acceptedSibling);

    const accepted = await addLocationTransaction(
      sql(),
      mkInput({ googlePlaceId: PLACE_A, placeIdVerified: true }),
    );

    // All three columns, byte-for-byte.
    expect(await consentOf(accepted.businessId)).toEqual(source);

    await resetLocations();

    // A LIVE pending offer inherits its remaining window rather than restarting
    // it — the offer is per place, and archiving is not a way to buy another 7
    // days.
    const pendingSibling = await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: PLACE_A,
      decision: 'pending',
      expiresAtSql: "now() + interval '2 days'",
    });
    const pendingSource = await consentOf(pendingSibling);

    const pending = await addLocationTransaction(
      sql(),
      mkInput({ googlePlaceId: PLACE_A, placeIdVerified: true }),
    );

    expect(await consentOf(pending.businessId)).toEqual(pendingSource);
    expect((await consentOf(pending.businessId)).import_offer_expires_at).not.toBeNull();
  });

  it('add-location inherits consent through equal google_maps_url when the new row has a place id and the archived sibling place id is NULL', async () => {
    // THE CROSS-REPRESENTATION CASE (round-3 retarget). The new row carries a
    // resolved place id; the archived sibling's place id was never resolved, so
    // only the maps urls match. A key chosen from the new row alone — "place id
    // if present, else url" — would look at google_place_id, find no sibling with
    // it, and silently hand back a fresh offer for a place the owner already
    // answered for.
    await seedArchivedSibling({
      accountId: tenant!.accountId,
      ownerEmail: tenant!.ownerEmail,
      placeId: null,
      mapsUrl: URL_A,
      decision: 'declined',
      decidedAtSql: 'now()',
    });

    const result = await addLocationTransaction(
      sql(),
      mkInput({ googlePlaceId: PLACE_A, placeIdVerified: true, googleMapsUrl: URL_A }),
    );

    expect((await consentOf(result.businessId)).import_decision).toBe('declined');
  });
});
