// Live-DB suite for the Solicitation send worker's dispatch lane (#899 Task 0 —
// the eval task). Twenty-three promised titles, every one of them a claim about
// rows that only real Postgres can settle: the seven-item Dispatch gate's
// withheld reasons, the unsubscribe token mint, the `queued → sending → sent`
// CAS, and the single transaction that commits every terminal fact at once.
//
// CONVENTIONS THIS FILE IS BOUND BY
//
//   * The `*.integration.test.ts` NAME is load-bearing — it is what selects
//     vitest's serialized `integration` project. A live-DB suite outside that
//     glob runs in the fully parallel project against every other live-DB
//     writer (`ci:live-db-suites` R1).
//   * NO RUN-TIME DDL — not a CREATE, not an ALTER, not a temporary CHECK
//     constraint. DDL takes ACCESS EXCLUSIVE on a shared relation and deadlocks
//     (40P01) against siblings holding ordinary row locks in the other order,
//     and the victim is whichever transaction Postgres picks, so the failure
//     lands somewhere unrelated and reads as flake (`ci:live-db-suites` R2).
//     `pnpm test:db:setup` provisions the schema; this file ASSERTS it with
//     `assertSchemaReady`. To force a transaction abort — which test 16's
//     all-or-nothing claim needs — use `helpers/abort-injection.ts`'s
//     `abortingExecutor`, whose poison is a real Postgres error and which
//     leaves nothing behind on a vitest timeout. Never a temporary constraint.
//   * Every lifecycle timestamp is written as a SQL interval off `NOW()`, never
//     as a JS `Date`: postgres.js truncates timestamptz microseconds, so a
//     JS-derived stamp can land before the `NOW()`-defaulted column it must not
//     precede and trip a constraint unrelated to the case under test (#520).
//
// The bootstrap below is REAL and is the shape Tasks 2–6 extend; the twenty-three
// cases are `it.todo` until the task that owns each one converts it. Fixture
// builders (batch → ask → Outreach row, consent row, suppression row, attested
// postal address) land with the first task that needs them rather than being
// speculatively written against a `dispatch.ts` that does not exist yet.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
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
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_093_SOLICITATION_CONSENT,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
  MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
  MIGRATION_110_SEND_GOVERNORS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';

const testDatabaseUrl = resolveTestDatabaseUrl();

/** The location under test. One `businesses` row = one Google Business Profile
 *  location, and the Dispatch gate's postal-address item is a fact about it. */
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

