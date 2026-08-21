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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { startOrGetSolicitationSendBatchRun } from '@/lib/agents/run-spine';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { checksum, insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
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
import { assembleAskBody } from '../ask-render';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { dispatchOutreach } from '../dispatch';
import { POSTAL_ADDRESS_ATTESTATION_VERSION } from '../postal-address';

const testDatabaseUrl = resolveTestDatabaseUrl();

/** The location under test. One `businesses` row = one Google Business Profile
 *  location, and the Dispatch gate's postal-address item is a fact about it. */
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

/** The seeded handles, narrowed. `beforeAll` runs before any case, so an
 *  `undefined` here is a bug in this file rather than a state a case handles. */
function sql(): postgresType.Sql {
  if (!db) throw new Error('live-DB handle used before beforeAll');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('tenant seed used before beforeAll');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('tenant seed used before beforeAll');
  return tenant.userId;
}

/**
 * One queued **Outreach row** with the whole chain it needs — upload → contact
 * → batch → send **Ask** → the row — plus the `dispatched` `job_outbox` row
 * this worker owns the attempt of.
 *
 * Every stamp is a SQL interval off `NOW()`, never a JS `Date` (see the
 * header): 091 requires `queued_at` of every dispatched status, and a
 * JS-derived stamp truncated to milliseconds can land before the `NOW()`
 * default it must not precede.
 */
interface QueuedOutreachFixture {
  batchId: string;
  askId: string;
  outreachId: string;
  outboxId: string;
  attempt: number;
  /** The contact's **Normalized handle** — what both ledgers key on. */
  handle: string;
}

/**
 * The address the fixture bakes into the stored body. `assembleAskBody` puts it
 * in VERBATIM as its own line, and the Dispatch gate's byte-match is a
 * containment test against exactly those bytes — so the mismatch case moves the
 * BUSINESS's attested address afterwards and leaves the stored body alone,
 * which is the shape the real defect takes (an owner edits their address after
 * approval).
 */
const SEEDED_POSTAL_ADDRESS = '742 Evergreen Terrace\nSpringfield, IL 62704';

/** Deliberately not `consent_attestation_v2`: `SEND_ELIGIBLE_ATTESTATION_VERSIONS`
 *  omits v1 because its text disclaimed sending, and the gate is a MEMBERSHIP
 *  test against that list rather than a "not v1" test. */
const STALE_ATTESTATION_VERSION = 'consent_attestation_v1';

/** What the Consent ledger says about the seeded handle at dispatch. */
type ConsentFixture = 'send_eligible' | 'stale_attestation' | 'absent';

interface SeedQueuedOutreachOptions {
  consent?: ConsentFixture;
}

async function seedQueuedOutreach(
  options: SeedQueuedOutreachOptions = {},
): Promise<QueuedOutreachFixture> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`dispatch-${uploadId}.csv`}, 1, ${checksum(uploadId)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${userId()}::uuid, NOW(), 'dispatch-test', NOW()
    )
  `;

  const contactId = randomUUID();
  const handle = `${contactId}@example.test`;
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Dispatch Candidate',
      ${handle}, ${uploadId}::uuid
    )
  `;

  const consent = options.consent ?? 'send_eligible';
  if (consent !== 'absent') {
    await sql()`
      INSERT INTO solicitation_consent (
        id, channel, normalized_handle, business_id, basis,
        attestation_version, attested_at, attested_by_user_id, source_upload_id
      ) VALUES (
        ${randomUUID()}::uuid, 'email', ${handle}, ${businessId}::uuid,
        'owner_attested',
        ${consent === 'send_eligible' ? CONSENT_ATTESTATION_VERSION : STALE_ATTESTATION_VERSION},
        NOW() - INTERVAL '1 day', ${userId()}::uuid, ${uploadId}::uuid
      )
    `;
  }

  // D8's `solicitation_batches_one_active_send_per_business` admits ONE
  // approved-and-unclosed batch per location, so every fixture retires the
  // previous one. Closing rather than halting keeps the halt latch's own case
  // (test: "no-ops when the batch is halted…") the only halted batch in play.
  await sql()`
    UPDATE solicitation_batches
    SET send_closed_at = NOW()
    WHERE business_id = ${businessId}::uuid
      AND approved_at IS NOT NULL
      AND send_closed_at IS NULL
      AND halted_at IS NULL
  `;

  // Approved, past its veto window, inside the 72h send window and already
  // dripping — `deriveBatchState` reads `sending`, which with `approved`
  // is the only pair the Dispatch gate's batch_open item lets through.
  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at,
      approved_at, approval_method, approved_by_user_id, veto_deadline_at,
      sending_started_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours',
      NOW() - INTERVAL '90 minutes', 'owner', ${userId()}::uuid,
      NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '45 minutes'
    )
  `;

  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'dispatch-fixture',
        decision: 'send',
      })},
      NOW() - INTERVAL '1 hour'
    )
  `;

  // The real assembler, not a hand-rolled string: the postal byte-match is a
  // claim about the bytes `assembleAskBody` emits, so a fixture that spelled
  // its own footer would prove the check against a shape nothing ships.
  const renderedBody = assembleAskBody(
    'Thanks for stopping by — would you mind leaving us a review?',
    { businessName: 'Dispatch Business', postalAddress: SEEDED_POSTAL_ADDRESS },
  );
  if (renderedBody === null) {
    throw new Error('fixture: assembleAskBody refused the seeded postal address');
  }

  const outreachId = await insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    renderedBody,
    deliveryStatus: 'queued',
    renderedAt: sql()`NOW() - INTERVAL '30 minutes'`,
    queuedAt: sql()`NOW() - INTERVAL '30 seconds'`,
  });

  // `aggregate_id` is the OUTREACH id here, not the batch id — that is
  // migration 091's `job_outbox_solicitation_send_inflight` contract, and it is
  // what makes one in-flight dispatch per row rather than per batch.
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.SOLICITATION_SEND}, 'solicitation_outreach',
      ${outreachId}::uuid,
      ${sql().json({ batch_id: batchId, business_id: businessId, outreach_id: outreachId })},
      'dispatched', 1, NOW()
    )
  `;

  // The **Send batch parent** the generation lane mints. The send worker looks
  // it up and NEVER creates one, so a fixture without it is not "a batch with
  // no parent" — it is the impossible state `dispatchOutreach` throws on.
  await sql().begin(async (tx) => {
    await startOrGetSolicitationSendBatchRun(tx, {
      batchId,
      accountId: accountId(),
      businessId,
      correlationId: `dispatch-fixture-${batchId}`,
    });
  });

  return { batchId, askId, outreachId, outboxId, attempt: 1, handle };
}

/**
 * The location's attested postal address, written as the all-or-nothing
 * five-column unit migration 099's CHECK requires. `null` clears the whole
 * attestation — the state gate item 6 calls `no_postal_address`.
 *
 * The digest is computed IN SQL from the same bytes, exactly as
 * `attestPostalAddress` does: `businesses_solicitation_postal_address_digest`
 * binds the two together, so a fabricated checksum is rejected. That writer
 * itself is not reused because it also runs `lintPostalAddress`, which
 * NORMALIZES the address — and this suite's whole subject is whether the stored
 * body still byte-matches the stored column.
 */
async function setAttestedPostalAddress(address: string | null): Promise<void> {
  const clearing = address === null;
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = ${address},
        solicitation_postal_address_attested_at =
          ${clearing ? null : sql()`NOW() - INTERVAL '7 days'`},
        solicitation_postal_address_attested_by_user_id =
          ${clearing ? null : userId()}::uuid,
        solicitation_postal_address_attestation_version =
          ${clearing ? null : POSTAL_ADDRESS_ATTESTATION_VERSION},
        solicitation_postal_address_attested_digest =
          ${clearing
            ? null
            : sql()`encode(sha256(convert_to(${address}::text, 'UTF8')), 'hex')`}
    WHERE id = ${businessId}::uuid
      AND account_id = ${accountId()}::uuid
  `;
}

