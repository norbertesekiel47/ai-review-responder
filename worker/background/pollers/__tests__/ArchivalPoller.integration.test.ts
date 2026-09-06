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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
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
  type SchemaRequirement,
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

/**
 * #1009: the Refusal ledger's retention arm. Declared locally rather than added
 * to `schema-ready.ts` — that helper lives outside this branch's
 * `allowed_edit_surface`, and #1008's own 116 suite declares its requirement
 * inline for the same reason.
 */
const MIGRATION_116_REFUSAL_EVENTS: SchemaRequirement = {
  migration: '116_refusal_events',
  tables: ['refusal_events'],
  indexes: ['idx_refusal_events_archival'],
};

const ARCHIVAL_INDEX = 'idx_refusal_events_archival';
const POLLER_SOURCE_FILE = 'worker/background/pollers/ArchivalPoller.ts';
/** The per-arm claim limit every arm shares; a cycle at it is `saturated`. */
const BATCH_LIMIT = 5000;

let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let appSql: Sql | undefined;
let runArchival: ((logger: WorkerLogger) => Promise<void>) | undefined;
let refusalRetentionDays: number | undefined;

function sql(): Sql {
  if (!appSql) throw new Error('archival integration database was not initialized');
  return appSql;
}

function accountId(): string {
  if (!tenant) throw new Error('archival integration tenant was not seeded');
  return tenant.accountId;
}

function runOneArchivalCycle(logger?: WorkerLogger): Promise<void> {
  if (!runArchival) throw new Error('archival integration poller was not imported');
  return runArchival(logger ?? createWorkerLogger('[ArchivalPollerIntegration]'));
}

/** The 180-day Refusal-ledger window, captured off the dynamic poller import. */
function retentionDays(): number {
  if (refusalRetentionDays === undefined) {
    throw new Error('ArchivalPoller does not export REFUSAL_LEDGER_RETENTION_DAYS');
  }
  return refusalRetentionDays;
}

/**
 * One Refusal, aged on BOTH clocks independently.
 *
 * `created_at` is `DEFAULT NOW()`, so a fixture that wants the two clocks to
 * DISAGREE has to write it explicitly — which is the whole of title 23. This is
 * an INSERT with explicit columns and never DDL (`ci:live-db-suites` R2).
 *
 * Every stamp is a SQL interval off NOW() rather than a JS `Date`: postgres.js
 * truncates timestamptz microseconds, so a JS-derived timestamp compared
 * against a SQL-derived retention boundary can mis-order by under a
 * millisecond — and the boundary is exactly what these cases are about.
 */
async function seedRefusal(occurredDaysAgo: number, createdDaysAgo = 0): Promise<string> {
  const id = randomUUID();
  await sql()`
    INSERT INTO refusal_events (
      id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
      refusal_category, vocabulary_version, subject_type, subject_id,
      occurred_at, created_at
    ) VALUES (
      ${id}::uuid, ${accountId()}::uuid, NULL,
      'autonomy_suspended', 'judge_flag', NULL,
      'autonomy_paused', 'archival-retention-fixture', NULL, NULL,
      NOW() - make_interval(days => ${occurredDaysAgo}),
      NOW() - make_interval(days => ${createdDaysAgo})
    )
  `;
  return id;
}

/** `count` aged Refusals in ONE statement — the saturation fixture. */
async function seedAgedRefusals(count: number, occurredDaysAgo: number): Promise<void> {
  await sql()`
    INSERT INTO refusal_events (
      id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
      refusal_category, vocabulary_version, subject_type, subject_id, occurred_at
    )
    SELECT gen_random_uuid(), ${accountId()}::uuid, NULL,
           'autonomy_suspended', 'judge_flag', NULL,
           'autonomy_paused', 'archival-saturation-fixture', NULL, NULL,
           NOW() - make_interval(days => ${occurredDaysAgo}) - make_interval(secs => series)
      FROM generate_series(1, ${count}) AS series
  `;
}