describeWithDb(
  'solicitation dispatch lane',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 4, prepare: false });
      // ASSERT, never apply. 091 carries the send-mode spine lifecycle the CAS
      // and the Lazy child depend on, 093 the Consent ledger, 096 the
      // Suppression ledger AND `solicitation_unsubscribe_tokens`, 099 the
      // attested postal address, 108 the owner-excluded disposition, and 110
      // (#898) the send governors this lane's bounce discrimination writes.
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_093_SOLICITATION_CONSENT,
        MIGRATION_096_SOLICITATION_SUPPRESSIONS,
        MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
        MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
        MIGRATION_110_SEND_GOVERNORS,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Dispatch Owner',
        accountDisplayName: 'Dispatch Account',
      });
      await seedLocation(db, tenant.accountId, {
        businessId,
        name: 'Dispatch Business',
        isPrimary: true,
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          // Child-to-parent order: the FKs from the solicitation tables have no
          // cascade, and `agent_runs` holds the Lazy children this lane creates.
          await db`DELETE FROM solicitation_unsubscribe_tokens WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_consent WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM agent_runs WHERE business_id = ${businessId}::uuid`;
          // `solicitation_suppressions` is scoped by ACCOUNT, not by location:
          // a global-scope row carries no account_id at all and an
          // account-scope row carries no business_id. Deleting by business_id
          // would silently strand every row this lane wrote.
          if (tenant) {
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${tenant.accountId}::uuid`;
          }
          // `job_outbox` has no tenant columns — the scope lives in the
          // payload, which is why this reads it rather than a column.
          await db`DELETE FROM job_outbox WHERE payload->>'business_id' = ${businessId}`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, 120_000);

    // ---- The seven-item Dispatch gate (Tasks 2 and 3) ----------------------
    //
    // Each case drives ONE item to failure with every other item passing, so a
    // green result names which item fired. `no_postal_address` here is a
    // dispatch-time fact about one Outreach row — never collapse it into the
    // Send handoff's `postal_address_missing`, which is a handoff-time fact
    // about the business.
    describe('Dispatch gate', () => {
      it.todo('withholds with no_postal_address when the location has no Attested postal address');
      it.todo('withholds with postal_address_mismatch when the stored footer no longer byte-matches');
      it.todo('withholds with suppressed and emits solicitation_suppressed_at_dispatch when the handle is on the Suppression ledger');
      it.todo('withholds with no_consent when the consent row is missing or its attestation version is not send-eligible');
      it.todo('withholds with lint_failed when the stored bytes fail the current ASK_LINT_VERSION');
      // Decision 6 / amendment B1: the dispatch verdict NEVER overwrites the
      // render's `moderation_status` or `moderation_detail` — those columns are
      // render provenance. The withheld reason is the only thing that moves.
      it.todo('withholds with moderation_high and leaves the render moderation_status untouched');
      // Decision 5: flag-off is a DEFER, not a withhold. 091/110 have no
      // `flag_off` reason and inventing one terminalizes a row the owner still
      // owns; the row stays `queued` and #900's producer re-drips it.
      it.todo('defers a queued Outreach row without terminalizing it when SOLICITATION_SEND_ENABLED is off');
      // The Halt latch cancels `rendered` and `queued` rows, never `sending`.
      // A job that arrives after the sweep finds a `cancelled` row and must do
      // nothing at all — not re-gate it, not re-terminalize it.
      it.todo('no-ops when the batch is halted and the Outreach row is already cancelled');
      // Task 3 — the stored interpolation snapshot is the Owner approval
      // guarantee's input. Absent, there is no byte-for-byte claim left to make,
      // so the only safe answer is to withhold rather than to re-derive.
      it.todo('withholds rather than sending when the stored interpolation snapshot is absent');
    });

    // ---- Unsubscribe token mint (Task 4, invariant #5) ---------------------
    describe('unsubscribe token mint', () => {
      // `solicitation_unsubscribe_tokens_outreach_uniq` is what makes this one
      // row per Outreach row. Only the SHA-256 hash is stored — the raw token
      // exists in memory and in the recipient's link, never in Postgres.
      it.todo('mints one unsubscribe token row per outreach_id and stores only the SHA-256 hash');
      // The provider idempotency key is the Outreach row id, so a retry that
      // minted a NEW token would re-issue a different body under the same key.
      it.todo('re-uses the existing token row on a retry so the provider idempotency retry has a stable body');
      // Assert across every column of `solicitation_unsubscribe_tokens` AND
      // `solicitation_outreach`: the raw token appears in none of them.
      it.todo('substitutes the raw unsubscribe URL in memory and never writes it to Postgres');
    });

    // ---- tx1 CAS, the provider call, tx2 (Task 6) --------------------------
    describe('send and terminal transaction', () => {
      // Decision 4 + 9b. A row already `sending` means a prior invocation owned
      // it; re-gating could withhold a message that is already on the wire.
      it.todo('resumes a sending Outreach row without re-running the Dispatch gate');
      // A `sent` row with a NULL provider_message_id makes every later bounce
      // and complaint unattributable — persisting it is not optional.
      it.todo('persists provider_message_id on every successful send');
      // D12a's all-or-nothing claim. Proved by aborting the transaction with
      // `abortingExecutor` and asserting NONE of the five facts survived — an
      // outbox row left incomplete keeps the watchdog owning the work, which is
      // why no orphan sweeper is needed.
      it.todo('commits the terminal CAS, the child run terminal, the solicitation_sent outcome, the outbox completion and closeBatchIfSettled in one transaction');
      // D14: outcomes live on CHILDREN. One on the Send batch parent would
      // double-count the batch in every downstream metric.
      it.todo('emits solicitation_sent on the child run with unit_count 1, never on the Send batch parent');
      // `terminal_bounce` is the only class that stamps `bounced_at`, and that
      // stamp is what feeds the Suppression ledger (#626).
      it.todo('classifies a provider hard bounce as terminal with zero retries and stamps bounced_at');
      // The third class the first plan draft left unhandled: no `bounced_at`
      // (nothing bounced), still terminal, still joined. A class with no arm is
      // how rows get stranded in `sending` forever.
      it.todo('terminalizes a terminal_other provider error without retrying or leaving the Outreach row sending');
      // Decision 9b — the cost this plan accepts in writing. The raw token is
      // unrecoverable across a process boundary, so no correct message can be
      // built; re-issuing would send a body with a dead unsubscribe URL. The
      // row is left `sending` for #900's D12d sweep to call `unknown`.
      it.todo('does not call the Messaging adapter when re-invoked in a fresh process without the raw token');
      // At-least-once outbox delivery means the same attempt can arrive twice.
      // A stale attempt number must not reach the provider.
      it.todo('ignores a stale outbox attempt and does not call the Messaging adapter');
    });

    // ---- The inline join (Task 6, D11) -------------------------------------
    describe('batch closure', () => {
      // A Settled batch has no Outreach row left in `rendered`, `queued` or
      // `sending`. Every terminal writer calls `closeBatchIfSettled` in the
      // SAME transaction, so the last writer across a MIXED terminal set — not
      // just an all-sent one — is what closes it.
      it.todo('closes the batch once the last Outreach row terminalizes across a mixed sent, withheld and failed set');
      // The flag-off defer still completes the outbox attempt. Leaving it
      // in-flight would have the watchdog re-pend a row that was correctly
      // deferred, turning a quiet no-op into a retry storm.
      it.todo('completes the outbox attempt when deferring on a flag-off so the watchdog does not re-pend it');
      // The Halt latch deliberately excludes `sending`. A halt that lands after
      // the CAS must leave the in-flight child alone; cancelling it would
      // terminalize a run whose message is already on the wire.
      it.todo('does not cancel an in-flight sending child when a halt lands after the CAS');
    });
  },
);