/**
 * One ACCOUNT-scoped Suppression ledger row for the handle. Account scope, not
 * global, for a teardown reason as much as a domain one: a `global` row carries
 * no `account_id`, so this suite could never clean one up (see `afterAll`).
 * `owner_manual` is the only source the §3.1 source→scope CHECK pairs with
 * `account`.
 */
async function seedAccountSuppression(handle: string): Promise<void> {
  await sql()`
    INSERT INTO solicitation_suppressions (
      id, channel, normalized_handle, scope, account_id, source, created_by_user_id
    ) VALUES (
      ${randomUUID()}::uuid, 'email', ${handle}, 'account',
      ${accountId()}::uuid, 'owner_manual', ${userId()}::uuid
    )
  `;
}

interface OutreachLifecycleRow {
  delivery_status: string;
  disposition_reason: string | null;
  sending_at: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  agent_run_id: string | null;
  consent_basis: string | null;
  consent_attestation_version: string | null;
  consent_row_id: string | null;
  moderation_status: string;
}

async function readOutreach(outreachId: string): Promise<OutreachLifecycleRow> {
  const [row] = await sql()<OutreachLifecycleRow[]>`
    SELECT delivery_status, disposition_reason,
           sending_at::text AS sending_at, sent_at::text AS sent_at,
           provider_message_id, agent_run_id,
           consent_basis, consent_attestation_version, consent_row_id,
           moderation_status
    FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`seeded outreach row ${outreachId} vanished`);
  return row;
}

interface ChildRunRow {
  kind: string;
  status: string;
  step_keys: string[];
}

/** The **Lazy child** the dispatch attempt created, with its step vocabulary. */
async function readChildRun(runId: string): Promise<ChildRunRow> {
  const [row] = await sql()<ChildRunRow[]>`
    SELECT run.kind, run.status,
           COALESCE(
             ARRAY(
               SELECT step.step_key FROM agent_run_steps step
               WHERE step.agent_run_id = run.id
               ORDER BY step.step_index
             ),
             ARRAY[]::text[]
           ) AS step_keys
    FROM agent_runs run
    WHERE run.id = ${runId}::uuid
      AND run.account_id = ${accountId()}::uuid
      AND run.business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`child run ${runId} not found`);
  return row;
}

