// Live-Postgres suite for the ArchivalPoller body-redaction arm (#624 T6).
//
// The unit suite pins the query's shape against a mock sql; only a real schema
// can prove the thing body redaction actually promises: the rendered subject
// and body are gone, `body_redacted_at` is stamped, the metadata row survives,
// and the write satisfies `solicitation_outreach_body_presence` — the CHECK
// that makes "redacted implies sent, and bodies are paired" a schema fact
// rather than a convention. A mock can assert none of that.
//
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and this
// file asserts it with assertSchemaReady (#573). It holds the cross-process
// live-DB lock because `runArchival` is a GLOBAL retention sweep — every arm
// prunes rows platform-wide by age, so a live-DB writer in another vitest
// process could have its aged fixtures collected mid-test.
//
// Every timestamp is written as a SQL interval off NOW(), never as a JS `Date`:
// postgres.js truncates timestamptz microseconds, so a JS-derived `sent_at`
// compared against a SQL-derived retention boundary can mis-order by <1ms — and
// the window boundary is exactly what these cases are about.
//
// The poller reads the module-level `sql` singleton from @/lib/db/server, which
// binds DATABASE_POOL_URL at import time — so both it and the singleton are
// imported DYNAMICALLY, after beforeAll points that variable at the test DB.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Sql } from 'postgres';
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
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  checksum,
  insertOutreach,
  OUTREACH_BODY,
  OUTREACH_SUBJECT,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { createWorkerLogger, type WorkerLogger } from '@/lib/shared/logger';

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();

let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let appSql: Sql | undefined;
let runArchival: ((logger: WorkerLogger) => Promise<void>) | undefined;

function sql(): Sql {
  if (!appSql) throw new Error('archival integration database was not initialized');
  return appSql;
}

function accountId(): string {
  if (!tenant) throw new Error('archival integration tenant was not seeded');
  return tenant.accountId;
}

function runOneArchivalCycle(): Promise<void> {
  if (!runArchival) throw new Error('archival integration poller was not imported');
  return runArchival(createWorkerLogger('[ArchivalPollerIntegration]'));
}

const SUBJECT = OUTREACH_SUBJECT;
const BODY = OUTREACH_BODY;

/**
 * The four terminal statuses that never carry `sent_at`, each with a reason
 * 091's status/reason CHECK accepts. Before #636 none of them was redactable
 * OR sweepable — the constraint made the stamp unrepresentable and the sweep
 * keyed on a column that is NULL on all four.
 *
 * `dispatched` splits them by whether a send was ever attempted: `withheld` and
 * `cancelled` are decided before dispatch and carry no lifecycle stamps, while
 * `failed` and `unknown` are provider outcomes and carry queued/sending. Both
 * shapes go through the same sweep, and seeding only one would leave half the
 * class unproven.
 */
const UNSENT_TERMINALS = [
  { deliveryStatus: 'withheld', dispositionReason: 'suppressed', dispatched: false },
  { deliveryStatus: 'cancelled', dispositionReason: 'owner_veto', dispatched: false },
  { deliveryStatus: 'failed', dispositionReason: 'send_failed', dispatched: true },
  { deliveryStatus: 'unknown', dispositionReason: 'send_indeterminate', dispatched: true },
] as const;

/**
 * The source the body was rendered FROM. Both members are third-party PII the
 * business gave us about its customer, which is why redacting only the rendered
 * prose would delete the sentence and keep the sentence's ingredients.
 */
const INTERPOLATION_INPUTS = {
  contact_first_name: 'Dana',
  visit_note: 'Came in for a brake inspection on the 4th.',
  template_id: 'solicitation_ask_v1',
} as const;

/**
 * The upload → contact → batch → ask chain one Outreach row hangs off. Per-row
 * because both `solicitation_outreach_one_live_per_ask` and
 * `solicitation_outreach_ask_attempt_uniq` are scoped to a single ask.
 *
 * The batch is seeded already CLOSED, which is both realistic for one 400 days
 * old and required: `solicitation_batches_one_active_send_per_business` (D8)
 * admits exactly one approved-and-unclosed batch per Business, so a case
 * seeding two rows would collide on that unique instead of testing the sweep.
 */
async function seedChain(): Promise<{ batchId: string; askId: string; contactId: string }> {
  const uploadId = randomUUID();
  const batchId = randomUUID();
  const contactId = randomUUID();
  const askId = randomUUID();

  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`archival-${uploadId}.csv`}, 1, ${checksum(uploadId)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), 'archival-redaction-test', NOW()
    )
  `;
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Redaction Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at,
      built_at, approved_at, approval_method, sending_started_at, send_closed_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '400 days',
      NOW() - INTERVAL '399 days', NOW() - INTERVAL '399 days',
      'auto_policy', NOW() - INTERVAL '399 days', NOW() - INTERVAL '398 days'
    )
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send',
      ${sql().json({ contact_id: contactId, policy_version: 'archival-fixture', decision: 'send' })},
      NOW() - INTERVAL '399 days'
    )
  `;
  return { batchId, askId, contactId };
}

