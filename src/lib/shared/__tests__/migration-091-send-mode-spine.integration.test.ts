import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';

// Shape suite for migration 091 — send-mode spine lifecycle + physical fan-out
// primitives (#624).
//
// This is a migration-SHAPE suite, so it holds the cross-process live-DB lock,
// but it applies NO migration SQL: `pnpm test:db:setup` provisions to head and
// this file ASSERTS (assertSchemaReady) then exercises behaviour. Run-time DDL
// takes ACCESS EXCLUSIVE locks that deadlock sibling suites' row locks (#573).
// Every write is either deleted in afterEach or made inside a rolled-back
// transaction.
//
// The two things this suite is really guarding:
//
//  1. WIDENING WITHOUT REGRESSION. 091 replaces four `agent_runs` /
//     `agent_outcomes` constraints that 088 had already widened. Re-deriving
//     any of them from 071's text would silently narrow the spine back. Each
//     frozen definition below is therefore compared against ITS OWN origin —
//     071 for the two 091 never touches, 088 for the ones it supersets.
//
//  2. CHECK TOTALITY. A Postgres CHECK rejects only FALSE and PASSES on NULL,
//     which is why every multi-arm CHECK in 091 is wrapped `(… ) IS TRUE`. The
//     status/reason cases below assert the NULL side explicitly: a
//     reason-bearing status with a NULL reason must be REJECTED, not admitted.
//
// Constraint text is read with `pg_get_constraintdef` and index predicates with
// `pg_get_expr` / `pg_indexes.indexdef`. `pg_constraint.consrc` was removed in
// Postgres 12 and does not exist here.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ── Frozen definitions, each quoted from its own origin migration ────────────

/** 071. 091 does not replace it: a terminal `cancelled` row with `ended_at` set
 *  satisfies it as FALSE = FALSE, so widening the status domain needs no edit. */
const TERMINAL_CONSISTENCY_071 = "CHECK (((status = 'running'::text) = (ended_at IS NULL)))";

/** 071. `WHERE status = 'running'` never covered terminal rows, so `cancelled`
 *  is outside its predicate by construction. */
const ONE_ACTIVE_PREDICATE_071 = "(status = 'running'::text)";
const ONE_ACTIVE_COLUMNS_071 = 'btree (kind, subject_type, subject_id)';

/** 088. Both kinds 091 adds carry unit_count = 1, so "zero is legal only for
 *  solicitation_batch_built" is untouched. */
const UNIT_COUNT_CHECK_088 =
  "CHECK (((unit_count > 0) OR ((outcome_kind = 'solicitation_batch_built'::text) AND (unit_count = 0))))";

/** 088. 091 deliberately does NOT widen subject_type — `solicitation_batch` was
 *  already a member and now legitimately pairs with two kinds. */
const SUBJECT_TYPE_CHECK_088 =
  "CHECK ((subject_type = ANY (ARRAY['review'::text, 'account_week'::text, " +
  "'solicitation_batch'::text, 'solicitation_ask'::text])))";

/** 088's four pairing arms, which 091's replacement must carry forward verbatim. */
const PAIRING_ARMS_088 = [
  "((kind = 'review_handler'::text) AND (subject_type = 'review'::text))",
  "((kind = 'weekly_insights'::text) AND (subject_type = 'account_week'::text))",
  "((kind = 'solicitation_batch'::text) AND (subject_type = 'solicitation_batch'::text))",
  "((kind = 'solicitation_ask'::text) AND (subject_type = 'solicitation_ask'::text))",
] as const;

// ── Fixture ids ──────────────────────────────────────────────────────────────

const businessId = randomUUID();
const uploadId = randomUUID();
const contactId = randomUUID();
const batchId = randomUUID();
const askId = randomUUID();
const ownerAuthId = randomUUID();

const foreignBusinessId = randomUUID();
const foreignUploadId = randomUUID();
const foreignBatchId = randomUUID();

let tenant: TenantSeed | undefined;
let foreignTenant: TenantSeed | undefined;

function checksum(seed: string): string {
  return seed.replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}

/** Rolls a probing transaction back without swallowing genuine failures. */
class RollbackAfterProbe extends Error {
  constructor() {
    super('probe complete — rolling back');
    this.name = 'RollbackAfterProbe';
  }
}

interface OutreachInput {
  id?: string;
  batchId?: string;
  askId?: string;
  attemptNo?: number;
  deliveryStatus?: string;
  dispositionReason?: string | null;
  renderedSubject?: string | null;
  renderedBody?: string | null;
  bodyRedactedAt?: Date | null;
  queuedAt?: Date | null;
  sendingAt?: Date | null;
  sentAt?: Date | null;
  moderationStatus?: string;
}

/**
 * One `solicitation_outreach` row, defaulting to the shape #628 will write
 * first: a freshly rendered attempt with its bodies present and no disposition.
 * Callers override exactly the field under test, so a rejection can only come
 * from the constraint the case is about.
 */
/** Pool handle or an open transaction — the RLS case needs the latter. */
type SqlExecutor = postgresType.Sql | postgresType.TransactionSql;

function insertOutreach(
  exec: SqlExecutor,
  input: OutreachInput = {},
): Promise<unknown> {
  const hasBody = input.renderedSubject !== null;
  return exec`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id,
      attempt_no, rendered_subject, rendered_body,
      prompt_version, prompt_hash, interpolation_inputs, rendered_at,
      body_redacted_at, ask_lint_version, lint_detail,
      moderation_status, moderation_detail,
      delivery_status, disposition_reason, queued_at, sending_at, sent_at
    ) VALUES (
      ${input.id ?? randomUUID()}::uuid, ${tenant!.accountId}::uuid,
      ${businessId}::uuid, ${input.batchId ?? batchId}::uuid,
      ${input.askId ?? askId}::uuid, ${contactId}::uuid,
      ${input.attemptNo ?? 1},
      ${hasBody ? (input.renderedSubject ?? 'How did we do?') : null},
      ${hasBody ? (input.renderedBody ?? 'Would you mind leaving a review?') : null},
      'solicitation_ask_v1', ${checksum(askId)}, ${exec.json({})}, NOW(),
      ${input.bodyRedactedAt ?? null}, 'ask_lint_v1', ${exec.json({})},
      ${input.moderationStatus ?? 'clean'}, ${exec.json({})},
      ${input.deliveryStatus ?? 'rendered'}, ${input.dispositionReason ?? null},
      ${input.queuedAt ?? null}, ${input.sendingAt ?? null}, ${input.sentAt ?? null}
    )
  `;
}