async function listRefusalIds(): Promise<string[]> {
  const rows = await sql()<{ id: string }[]>`
    SELECT id::text AS id FROM refusal_events WHERE account_id = ${accountId()}::uuid
  `;
  return rows.map((row) => row.id);
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
      refusalRetentionDays = pollerModule.REFUSAL_LEDGER_RETENTION_DAYS;

      await assertSchemaReady(sql(), [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
        MIGRATION_116_REFUSAL_EVENTS,
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
      await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
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
      // is not the data minimization docs/context/solicitation-send-mode-batch-and-delivery-seam.md's Body redaction entry promises.
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

    // ── #1009: the Refusal ledger's retention arm (titles 22-25) ───────────
    //
    // The eleventh arm, sharing the ten existing arms' single try/catch — which
    // is why it could not ride slice 1 and why #1009 is gated on migration
    // 116's PROMOTION rather than its merge.

    it('the refusal_events arm deletes rows older than REFUSAL_LEDGER_RETENTION_DAYS and keeps rows inside the window', async () => {
      // 180, matching AGENT_SPINE_RETENTION_DAYS so one number governs the whole
      // agentic domain (#996). A code constant, deliberately not an env var, so
      // it carries no registry rows.
      expect(retentionDays()).toBe(180);

      const aged = await seedRefusal(retentionDays() + 20);
      const fresh = await seedRefusal(retentionDays() - 20);

      await runOneArchivalCycle();

      const survivors = await listRefusalIds();
      expect(survivors).not.toContain(aged);
      expect(survivors).toContain(fresh);
    });

    it('the refusal_events arm keys on occurred_at, so a fresh occurred_at with an old created_at survives and the reverse is deleted', async () => {
      // CROSSED CLOCKS, and this is not optional. A plain old-row/fresh-row pair
      // ages both timestamps together, so it returns the identical answer under
      // an `occurred_at` sweep and a `created_at` sweep — the case above alone
      // cannot kill the wrong clock. Only rows whose two clocks DISAGREE can.
      //
      // `occurred_at` is the DECISION time and the ONE retention clock (#996);
      // `created_at` is the insert stamp and its own column comment says it is
      // explicitly not a retention candidate.
      const decidedLongAgoInsertedToday = await seedRefusal(retentionDays() + 20, 0);
      const decidedTodayInsertedLongAgo = await seedRefusal(0, retentionDays() + 20);

      await runOneArchivalCycle();

      const survivors = await listRefusalIds();
      expect(survivors).not.toContain(decidedLongAgoInsertedToday);
      expect(survivors).toContain(decidedTodayInsertedLongAgo);
    });

    it('the refusal_events arm orders by (occurred_at, id) so the sweep matches idx_refusal_events_archival', async () => {
      // The index as the DATABASE has it, not as a comment claims it.
      const [index] = await sql()<{ definition: string }[]>`
        SELECT indexdef AS definition FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = ${ARCHIVAL_INDEX}
      `;
      expect(index, `${ARCHIVAL_INDEX} is absent`).toBeDefined();
      const keyColumns = /USING btree \(([^)]*)\)/.exec(index!.definition)?.[1];
      expect(keyColumns, `could not read ${ARCHIVAL_INDEX}'s key columns`).toBeDefined();

      const pollerSource = readFileSync(join(process.cwd(), POLLER_SOURCE_FILE), 'utf8');
      // Capture the WHOLE candidates CTE — up to the `deleted AS (` that closes
      // it — not merely up to the first `LIMIT`. An earlier draft stopped at the
      // limit keyword, which made every clause written after it invisible here
      // and pushed arm 11's `FOR UPDATE SKIP LOCKED` in front of its `LIMIT`
      // purely to stay inside the capture. A test's parser must never dictate
      // the shape of production SQL; widening the capture is the fix, so the arm
      // is free to be ordered however it reads best beside its ten siblings.
      const arm = /SELECT id FROM refusal_events([\s\S]*?)\)\s*,\s*deleted AS \(/
        .exec(pollerSource)?.[1];
      expect(arm, `${POLLER_SOURCE_FILE} has no refusal_events retention arm`).toBeDefined();
      const armSql = arm!.replace(/\s+/g, ' ').trim();

      // Without an ORDER BY that MATCHES an index the sweep is unbounded — arms
      // 9 and 10 state the rule, and this derives the expectation from the live
      // index rather than restating it.
      expect(armSql).toContain(`ORDER BY ${keyColumns}`);
      expect(keyColumns).toBe('occurred_at, id');

      // `occurred_at` and nothing else. A sweep keyed on the insert stamp would
      // pass the window case above and delete the wrong rows in production.
      expect(armSql).toContain('occurred_at <');
      expect(armSql).not.toContain('created_at');

      // Same concurrent-cycle count-accuracy contract as every sibling arm, and
      // the same batch bound. Both are now inside the capture regardless of the
      // order they are written in, which is the point of widening it.
      expect(armSql).toContain('FOR UPDATE SKIP LOCKED');
      expect(armSql).toContain('LIMIT 5000');
    });

    it('the archival log line and the saturation list both carry refusal_events', async () => {
      // A full claim, so the arm reports `BATCH_LIMIT` and the cycle saturates.
      // Both halves are observed from the LOGGER rather than read off the
      // poller's source, because what the intake promises is the operator's
      // view: a count on the 'Archived' line, and the table named when a cycle
      // hits the limit and more rows remain.
      await seedAgedRefusals(BATCH_LIMIT, retentionDays() + 20);

      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await runOneArchivalCycle(logger as unknown as WorkerLogger);

      // The ten arms share ONE try/catch, so a broken eleventh arm shows up as a
      // swallowed 'Archival cycle failed' rather than a failed assertion.
      expect(logger.error).not.toHaveBeenCalled();

      const archived = logger.log.mock.calls.find((call) => call[0] === 'Archived');
      expect(archived, "the cycle logged no 'Archived' line").toBeDefined();
      expect(archived![1]).toMatchObject({ refusal_events: BATCH_LIMIT });

      const saturation = logger.warn.mock.calls.find((call) =>
        String(call[0]).includes('Batch limit reached'));
      expect(saturation, 'the cycle logged no batch-limit warning').toBeDefined();
      // The sanitizer drops array values, so the poller joins the names into a
      // string — assert on that string, not on an array.
      const targets = (saturation![1] as { saturated_targets?: unknown }).saturated_targets;
      expect(String(targets)).toContain('refusal_events');
    }, 120_000);
  },
);