interface SeedOutreachOptions {
  deliveryStatus?: string;
  dispositionReason?: string | null;
  /** Give the row the lifecycle stamps of an attempted dispatch. */
  dispatched?: boolean;
}

/**
 * One Outreach row aged `agedBy` before NOW(), on its own chain.
 *
 * `agedBy` sets `rendered_at` and, for a `sent` row, `sent_at` — the two
 * columns the two sweep arms key on, so one knob moves whichever clock the
 * case is about. Every stamp is a SQL interval off NOW() rather than a JS
 * `Date`: postgres.js truncates timestamptz microseconds, so a JS-derived
 * timestamp compared against a SQL-derived retention boundary can mis-order by
 * under a millisecond — and the boundary is exactly what these cases test.
 */
async function seedOutreach(
  agedBy: string,
  options: SeedOutreachOptions = {},
): Promise<string> {
  const { batchId, askId, contactId } = await seedChain();
  const deliveryStatus = options.deliveryStatus ?? 'sent';
  const isSent = deliveryStatus === 'sent';
  const dispatched = options.dispatched ?? isSent;
  const isLive = deliveryStatus === 'rendered';

  return insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    deliveryStatus,
    dispositionReason: options.dispositionReason ?? null,
    interpolationInputs: INTERPOLATION_INPUTS,
    renderedAt: sql()`NOW() - ${agedBy}::interval`,
    // A `rendered` row may carry NO dispatch stamps at all (091), which is what
    // makes it the case where an age-only sweep would do the damage.
    queuedAt: dispatched && !isLive ? sql()`NOW() - ${agedBy}::interval - INTERVAL '2 seconds'` : null,
    sendingAt: dispatched && !isLive ? sql()`NOW() - ${agedBy}::interval - INTERVAL '1 second'` : null,
    sentAt: isSent ? sql()`NOW() - ${agedBy}::interval` : null,
  });
}

/** The pre-#636 fixture, kept as the name the sent-arm cases read best under. */
const seedSentOutreach = (sentAgo: string): Promise<string> => seedOutreach(sentAgo);

interface OutreachBodyRow {
  rendered_subject: string | null;
  rendered_body: string | null;
  body_redacted_at: string | null;
  sent_at: string | null;
  delivery_status: string;
  // Read as ::text so the assertion compares the stored document itself rather
  // than whatever postgres.js decoded — the same reason every timestamp here is
  // read as text.
  interpolation_inputs: string;
}