/**
 * Lifecycle timestamps are given as SECONDS AFTER the row's own `created_at`,
 * never as JS `Date`s. postgres.js decodes timestamptz into a Date and silently
 * truncates Postgres microseconds, so a JS-derived `built_at` reliably lands
 * *before* the NOW()-defaulted `created_at` it must not precede — tripping
 * solicitation_batches_built_after_created for reasons that have nothing to do
 * with the constraint under test. Resolving the offsets in SQL keeps the whole
 * comparison on the database side.
 */
interface BatchLifecycleInput {
  builtAfterSec?: number | null;
  approvedAfterSec?: number | null;
  approvalMethod?: string | null;
  approvedByUserId?: string | null;
  vetoDeadlineAfterSec?: number | null;
  sendingStartedAfterSec?: number | null;
  sendClosedAfterSec?: number | null;
  haltedAfterSec?: number | null;
  haltReason?: string | null;
  haltedBy?: string | null;
}

/**
 * A second `solicitation_batches` row under the seeded business, carrying only
 * the lifecycle columns the case is about. Defaults are all NULL — the shape
 * the 088 batch-builder writes — so a rejection can only come from the
 * lifecycle CHECK under test. Cleaned up by afterEach.
 *
 * Each call mints its OWN contact_csv_uploads row: `source_upload_id` is UNIQUE
 * (088), so probes sharing the seeded upload would collide on that unique
 * instead of reaching the constraint under test.
 */
async function insertBatch(input: BatchLifecycleInput = {}): Promise<unknown> {
  const probeUploadId = randomUUID();
  await db!`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${probeUploadId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      ${`migration-091-probe-${probeUploadId}.csv`}, 1, ${checksum(probeUploadId)},
      NULL, 'completed', ${db!.json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), 'migration-091-test', NOW()
    )
  `;
  const at = (seconds: number | null | undefined) =>
    seconds == null ? null : `${seconds} seconds`;
  return db!`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at,
      approved_at, approval_method, approved_by_user_id, veto_deadline_at,
      sending_started_at, send_closed_at,
      halted_at, halt_reason, halted_by
    ) VALUES (
      ${randomUUID()}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      ${probeUploadId}::uuid, NOW(),
      NOW() + ${at(input.builtAfterSec)}::interval,
      NOW() + ${at(input.approvedAfterSec)}::interval,
      ${input.approvalMethod ?? null},
      ${input.approvedByUserId ?? null}::uuid,
      NOW() + ${at(input.vetoDeadlineAfterSec)}::interval,
      NOW() + ${at(input.sendingStartedAfterSec)}::interval,
      NOW() + ${at(input.sendClosedAfterSec)}::interval,
      NOW() + ${at(input.haltedAfterSec)}::interval,
      ${input.haltReason ?? null}, ${input.haltedBy ?? null}::uuid
    )
  `;
}

function insertRun(input: {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  status?: string;
  endedAt?: Date | null;
}): Promise<unknown> {
  // started_at is anchored a minute in the past on purpose. A JS `Date` loses
  // the microseconds postgres.js decoded it from, so a NOW()-defaulted
  // started_at can land AFTER a JS-derived ended_at and trip
  // agent_runs_ended_after_started — a failure that has nothing to do with what
  // these cases are about.
  return db!`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, started_at, ended_at, correlation_id
    ) VALUES (
      ${input.id}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      ${input.kind}, ${input.subjectType}, ${input.subjectId},
      ${input.status ?? 'running'}, NOW() - INTERVAL '1 minute',
      ${input.endedAt ?? null}, 'migration-091-shape'
    )
  `;
}

function insertPolicy(input: {
  persona: string;
  actionClass: string;
  vetoWindowMinutes: number;
  autoApproveMinStar?: number | null;
  dailySendCap?: number | null;
  dailyAutoPostCap?: number | null;
  locationId?: string | null;
}): Promise<unknown> {
  return db!`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      veto_window_minutes, auto_approve_min_star, daily_send_cap, daily_auto_post_cap
    ) VALUES (
      ${randomUUID()}::uuid, ${tenant!.accountId}::uuid,
      ${input.locationId ?? null}::uuid, ${input.persona}, ${input.actionClass},
      ${input.vetoWindowMinutes}, ${input.autoApproveMinStar ?? null},
      ${input.dailySendCap ?? null}, ${input.dailyAutoPostCap ?? null}
    )
  `;
}

async function constraintDefinition(name: string, table: string): Promise<string | undefined> {
  const [row] = await db!<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = to_regclass(${`public.${table}`}) AND conname = ${name}
  `;
  return row === undefined ? undefined : normalizeSql(row.definition);
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const [row] = await db!<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
  `;
  return row === undefined ? undefined : normalizeSql(row.indexdef);
}