async function countAnalyticsEvents(eventKey: string): Promise<number> {
  const [row] = await sql()<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM analytics_events
    WHERE event_key = ${eventKey}
      AND event_name = 'solicitation_suppressed_at_dispatch'
      AND business_id = ${businessId}::uuid
  `;
  return row?.total ?? 0;
}

interface OutboxLifecycleRow {
  status: string;
  completed_at: string | null;
}

async function readOutbox(outboxId: string): Promise<OutboxLifecycleRow> {
  const [row] = await sql()<OutboxLifecycleRow[]>`
    SELECT status, completed_at::text AS completed_at
    FROM job_outbox
    WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`seeded outbox row ${outboxId} vanished`);
  return row;
}

/** Runs the body with `SOLICITATION_SEND_ENABLED` off, restoring whatever the
 *  environment carried before — `.env.local` really is read off disk here. */
async function withSendFlagOff(run: () => Promise<void>): Promise<void> {
  const previous = process.env.SOLICITATION_SEND_ENABLED;
  delete process.env.SOLICITATION_SEND_ENABLED;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
    else process.env.SOLICITATION_SEND_ENABLED = previous;
  }
}

/** The inverse, for every case whose subject is a gate item AFTER `send_flag`:
 *  with the flag off, `dispatchOutreach` defers above tx1 and no item below it
 *  is ever evaluated. `readFlag` is not memoized, so this really does toggle. */