async function readOutreach(outreachId: string): Promise<OutreachBodyRow> {
  const [row] = await sql()<OutreachBodyRow[]>`
    SELECT rendered_subject, rendered_body,
           body_redacted_at::text AS body_redacted_at,
           sent_at::text AS sent_at,
           delivery_status,
           interpolation_inputs::text AS interpolation_inputs
    FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`seeded outreach row ${outreachId} disappeared`);
  return row;
}

describeWithDb(
  'ArchivalPoller body redaction against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);

      // The app `sql` singleton binds DATABASE_POOL_URL at import, and the
      // poller reads that singleton — so point it here, then import both
      // dynamically. The suite seeds through the SAME client the poller uses.
      process.env.DATABASE_POOL_URL = databaseUrl;
      const dbModule = await import('@/lib/db/server');
      appSql = dbModule.sql as unknown as Sql;
      const pollerModule = await import('../ArchivalPoller');
      runArchival = pollerModule.runArchival;

      await assertSchemaReady(sql(), [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
      ]);
      tenant = await seedTenantAccount(sql(), {
        userName: 'Archival Redaction Owner',
        accountDisplayName: 'Archival Redaction Account',
      });
      await sql()`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Archival Redaction Business', 'Redaction Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
    }, 30_000);

    afterAll(async () => {
      try {
        if (appSql) {
          await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(sql(), tenant);
        }
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, 120_000);

    it('ArchivalPoller redacts outreach bodies past the retention window and stamps body_redacted_at', async () => {
      const outreachId = await seedSentOutreach('91 days');

      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(row.rendered_subject).toBeNull();
      expect(row.rendered_body).toBeNull();
      expect(row.body_redacted_at).not.toBeNull();
      // The source the body was rendered from goes with it. Nulling only the
      // prose would delete the sentence and keep contact_first_name and
      // visit_note — the third-party PII the sentence was assembled from — which
      // is not the data minimization CONTEXT.md's Body redaction entry promises.
      expect(JSON.parse(row.interpolation_inputs)).toEqual({});
      // Redaction is not a delete: the metadata row and its send proof stay.
      expect(row.sent_at).not.toBeNull();
    });

    it('ArchivalPoller leaves an outreach body inside the retention window untouched', async () => {
      const outreachId = await seedSentOutreach('89 days');

      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(row.rendered_subject).toBe(SUBJECT);
      expect(row.rendered_body).toBe(BODY);
      expect(row.body_redacted_at).toBeNull();
      // The window is one boundary for both halves — a row that keeps its body
      // keeps the inputs, so the erasure above is the sweep acting and not the
      // fixture having been empty all along.
      expect(JSON.parse(row.interpolation_inputs)).toEqual(INTERPOLATION_INPUTS);
    });

    it('ArchivalPoller redaction is idempotent — a second cycle does not re-stamp an already-redacted row', async () => {
      const outreachId = await seedSentOutreach('120 days');

      await runOneArchivalCycle();
      const firstStamp = (await readOutreach(outreachId)).body_redacted_at;
      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(firstStamp).not.toBeNull();
      expect(row.body_redacted_at).toBe(firstStamp);
    });

    // ── Terminal rows that never sent (#636) ─────────────────────────────
    //
    // The arm above is reachable only by `sent` rows: migration 091 makes
    // `sent_at IS NOT NULL` equivalent to `delivery_status = 'sent'`, so a
    // `withheld`/`cancelled`/`failed`/`unknown` row could neither be selected
    // by a sweep keyed on `sent_at` nor legally carry `body_redacted_at` at
    // all. Both halves kept their bodies AND their `interpolation_inputs`
    // forever. `unknown` is the sharp one — the provider never confirmed, so
    // the message may well have been delivered.

    it.each(UNSENT_TERMINALS)(
      'ArchivalPoller redacts an aged $deliveryStatus row that never sent',
      async ({ deliveryStatus, dispositionReason, dispatched }) => {
        const outreachId = await seedOutreach('91 days', {
          deliveryStatus,
          dispositionReason,
          dispatched,
        });

        await runOneArchivalCycle();

        const row = await readOutreach(outreachId);
        expect(row.rendered_subject).toBeNull();
        expect(row.rendered_body).toBeNull();
        expect(row.body_redacted_at).not.toBeNull();
        // The source goes with the prose — contact_first_name and visit_note
        // are the PII the sentence was assembled from.
        expect(JSON.parse(row.interpolation_inputs)).toEqual({});
        // Redaction is not a delete, and it does not invent a send: the
        // disposition survives and `sent_at` stays NULL.
        expect(row.delivery_status).toBe(deliveryStatus);
        expect(row.sent_at).toBeNull();
      },
    );

    it('ArchivalPoller leaves a never-sent terminal row inside the retention window untouched', async () => {
      const outreachId = await seedOutreach('89 days', {
        deliveryStatus: 'cancelled',
        dispositionReason: 'owner_veto',
      });

      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(row.rendered_subject).toBe(SUBJECT);
      expect(row.rendered_body).toBe(BODY);
      expect(row.body_redacted_at).toBeNull();
      // Same boundary for both halves, so the erasure above is the sweep acting
      // and not the fixture having been empty all along.
      expect(JSON.parse(row.interpolation_inputs)).toEqual(INTERPOLATION_INPUTS);
    });

    it('ArchivalPoller never redacts a LIVE row, however old it is', async () => {
      // The reason the new arm filters on status rather than age alone. A
      // bodyless `rendered` row can neither send nor settle, and wedges its
      // whole batch behind `solicitation_outreach_one_live_per_ask` — so age
      // must not be a licence. 400 days is far past every window in the poller.
      const outreachId = await seedOutreach('400 days', { deliveryStatus: 'rendered' });

      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(row.rendered_subject).toBe(SUBJECT);
      expect(row.rendered_body).toBe(BODY);
      expect(row.body_redacted_at).toBeNull();
      expect(JSON.parse(row.interpolation_inputs)).toEqual(INTERPOLATION_INPUTS);
    });

    it('ArchivalPoller never-sent redaction is idempotent', async () => {
      const outreachId = await seedOutreach('120 days', {
        deliveryStatus: 'unknown',
        dispositionReason: 'send_indeterminate',
        dispatched: true,
      });

      await runOneArchivalCycle();
      const firstStamp = (await readOutreach(outreachId)).body_redacted_at;
      await runOneArchivalCycle();

      const row = await readOutreach(outreachId);
      expect(firstStamp).not.toBeNull();
      expect(row.body_redacted_at).toBe(firstStamp);
    });

    it('ArchivalPoller sweeps both clocks in one cycle', async () => {
      // Two arms, one pass. A sent row ages from `sent_at` and a never-sent one
      // from `rendered_at`; if either arm were dropped or shadowed by the other
      // this is the case that catches it, since a single cycle has to clear
      // both.
      const sentId = await seedSentOutreach('91 days');
      const cancelledId = await seedOutreach('91 days', {
        deliveryStatus: 'cancelled',
        dispositionReason: 'batch_expired',
      });

      await runOneArchivalCycle();

      expect((await readOutreach(sentId)).body_redacted_at).not.toBeNull();
      expect((await readOutreach(cancelledId)).body_redacted_at).not.toBeNull();
    });
  },
);