describeWithDb(
  'migration 091 send-mode spine lifecycle + fan-out primitives',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Migration 091 Owner',
        accountDisplayName: 'Migration 091 Account',
      });
      foreignTenant = await seedTenantAccount(db, {
        userName: 'Migration 091 Foreign Owner',
        accountDisplayName: 'Migration 091 Foreign Account',
      });

      // owner_account_id() resolves auth.uid() -> users.auth_id, so the RLS case
      // needs a real auth identity on the seeded owner.
      await db`
        UPDATE users SET auth_id = ${ownerAuthId} WHERE id = ${tenant.userId}::uuid
      `;

      const seedBusinessTree = async (
        seed: TenantSeed,
        ids: { businessId: string; uploadId: string; batchId: string },
        label: string,
      ): Promise<void> => {
        await db!`
          INSERT INTO businesses (
            id, name, owner_name, owner_email, account_id, subscription_status, category
          ) VALUES (
            ${ids.businessId}::uuid, ${`Migration 091 ${label} Business`}, 'M091 Owner',
            ${seed.ownerEmail}, ${seed.accountId}::uuid, 'active', 'automotive'
          )
        `;
        await db!`
          INSERT INTO contact_csv_uploads (
            id, account_id, business_id, filename, byte_size, content_sha256,
            raw_csv, status, report, attested_by_user_id, attested_at,
            attestation_version, completed_at
          ) VALUES (
            ${ids.uploadId}::uuid, ${seed.accountId}::uuid, ${ids.businessId}::uuid,
            ${`migration-091-${label.toLowerCase()}.csv`}, 1, ${checksum(ids.uploadId)},
            NULL, 'completed', ${db!.json({ accepted: 1 })},
            ${seed.userId}::uuid, NOW(), 'migration-091-test', NOW()
          )
        `;
        await db!`
          INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
          VALUES (
            ${ids.batchId}::uuid, ${seed.accountId}::uuid, ${ids.businessId}::uuid,
            ${ids.uploadId}::uuid
          )
        `;
      };

      await seedBusinessTree(tenant, { businessId, uploadId, batchId }, 'Primary');
      await seedBusinessTree(
        foreignTenant,
        { businessId: foreignBusinessId, uploadId: foreignUploadId, batchId: foreignBatchId },
        'Foreign',
      );

      await db`
        INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
        VALUES (
          ${contactId}::uuid, ${businessId}::uuid, 'M091 Candidate',
          ${`${contactId}@example.test`}, ${uploadId}::uuid
        )
      `;
      await db`
        INSERT INTO solicitation_asks (
          id, account_id, business_id, batch_id, contact_id,
          status, withheld_reason, evidence, decided_at
        ) VALUES (
          ${askId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
          ${db.json({ decision: 'send' })}, NOW()
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db || !tenant) return;
      await db`DELETE FROM solicitation_outreach WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
      // Lifecycle-probe batches only — the seeded batch carries the ask fixture.
      await db`
        DELETE FROM solicitation_batches
        WHERE account_id = ${tenant.accountId}::uuid AND id <> ${batchId}::uuid
      `;
    });

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM solicitation_asks WHERE batch_id = ${batchId}::uuid`;
          await db`
            DELETE FROM solicitation_batches
            WHERE id IN (${batchId}::uuid, ${foreignBatchId}::uuid)
          `;
          await db`
            DELETE FROM contact_csv_uploads
            WHERE business_id IN (${businessId}::uuid, ${foreignBusinessId}::uuid)
          `;
          await db`
            DELETE FROM businesses
            WHERE id IN (${businessId}::uuid, ${foreignBusinessId}::uuid)
          `;
          if (tenant) await cleanupTenantAccount(db, tenant);
          if (foreignTenant) await cleanupTenantAccount(db, foreignTenant);
          await db.end({ timeout: 5 });
        }
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, 120_000);

    // ── 1. The spine constraints 091 must leave alone ────────────────────────

    it('091 leaves agent_runs_terminal_consistency and agent_runs_one_active_per_subject byte-for-byte unchanged', async () => {
      expect(await constraintDefinition('agent_runs_terminal_consistency', 'agent_runs')).toBe(
        TERMINAL_CONSISTENCY_071,
      );

      const [activeIndex] = await db!<{ predicate: string | null }[]>`
        SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE idx.relname = 'agent_runs_one_active_per_subject'
      `;
      expect(activeIndex?.predicate).toBe(ONE_ACTIVE_PREDICATE_071);
      expect(await indexDefinition('agent_runs_one_active_per_subject')).toContain(
        ONE_ACTIVE_COLUMNS_071,
      );

      // Both definitions must still MEAN what they meant, now that `cancelled`
      // exists: a cancelled run is terminal (ended_at required) and sits
      // outside the one-active predicate, so it can coexist with a running run
      // on the same subject.
      const subjectId = randomUUID();
      const runningId = randomUUID();
      await insertRun({
        id: runningId,
        kind: 'solicitation_send_batch',
        subjectType: 'solicitation_batch',
        subjectId,
      });
      await expect(
        insertRun({
          id: randomUUID(),
          kind: 'solicitation_send_batch',
          subjectType: 'solicitation_batch',
          subjectId,
          status: 'cancelled',
          endedAt: new Date(),
        }),
      ).resolves.toBeDefined();
      await expect(
        insertRun({
          id: randomUUID(),
          kind: 'solicitation_send_batch',
          subjectType: 'solicitation_batch',
          subjectId,
        }),
      ).rejects.toThrow(/agent_runs_one_active_per_subject/);
      await expect(
        insertRun({
          id: randomUUID(),
          kind: 'solicitation_send_batch',
          subjectType: 'solicitation_batch',
          subjectId: randomUUID(),
          status: 'cancelled',
          endedAt: null,
        }),
      ).rejects.toThrow(/agent_runs_terminal_consistency/);
    });

    it('091 leaves agent_outcomes_unit_count_check unchanged', async () => {
      // Frozen at 088, NOT 071 — and specifically it must not have learned the
      // two outcome kinds 091 adds, both of which carry unit_count = 1.
      const definition = await constraintDefinition(
        'agent_outcomes_unit_count_check',
        'agent_outcomes',
      );
      expect(definition).toBe(UNIT_COUNT_CHECK_088);
      expect(definition).not.toContain('solicitation_sent');
      expect(definition).not.toContain('review_attributed');

      const insertOutcome = (outcomeKind: string, unitCount: number): Promise<unknown> =>
        db!`
          INSERT INTO agent_outcomes (
            id, account_id, business_id, attributed_agent, outcome_kind, unit_count
          ) VALUES (
            ${randomUUID()}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
            'solicitation', ${outcomeKind}, ${unitCount}
          )
        `;

      // 091 widened the KIND domain …
      await expect(insertOutcome('solicitation_sent', 1)).resolves.toBeDefined();
      await expect(insertOutcome('review_attributed', 1)).resolves.toBeDefined();
      // … but zero units stays the exclusive privilege of the batch aggregate.
      await expect(insertOutcome('solicitation_sent', 0)).rejects.toThrow(
        /agent_outcomes_unit_count_check/,
      );
      await expect(insertOutcome('solicitation_batch_built', 0)).resolves.toBeDefined();
    });

    // ── 2. What 091 legitimately widens ──────────────────────────────────────

    it('091 adds cancelled to agent_runs_status_check and pairs solicitation_send_batch with the solicitation_batch subject type', async () => {
      expect(await constraintDefinition('agent_runs_status_check', 'agent_runs')).toBe(
        "CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, " +
          "'cancelled'::text, 'failed'::text])))",
      );

      // kind is a strict superset of 088's four members, in 088's order.
      expect(await constraintDefinition('agent_runs_kind_check', 'agent_runs')).toBe(
        "CHECK ((kind = ANY (ARRAY['review_handler'::text, 'weekly_insights'::text, " +
          "'solicitation_batch'::text, 'solicitation_ask'::text, " +
          "'solicitation_send_batch'::text])))",
      );

      // subject_type is untouched: the send parent reuses solicitation_batch.
      expect(await constraintDefinition('agent_runs_subject_type_check', 'agent_runs')).toBe(
        SUBJECT_TYPE_CHECK_088,
      );

      const pairing = await constraintDefinition(
        'agent_runs_kind_subject_type_pairing',
        'agent_runs',
      );
      for (const arm of PAIRING_ARMS_088) {
        expect(pairing).toContain(arm);
      }
      expect(pairing).toContain(
        "((kind = 'solicitation_send_batch'::text) AND (subject_type = 'solicitation_batch'::text))",
      );
      // A bare disjunction would pass on NULL; the wrapper is what makes it total.
      expect(pairing).toContain('IS TRUE');

      await expect(
        insertRun({
          id: randomUUID(),
          kind: 'solicitation_send_batch',
          subjectType: 'solicitation_batch',
          subjectId: randomUUID(),
          status: 'cancelled',
          endedAt: new Date(),
        }),
      ).resolves.toBeDefined();
      await expect(
        insertRun({
          id: randomUUID(),
          kind: 'solicitation_send_batch',
          subjectType: 'solicitation_ask',
          subjectId: randomUUID(),
        }),
      ).rejects.toThrow(/agent_runs_kind_subject_type_pairing/);
      // `subject_type = 'solicitation_send_batch'` has no behavioural probe:
      // any subject_type outside the pairing arms trips
      // agent_runs_kind_subject_type_pairing first, whichever kind it is paired
      // with. The exact-text comparison above is the authority for "091 did not
      // widen subject_type".
    });

    it('091 adds the solicitation_asks (id, account_id, business_id) unique that the outreach ask FK depends on', async () => {
      expect(
        await constraintDefinition(
          'solicitation_asks_account_business_id_uniq',
          'solicitation_asks',
        ),
      ).toBe('UNIQUE (id, account_id, business_id)');

      // The unique is not decorative: it is the referenced key of the outreach
      // FK, which is why 091 must add it BEFORE creating the table.
      expect(
        await constraintDefinition('solicitation_outreach_ask_tenant_fk', 'solicitation_outreach'),
      ).toContain(
        'FOREIGN KEY (ask_id, account_id, business_id) ' +
          'REFERENCES solicitation_asks(id, account_id, business_id) ON DELETE CASCADE',
      );
    });

    // ── 2b. solicitation_batches approval / halt / send lifecycle ────────────

    it('solicitation_batches rejects an approved batch with no approval method', async () => {
      // The pairing runs both ways: an approval always records HOW, and a
      // method never appears without an approval.
      await expect(insertBatch({ approvedAfterSec: 1 })).rejects.toThrow(
        /solicitation_batches_approval_consistency/,
      );
      await expect(insertBatch({ approvalMethod: 'owner' })).rejects.toThrow(
        /solicitation_batches_approval_consistency/,
      );

      // An owner approval carries the acting user; an auto_policy one cannot.
      // The accepted rows are also CLOSED, because
      // solicitation_batches_one_active_send_per_business (D8) allows only one
      // approved-and-unclosed batch per business — without that these two would
      // collide on the partial unique rather than testing the CHECK.
      const closed = { builtAfterSec: 0, sendClosedAfterSec: 2 };
      await expect(
        insertBatch({
          ...closed,
          approvedAfterSec: 1,
          approvalMethod: 'owner',
          approvedByUserId: tenant!.userId,
        }),
      ).resolves.toBeDefined();
      await expect(
        insertBatch({ ...closed, approvedAfterSec: 1, approvalMethod: 'owner' }),
      ).rejects.toThrow(/solicitation_batches_approval_consistency/);
      await expect(
        insertBatch({ ...closed, approvedAfterSec: 1, approvalMethod: 'auto_policy' }),
      ).resolves.toBeDefined();

      // The regression this constraint shipped with: an UNAPPROVED batch — what
      // the 088 batch-builder writes on every build — must be representable.
      // `FALSE = NULL` collapsed the conjunction and the IS TRUE wrapper turned
      // that NULL into a rejection, so a row was legal only if BOTH approved
      // and halted. This line is the one that was red.
      await expect(insertBatch()).resolves.toBeDefined();
    });

    it('solicitation_batches rejects a halted batch with no halt reason', async () => {
      await expect(insertBatch({ haltedAfterSec: 0 })).rejects.toThrow(
        /solicitation_batches_halt_consistency/,
      );
      await expect(insertBatch({ haltReason: 'owner_halt' })).rejects.toThrow(
        /solicitation_batches_halt_consistency/,
      );

      // The three owner/admin reasons carry an actor …
      await expect(
        insertBatch({
          haltedAfterSec: 0,
          haltReason: 'owner_veto',
          haltedBy: tenant!.userId,
        }),
      ).resolves.toBeDefined();
      await expect(
        insertBatch({ haltedAfterSec: 0, haltReason: 'owner_veto' }),
      ).rejects.toThrow(/solicitation_batches_halt_consistency/);
      // … and the two system-derived ones must not.
      await expect(
        insertBatch({ haltedAfterSec: 0, haltReason: 'send_window_elapsed' }),
      ).resolves.toBeDefined();
      await expect(
        insertBatch({
          haltedAfterSec: 0,
          haltReason: 'batch_expired',
          haltedBy: tenant!.userId,
        }),
      ).rejects.toThrow(/solicitation_batches_halt_consistency/);

      // The same NULL hole as the approval arm: a NON-HALTED batch is legal.
      await expect(insertBatch()).resolves.toBeDefined();
    });

    it('solicitation_batches accepts a batch closed by generation_failed before approval', async () => {
      // Closure deliberately does NOT imply approval. D14's generation_failed
      // and B7's batch expiry both close a batch that was never approved, and a
      // blanket "closed implies approved" CHECK would reject them outright.
      await expect(
        insertBatch({ builtAfterSec: 0, sendClosedAfterSec: 1 }),
      ).resolves.toBeDefined();

      // What closure DOES imply is that the batch was built — you cannot close
      // what was never constructed.
      await expect(insertBatch({ sendClosedAfterSec: 1 })).rejects.toThrow(
        /solicitation_batches_send_ordering/,
      );

      // Sending, unlike closure, does imply approval.
      await expect(
        insertBatch({ builtAfterSec: 0, sendingStartedAfterSec: 1 }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      // …and never before it.
      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 2,
          approvalMethod: 'auto_policy',
          sendingStartedAfterSec: 1,
          sendClosedAfterSec: 3,
        }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      // The whole legal lifecycle in one row.
      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 1,
          approvalMethod: 'auto_policy',
          sendingStartedAfterSec: 2,
          sendClosedAfterSec: 3,
        }),
      ).resolves.toBeDefined();
    });

    it('solicitation_batches rejects an approved batch whose content was never built', async () => {
      // The dangerous shape, and the reason this arm exists at all: the
      // solicitation_batches_one_active_send_per_business partial unique keys on
      // `approved_at IS NOT NULL AND send_closed_at IS NULL AND halted_at IS NULL`,
      // so an approved-but-unbuilt batch ENTERS the live-send index — and
      // deriveBatchState reports it 'approved', because precedence puts approved
      // above built. A live send over content that does not exist.
      await expect(
        insertBatch({ approvedAfterSec: 1, approvalMethod: 'auto_policy' }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      // Approval never precedes the build it approves.
      await expect(
        insertBatch({
          builtAfterSec: 2,
          approvedAfterSec: 1,
          approvalMethod: 'auto_policy',
          sendClosedAfterSec: 3,
        }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      // Approving the instant the build lands is legal — the boundary is `>=`,
      // matching every other ordering arm in this constraint.
      await expect(
        insertBatch({
          builtAfterSec: 1,
          approvedAfterSec: 1,
          approvalMethod: 'auto_policy',
          sendClosedAfterSec: 2,
        }),
      ).resolves.toBeDefined();
    });

    it('solicitation_batches rejects a veto deadline with no approval behind it', async () => {
      // The veto window is an artifact of approval: it is the deadline by which
      // the owner may still pull back an approval that already happened. An
      // orphan deadline on an unapproved batch would be a countdown against
      // nothing that the send lane could still read as a live window.
      await expect(insertBatch({ builtAfterSec: 0, vetoDeadlineAfterSec: 1 })).rejects.toThrow(
        /solicitation_batches_send_ordering/,
      );

      // And it cannot close before the approval it protects opened.
      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 2,
          approvalMethod: 'auto_policy',
          vetoDeadlineAfterSec: 1,
          sendClosedAfterSec: 3,
        }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 1,
          approvalMethod: 'auto_policy',
          vetoDeadlineAfterSec: 2,
          sendClosedAfterSec: 3,
        }),
      ).resolves.toBeDefined();
    });

    it('solicitation_batches rejects a closure or halt that precedes the events it ends', async () => {
      // Closure stays deliberately independent of approval (generation_failed
      // and B7 expiry both close unapproved batches), which is exactly why each
      // stamp it can outrank is bounded individually rather than through one
      // chained rule.
      await expect(
        insertBatch({ builtAfterSec: 2, sendClosedAfterSec: 1 }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 2,
          approvalMethod: 'auto_policy',
          sendClosedAfterSec: 1,
        }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      await expect(
        insertBatch({
          builtAfterSec: 0,
          approvedAfterSec: 1,
          approvalMethod: 'auto_policy',
          sendingStartedAfterSec: 2,
          sendClosedAfterSec: 1,
        }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      // The halt latch is bounded against the build only: a batch can be halted
      // before it was ever approved (that is what owner_veto during the window
      // IS), but not before the content it halts existed.
      await expect(
        insertBatch({ builtAfterSec: 2, haltedAfterSec: 0, haltReason: 'batch_expired' }),
      ).rejects.toThrow(/solicitation_batches_send_ordering/);

      await expect(
        insertBatch({ builtAfterSec: 0, haltedAfterSec: 1, haltReason: 'batch_expired' }),
      ).resolves.toBeDefined();
    });

    // ── 3. solicitation_outreach body presence ───────────────────────────────

    it('solicitation_outreach rejects a rendered row with a null body', async () => {
      await expect(
        insertOutreach(db!, { deliveryStatus: 'rendered', renderedSubject: null }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
      // queued is dispatchable, so it is the case that actually costs a send.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'queued', renderedSubject: null }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
    });

    it('solicitation_outreach accepts a withheld row with no body and no redaction', async () => {
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'withheld',
          dispositionReason: 'lint_failed',
          renderedSubject: null,
          bodyRedactedAt: null,
        }),
      ).resolves.toBeDefined();
    });

    it('solicitation_outreach accepts a redacted row whose body was nulled', async () => {
      const sentAt = new Date();
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'sent',
          renderedSubject: null,
          sentAt,
          bodyRedactedAt: new Date(sentAt.getTime() + 1_000),
        }),
      ).resolves.toBeDefined();

      // Redaction means gone AND sent — a never-sent row cannot claim one.
      await expect(
        insertOutreach(db!, {
          attemptNo: 2,
          deliveryStatus: 'withheld',
          dispositionReason: 'suppressed',
          renderedSubject: null,
          sentAt: null,
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
    });

    // ── 4. solicitation_outreach status <-> reason totality ──────────────────

    it('solicitation_outreach requires send_indeterminate for delivery_status unknown', async () => {
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'unknown',
          dispositionReason: 'send_indeterminate',
        }),
      ).resolves.toBeDefined();
      await db!`DELETE FROM solicitation_outreach WHERE ask_id = ${askId}::uuid`;

      // An unknown/send_failed row is a contradiction: `unknown` means the
      // provider never told us, `send_failed` means it told us no.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'unknown', dispositionReason: 'send_failed' }),
      ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);

      // The NULL side of this rule, and the `sent` side, now have their own
      // titles below — one owner per promised fact.
    });

    it('solicitation_outreach rejects a null disposition_reason for every reason-bearing delivery status', async () => {
      // A Postgres CHECK passes on NULL: each arm here evaluates to NULL rather
      // than FALSE, and a bare disjunction would let all four straight through
      // the arm written to catch them. The `IS TRUE` wrapper is what turns that
      // NULL into the rejection — this asserts the wrapper, not the arms.
      for (const reasonBearingStatus of ['withheld', 'cancelled', 'failed', 'unknown']) {
        await expect(
          insertOutreach(db!, {
            deliveryStatus: reasonBearingStatus,
            dispositionReason: null,
          }),
        ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);
      }
    });

    it('solicitation_outreach requires a null disposition_reason for a sent row', async () => {
      // Reason-bearing is NOT the same partition as terminal. `sent` is
      // terminal and takes NO reason, because a successful send has nothing to
      // explain — the intake originally promised a test that could not pass
      // because it conflated the two (round-2 finding, executor-design:377).
      await expect(
        insertOutreach(db!, { deliveryStatus: 'sent', sentAt: new Date() }),
      ).resolves.toBeDefined();
      await db!`DELETE FROM solicitation_outreach WHERE ask_id = ${askId}::uuid`;

      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'sent',
          sentAt: new Date(),
          dispositionReason: 'send_failed',
        }),
      ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);
      // The other three NULL-reason statuses behave the same way.
      for (const nullReasonStatus of ['rendered', 'queued', 'sending']) {
        await db!`DELETE FROM solicitation_outreach WHERE ask_id = ${askId}::uuid`;
        await expect(
          insertOutreach(db!, {
            deliveryStatus: nullReasonStatus,
            dispositionReason: 'send_failed',
          }),
        ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);
      }
    });

    it('solicitation_outreach rejects a queued row carrying a body_redacted_at stamp', async () => {
      // Redaction implies sent. A queued row is still dispatchable, so a
      // redaction stamp on one would mean "send this, the body is gone" — the
      // exact case the body-presence rules were split into three to catch.
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'queued',
          renderedSubject: null,
          sentAt: null,
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);

      // Not merely because the body is absent: a queued row with its body
      // INTACT and a redaction stamp is equally illegal, since redaction means
      // the body is gone.
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'queued',
          sentAt: null,
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
    });

    it('solicitation_outreach rejects a cancelled row carrying a withhold reason', async () => {
      await expect(
        insertOutreach(db!, { deliveryStatus: 'cancelled', dispositionReason: 'moderation_high' }),
      ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);
      await expect(
        insertOutreach(db!, { deliveryStatus: 'cancelled', dispositionReason: 'send_failed' }),
      ).rejects.toThrow(/solicitation_outreach_status_reason_consistency/);
    });

    it('solicitation_outreach accepts superseded as a cancel reason', async () => {
      await expect(
        insertOutreach(db!, { deliveryStatus: 'cancelled', dispositionReason: 'superseded' }),
      ).resolves.toBeDefined();
    });

    // ── 4b. solicitation_outreach status <-> lifecycle timestamps ────────────

    it('solicitation_outreach requires sent_at exactly for a sent row', async () => {
      // A 'sent' row with no sent_at is invisible to the ArchivalPoller
      // redaction sweep, which selects on `sent_at < NOW() - 90 days` — so it
      // would keep its rendered body FOREVER while reporting as sent. The
      // 90-day retention promise is only as total as this arm.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'sent', sentAt: null }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      // The mirror: sent_at is the stamp of a completed send and no other
      // status may carry one. This is what makes a live 'rendered' row
      // unreachable by the sweep — it cannot hold a sent_at to be selected on.
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'failed',
          dispositionReason: 'send_failed',
          sentAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);
      await expect(
        insertOutreach(db!, { deliveryStatus: 'rendered', sentAt: new Date() }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      await expect(
        insertOutreach(db!, { deliveryStatus: 'sent', sentAt: new Date() }),
      ).resolves.toBeDefined();
    });

    it('solicitation_outreach rejects a live attempt carrying dispatch timestamps', async () => {
      // 'rendered' means built-but-not-handed-off. A queued_at on one would
      // claim a dispatch that the status says never happened, and the daily-cap
      // count (B3, keyed on queued_at) would charge the account for it.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'rendered', queuedAt: new Date() }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      // 'queued' means handed to the send lane but not yet in flight.
      const queuedAt = new Date();
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'queued',
          queuedAt,
          sendingAt: new Date(queuedAt.getTime() + 1_000),
        }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      await expect(
        insertOutreach(db!, { deliveryStatus: 'queued', queuedAt }),
      ).resolves.toBeDefined();
    });

    it('solicitation_outreach rejects out-of-order dispatch timestamps', async () => {
      const queuedAt = new Date();
      const sendingAt = new Date(queuedAt.getTime() + 1_000);
      const sentAt = new Date(queuedAt.getTime() + 2_000);

      // In flight without ever having been queued.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'sending', queuedAt: null, sendingAt }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      // Each inversion in turn.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'sending', queuedAt: sendingAt, sendingAt: queuedAt }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);
      await expect(
        insertOutreach(db!, {
          deliveryStatus: 'sent',
          queuedAt,
          sendingAt: sentAt,
          sentAt: sendingAt,
        }),
      ).rejects.toThrow(/solicitation_outreach_status_timestamp_consistency/);

      // The whole ordered chain in one row.
      await expect(
        insertOutreach(db!, { deliveryStatus: 'sent', queuedAt, sendingAt, sentAt }),
      ).resolves.toBeDefined();
    });

    // ── 5. Attempt identity ──────────────────────────────────────────────────

    it('solicitation_outreach allows at most one live attempt per ask', async () => {
      await insertOutreach(db!, { attemptNo: 1, deliveryStatus: 'rendered' });

      // Two live attempts on one ask is the double-send bug the partial unique
      // exists to make unrepresentable.
      await expect(
        insertOutreach(db!, { attemptNo: 2, deliveryStatus: 'queued' }),
      ).rejects.toThrow(/solicitation_outreach_one_live_per_ask/);

      // Supersession's writer contract: terminalize the old row, THEN insert
      // attempt_no + 1 — both in one transaction.
      await db!`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled', disposition_reason = 'superseded'
        WHERE ask_id = ${askId}::uuid AND attempt_no = 1
      `;
      await expect(
        insertOutreach(db!, { attemptNo: 2, deliveryStatus: 'queued' }),
      ).resolves.toBeDefined();

      // Attempt-number reuse has its own title below.
    });

    it('solicitation_outreach rejects reusing an attempt_no for the same ask', async () => {
      // The FULL unique coexists with the one-live partial index: numbers are
      // never reused, even by a row that is not live. Without it, a regenerate
      // could recycle attempt 1 and the audit trail of what was sent to whom
      // would silently lose an entry.
      await insertOutreach(db!, { attemptNo: 1, deliveryStatus: 'rendered' });
      await db!`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled', disposition_reason = 'superseded'
        WHERE ask_id = ${askId}::uuid AND attempt_no = 1
      `;

      await expect(
        insertOutreach(db!, {
          attemptNo: 1,
          deliveryStatus: 'withheld',
          dispositionReason: 'suppressed',
          renderedSubject: null,
        }),
      ).rejects.toThrow(/solicitation_outreach_ask_attempt_uniq/);

      // attempt_no + 1 is the writer contract, and it is accepted.
      await expect(
        insertOutreach(db!, { attemptNo: 2, deliveryStatus: 'queued' }),
      ).resolves.toBeDefined();
    });

    it('solicitation_outreach rejects an attempt_no of zero', async () => {
      // B2: attempt numbers start at 1. A zeroth attempt would make "attempts
      // so far" ambiguous between zero-based and one-based readers.
      await expect(
        insertOutreach(db!, { attemptNo: 0 }),
      ).rejects.toThrow(/solicitation_outreach_attempt_no_check/);
      await expect(
        insertOutreach(db!, { attemptNo: -1 }),
      ).rejects.toThrow(/solicitation_outreach_attempt_no_check/);
    });

    // ── 6. D6a moderation carve-out (RLS) ────────────────────────────────────

    it('solicitation_outreach hides a moderation_high withheld body from a direct authenticated owner read', async () => {
      const visibleId = randomUUID();
      const hiddenId = randomUUID();
      let readAsOwner: { id: string; delivery_status: string }[] = [];

      // Everything below happens inside ONE transaction that always rolls back.
      // The local bootstrap stubs auth.uid() to NULL and grants `authenticated`
      // nothing, so owner_account_id() would be NULL and EVERY row would be
      // hidden — a vacuous pass. Redefining auth.uid() and granting SELECT for
      // the duration of the transaction is what makes the assertion mean
      // something in both directions. Postgres DDL and GRANTs are
      // transactional, so ROLLBACK restores the bootstrap exactly, and the
      // cross-process live-DB lock keeps sibling suites from observing it.
      try {
        await db!.begin(async (tx) => {
          await insertOutreach(tx, { id: visibleId, attemptNo: 1, deliveryStatus: 'rendered' });
          await insertOutreach(tx, {
            id: hiddenId,
            attemptNo: 2,
            deliveryStatus: 'withheld',
            dispositionReason: 'moderation_high',
            moderationStatus: 'flagged',
            renderedSubject: null,
          });

          await tx.unsafe(
            `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
             AS $probe$ SELECT '${ownerAuthId}'::uuid $probe$`,
          );
          await tx`GRANT USAGE ON SCHEMA public, auth TO authenticated`;
          await tx`GRANT SELECT ON solicitation_outreach, users TO authenticated`;

          await tx`SET LOCAL ROLE authenticated`;
          readAsOwner = await tx<{ id: string; delivery_status: string }[]>`
            SELECT id, delivery_status FROM solicitation_outreach ORDER BY id
          `;
          throw new RollbackAfterProbe();
        });
      } catch (error) {
        if (!(error instanceof RollbackAfterProbe)) throw error;
      }

      // The owner sees their own outreach — generate-then-approve requires it …
      expect(readAsOwner.map((row) => row.id)).toEqual([visibleId]);
      // … but never a body high-severity moderation withheld (invariant #4 read
      // straight across).
      expect(readAsOwner.map((row) => row.id)).not.toContain(hiddenId);

      const [policy] = await db!<{ cmd: string; qual: string | null }[]>`
        SELECT cmd, qual FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'solicitation_outreach'
          AND policyname = 'solicitation_outreach_owner_select'
      `;
      expect(policy?.cmd).toBe('SELECT');
      expect(normalizeSql(policy?.qual ?? '')).toContain("'moderation_high'::text");
    });

    // ── 7. Tenant integrity ──────────────────────────────────────────────────

    it('solicitation_outreach requires composite tenant FKs and rejects a cross-tenant batch reference', async () => {
      const definitions = await db!<{ constraint_name: string; definition: string }[]>`
        SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'solicitation_outreach'::regclass AND contype = 'f'
        ORDER BY conname
      `;
      const byName = new Map(
        definitions.map((row) => [row.constraint_name, normalizeSql(row.definition)]),
      );

      expect(byName.get('solicitation_outreach_business_account_fk')).toContain(
        'FOREIGN KEY (business_id, account_id) REFERENCES businesses(id, account_id) ON DELETE CASCADE',
      );
      expect(byName.get('solicitation_outreach_batch_tenant_fk')).toContain(
        'FOREIGN KEY (batch_id, account_id, business_id) ' +
          'REFERENCES solicitation_batches(id, account_id, business_id) ON DELETE CASCADE',
      );
      expect(byName.get('solicitation_outreach_contact_business_fk')).toContain(
        'FOREIGN KEY (contact_id, business_id) ' +
          'REFERENCES solicitation_contacts(id, business_id) ON DELETE CASCADE',
      );
      expect(byName.get('solicitation_outreach_run_tenant_fk')).toContain(
        'FOREIGN KEY (account_id, business_id, agent_run_id) ' +
          'REFERENCES agent_runs(account_id, business_id, id) ON DELETE SET NULL (agent_run_id)',
      );

      // A single-column batch FK would accept this row; the composite one
      // cannot, because (foreignBatchId, ourAccount, ourBusiness) is not a key.
      await expect(insertOutreach(db!, { batchId: foreignBatchId })).rejects.toMatchObject({
        code: '23503',
        constraint_name: 'solicitation_outreach_batch_tenant_fk',
      });
    });

    // ── 8. job_outbox in-flight indexes ──────────────────────────────────────

    it('the solicitation_send in-flight index spells the outbox status set in members-and-order', async () => {
      // The set is owned by src/lib/shared/job-outbox-status.ts and re-spelled
      // by hand at every site — a bind parameter inside ON CONFLICT ... WHERE
      // defeats partial-index inference. Deriving the expectation from that
      // module is what makes this a contract check rather than a copy.
      const expectedPredicate = `status = ANY (ARRAY[${OUTBOX_IN_FLIGHT_STATUSES.map(
        (status) => `'${status}'::text`,
      ).join(', ')}])`;
      expect(expectedPredicate).toBe(
        "status = ANY (ARRAY['pending'::text, 'dispatching'::text, 'dispatched'::text])",
      );

      const sendIndex = await indexDefinition('job_outbox_solicitation_send_inflight');
      expect(sendIndex).toContain('CREATE UNIQUE INDEX');
      expect(sendIndex).toContain('ON public.job_outbox USING btree (topic, aggregate_id)');
      expect(sendIndex).toContain("(topic = 'solicitation_send'::text)");
      expect(sendIndex).toContain(expectedPredicate);

      const asksIndex = await indexDefinition('job_outbox_generate_solicitation_asks_inflight');
      expect(asksIndex).toContain("(topic = 'generate_solicitation_asks'::text)");
      expect(asksIndex).toContain(expectedPredicate);
    });

    // ── 9. auto_approval_policies solicitation lane ──────────────────────────

    it('auto_approval_policies rejects a solicitation row carrying auto_approve_min_star', async () => {
      // A star band on a sending row is inert nonsense that reads as intent —
      // the restraint policy is sentiment-blind and never looks at stars.
      await expect(
        insertPolicy({
          persona: 'solicitation',
          actionClass: 'sending',
          vetoWindowMinutes: 60,
          autoApproveMinStar: 5,
        }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);

      // Same rule, the other two columns.
      await expect(
        insertPolicy({
          persona: 'solicitation',
          actionClass: 'sending',
          vetoWindowMinutes: 60,
          dailyAutoPostCap: 10,
        }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
      await expect(
        insertPolicy({
          persona: 'reply',
          actionClass: 'posting',
          vetoWindowMinutes: 15,
          dailySendCap: 10,
        }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
    });

    it('auto_approval_policies rejects the reply persona paired with the sending action class', async () => {
      // Widening persona and action_class independently would have admitted
      // this pair. One CHECK fixes the action class per persona.
      await expect(
        insertPolicy({ persona: 'reply', actionClass: 'sending', vetoWindowMinutes: 30 }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
      // …and the mirror image.
      await expect(
        insertPolicy({ persona: 'solicitation', actionClass: 'posting', vetoWindowMinutes: 60 }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
    });

    it('auto_approval_policies rejects a reply row with a 60 minute veto window', async () => {
      // The subtle one: a global (15, 30, 60) widening would have silently
      // loosened the already-live Reply lane that 074 pins to (15, 30).
      await expect(
        insertPolicy({ persona: 'reply', actionClass: 'posting', vetoWindowMinutes: 60 }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
      // The window is pinned per persona in both directions — 15 is legal for
      // reply and illegal for solicitation.
      await expect(
        insertPolicy({ persona: 'reply', actionClass: 'posting', vetoWindowMinutes: 15 }),
      ).resolves.toBeDefined();
      await expect(
        insertPolicy({ persona: 'solicitation', actionClass: 'sending', vetoWindowMinutes: 15 }),
      ).rejects.toThrow(/auto_approval_policies_persona_consistency/);
    });

    it('auto_approval_policies accepts veto_window_minutes 60 for a solicitation row', async () => {
      await expect(
        insertPolicy({
          persona: 'solicitation',
          actionClass: 'sending',
          vetoWindowMinutes: 60,
          dailySendCap: 10,
        }),
      ).resolves.toBeDefined();

      // The rejections this used to also assert now have their own titles —
      // the reply/sending pairing and the reply 60-minute window — so each
      // promised fact has exactly one owner.
    });
  },
);