async function withSendFlagOn(run: () => Promise<void>): Promise<void> {
  const previous = process.env.SOLICITATION_SEND_ENABLED;
  process.env.SOLICITATION_SEND_ENABLED = 'true';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
    else process.env.SOLICITATION_SEND_ENABLED = previous;
  }
}

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
          // The suppression-at-dispatch signal. Deleted before agent_runs only
          // for readability — analytics_events has no FK to a run.
          await db`DELETE FROM analytics_events WHERE business_id = ${businessId}::uuid`;
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
      it('withholds with no_postal_address when the location has no Attested postal address', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-no-postal-address',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('no_postal_address');
        // A withhold is not a send: nothing reached the wire.
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // Step 3's writer. The consent snapshot is stamped from the ledger row
        // read under the lock, so "which consent covered this attempt" stops
        // being a guess the moment the attempt is decided.
        expect(row.consent_basis).toBe('owner_attested');
        expect(row.consent_attestation_version).toBe(CONSENT_ATTESTATION_VERSION);
        expect(row.consent_row_id).not.toBeNull();

        // Decision 7 + 8: the Lazy child is created HERE and a correct
        // withhold terminalizes it `completed`, not `failed`.
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.kind).toBe('solicitation_ask');
        expect(child.status).toBe('completed');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // The outbox attempt is spent by the domain, never by the handler.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
      });

      it('withholds with postal_address_mismatch when the stored footer no longer byte-matches', async () => {
        const fixture = await seedQueuedOutreach();
        // The owner corrects their address AFTER approval. The stored bytes are
        // the contract, so the footer the recipient would see now names an
        // address the business no longer attests to — present, but not a match.
        await setAttestedPostalAddress('1600 Pennsylvania Ave NW\nWashington, DC 20500');

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-postal-mismatch',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        // Present-but-mismatched and absent are DIFFERENT facts: only the
        // reason tells the owner which one they have to fix.
        expect(row.disposition_reason).toBe('postal_address_mismatch');
        expect(row.sent_at).toBeNull();
      });

      it('withholds with suppressed and emits solicitation_suppressed_at_dispatch when the handle is on the Suppression ledger', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // The opt-out lands AFTER the owner approved the batch — the exact
        // window §4.4 says this signal exists to measure.
        await seedAccountSuppression(fixture.handle);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-suppressed',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('suppressed');
        expect(row.sent_at).toBeNull();

        // Keyed on the Outreach row, so the count is one per dispatch attempt
        // and a replay drops on ON CONFLICT (event_key).
        expect(
          await countAnalyticsEvents(
            `solicitation_suppressed_at_dispatch:${fixture.outreachId}`,
          ),
        ).toBe(1);
      });

      it('withholds with no_consent when the consent row is missing or its attestation version is not send-eligible', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        const missing = await seedQueuedOutreach({ consent: 'absent' });
        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: missing.batchId,
            businessId,
            outreachId: missing.outreachId,
            outboxHandle: { outboxId: missing.outboxId, attempt: missing.attempt },
            correlationId: 'dispatch-no-consent-missing',
          });
        });

        const missingRow = await readOutreach(missing.outreachId);
        expect(missingRow.delivery_status).toBe('withheld');
        expect(missingRow.disposition_reason).toBe('no_consent');
        // No ledger row means the snapshot records exactly that.
        expect(missingRow.consent_basis).toBeNull();
        expect(missingRow.consent_row_id).toBeNull();

        // A row EXISTS here — the gate is a membership test against
        // SEND_ELIGIBLE_ATTESTATION_VERSIONS, never a "not v1" test, so a
        // future v3 that has not been added to that list refuses the same way.
        const stale = await seedQueuedOutreach({ consent: 'stale_attestation' });
        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: stale.batchId,
            businessId,
            outreachId: stale.outreachId,
            outboxHandle: { outboxId: stale.outboxId, attempt: stale.attempt },
            correlationId: 'dispatch-no-consent-stale',
          });
        });

        const staleRow = await readOutreach(stale.outreachId);
        expect(staleRow.delivery_status).toBe('withheld');
        expect(staleRow.disposition_reason).toBe('no_consent');
        // The snapshot still records what the ledger said — the refusal is the
        // gate's verdict about that row, not an absence of one.
        expect(staleRow.consent_attestation_version).toBe(STALE_ATTESTATION_VERSION);
      });
      it.todo('withholds with lint_failed when the stored bytes fail the current ASK_LINT_VERSION');
      // Decision 6 / amendment B1: the dispatch verdict NEVER overwrites the
      // render's `moderation_status` or `moderation_detail` — those columns are
      // render provenance. The withheld reason is the only thing that moves.
      it.todo('withholds with moderation_high and leaves the render moderation_status untouched');
      // Decision 5: flag-off is a DEFER, not a withhold. 091/110 have no
      // `flag_off` reason and inventing one terminalizes a row the owner still
      // owns; the row stays `queued` and #900's producer re-drips it.
      it('defers a queued Outreach row without terminalizing it when SOLICITATION_SEND_ENABLED is off', async () => {
        const fixture = await seedQueuedOutreach();

        await withSendFlagOff(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-flag-off',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        // `queued` and nothing else: a deferred row is one #900 re-drips, so
        // every terminal fact must be absent, not merely "not withheld".
        expect(row.delivery_status).toBe('queued');
        expect(row.disposition_reason).toBeNull();
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
      });
      // The Halt latch cancels `rendered` and `queued` rows, never `sending`.
      // A job that arrives after the sweep finds a `cancelled` row and must do
      // nothing at all — not re-gate it, not re-terminalize it.
      it('no-ops when the batch is halted and the Outreach row is already cancelled', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // The Halt latch, as it actually lands: the batch latches and the sweep
        // cancels every `rendered`/`queued` row (never `sending`) in one act.
        await sql()`
          UPDATE solicitation_batches
          SET halted_at = NOW(), halt_reason = 'owner_halt',
              halted_by = ${userId()}::uuid
          WHERE id = ${fixture.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;
        await sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'cancelled', disposition_reason = 'owner_halt'
          WHERE id = ${fixture.outreachId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-halted-cancelled',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        // Untouched in every dimension: not re-gated, not re-terminalized, and
        // no consent snapshot — the sweep already wrote every terminal fact.
        expect(row.delivery_status).toBe('cancelled');
        expect(row.disposition_reason).toBe('owner_halt');
        expect(row.consent_basis).toBeNull();
        expect(row.consent_row_id).toBeNull();
        expect(row.agent_run_id).toBeNull();
        expect(row.sent_at).toBeNull();

        // The attempt is still spent, or the watchdog re-pends a row that has
        // nothing left to do.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
        expect(outbox.completed_at).not.toBeNull();
      });
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
      it('ignores a stale outbox attempt and does not call the Messaging adapter', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            // The watchdog re-dispatched this row; the seeded outbox attempt is
            // 1, so attempt 2 is the ONLY owner and this job is the loser of
            // that race arriving late.
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt + 1 },
            correlationId: 'dispatch-stale-attempt',
          });
        });

        // The Messaging adapter is not reachable from a stale attempt because
        // the guard is the FIRST statement in tx1 — before the batch lock,
        // before the gate, before anything that could send. What a live DB can
        // witness is the whole state that would have moved on the way there,
        // and none of it did.
        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('queued');
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();
        expect(row.consent_basis).toBeNull();
        expect(row.agent_run_id).toBeNull();

        // And the newer attempt's outbox row is left alone: completing it here
        // would strand the attempt that actually owns this work.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('dispatched');
        expect(outbox.completed_at).toBeNull();
      });
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
      it('completes the outbox attempt when deferring on a flag-off so the watchdog does not re-pend it', async () => {
        const fixture = await seedQueuedOutreach();

        await withSendFlagOff(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-flag-off-outbox',
          });
        });

        const row = await readOutbox(fixture.outboxId);
        // `completed`, not any in-flight status: the watchdog reclaims
        // ('pending', 'dispatching', 'dispatched'), so a defer that left the
        // row in that set would be re-dispatched every stale window forever.
        expect(row.status).toBe('completed');
        expect(row.completed_at).not.toBeNull();
      });
      // The Halt latch deliberately excludes `sending`. A halt that lands after
      // the CAS must leave the in-flight child alone; cancelling it would
      // terminalize a run whose message is already on the wire.
      it.todo('does not cancel an in-flight sending child when a halt lands after the CAS');
    });
  },
);
