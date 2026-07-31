import { randomUUID } from 'node:crypto';
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
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  checksum,
  insertOutreach as insertOutreachFixture,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import type { AskInterpolationInputs } from '../ask-prompt-policy';
import {
  insertOutreachRender,
  parseOutreachInterpolationInputs,
  parseOutreachLintDetail,
  parseOutreachModerationDetail,
  supersedeLiveRender,
  type InsertOutreachRenderInput,
} from '../outreach';

// Live-DB suite for the #628 render persistence seam. Applies NO migration SQL
// (#573): `pnpm test:db:setup` provisions to head and this file ASSERTS the
// schema with assertSchemaReady. It holds the cross-process live-DB lock
// because the RLS probe temporarily redefines auth.uid() and grants SELECT to
// `authenticated` inside a rolled-back transaction — a sibling suite observing
// that window would see a different security posture than the bootstrap's.

const testDatabaseUrl = resolveTestDatabaseUrl();

const businessId = randomUUID();
const uploadId = randomUUID();
const batchId = randomUUID();
const ownerAuthId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('outreach-render integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('outreach-render integration tenant was not seeded');
  return tenant.accountId;
}

/** Rolls a probing transaction back without swallowing genuine failures. */
class RollbackAfterProbe extends Error {
  constructor() {
    super('probe complete — rolling back');
    this.name = 'RollbackAfterProbe';
  }
}

/** One ask on its own contact — solicitation_asks is unique per (batch, contact). */
async function seedAsk(): Promise<string> {
  const contactId = randomUUID();
  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Render Candidate',
      ${`${contactId}@example.test`}, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id,
      status, withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({ decision: 'send' })}, NOW()
    )
  `;
  return askId;
}

async function contactIdOfAsk(askId: string): Promise<string> {
  const [row] = await sql()<{ contact_id: string }[]>`
    SELECT contact_id::text AS contact_id FROM solicitation_asks
    WHERE id = ${askId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  return row!.contact_id;
}

const SNAPSHOT: AskInterpolationInputs = {
  contact_first_name: 'Ada',
  business_name: 'Outreach Render Business',
  days_since_visit_bucket: 'last week',
  vertical: 'retail',
  visit_note: null,
  note_disposition: 'absent',
};

/** A fully rendered attempt; callers override exactly the fields under test. */
function renderInput(
  askId: string,
  contactId: string,
  overrides: Partial<InsertOutreachRenderInput> = {},
): InsertOutreachRenderInput {
  return {
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    attemptNo: 1,
    renderedSubject: 'How was your visit?',
    renderedBody: 'Would you mind leaving us a review?',
    promptVersion: '2026-07-30.1',
    promptHash: checksum(askId),
    askLintVersion: 'ask_lint_2026-07-30.1',
    lintDetail: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: SNAPSHOT,
    renderedAt: new Date(),
    agentRunId: null,
    deliveryStatus: 'rendered',
    ...overrides,
  } as InsertOutreachRenderInput;
}

interface StoredOutreachRow {
  attempt_no: number;
  delivery_status: string;
  disposition_reason: string | null;
  rendered_subject: string | null;
  rendered_body: string | null;
  moderation_status: string;
  lint_detail: unknown;
  moderation_detail: unknown;
  interpolation_inputs: unknown;
}

async function readAskRows(askId: string): Promise<StoredOutreachRow[]> {
  return sql()<StoredOutreachRow[]>`
    SELECT attempt_no, delivery_status, disposition_reason,
           rendered_subject, rendered_body, moderation_status,
           lint_detail, moderation_detail, interpolation_inputs
    FROM solicitation_outreach
    WHERE ask_id = ${askId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
    ORDER BY attempt_no
  `;
}

describeWithDb(
  'outreach render persistence against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 2, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Outreach Render Owner',
        accountDisplayName: 'Outreach Render Account',
      });
      // owner_account_id() resolves auth.uid() -> users.auth_id, so the RLS
      // probe needs a real auth identity on the seeded owner.
      await db`
        UPDATE users SET auth_id = ${ownerAuthId} WHERE id = ${tenant.userId}::uuid
      `;
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Outreach Render Business', 'Render Owner',
          ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', 'automotive'
        )
      `;
      await db`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, report, attested_by_user_id, attested_at,
          attestation_version, completed_at
        ) VALUES (
          ${uploadId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          'outreach-render.csv', 1, ${checksum(uploadId)},
          NULL, 'completed', ${db.json({ accepted: 1 })},
          ${tenant.userId}::uuid, NOW(), 'outreach-render-test', NOW()
        )
      `;
      await db`
        INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
        VALUES (
          ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid, ${uploadId}::uuid
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db) return;
      await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    });

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM solicitation_batches WHERE id = ${batchId}::uuid`;
          await db`DELETE FROM contact_csv_uploads WHERE id = ${uploadId}::uuid`;
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

    it('supersedes the prior attempt and inserts attempt_no plus one in a single transaction', async () => {
      const askId = await seedAsk();
      const contactId = await contactIdOfAsk(askId);
      await sql().begin((tx) => insertOutreachRender(tx, renderInput(askId, contactId)));

      // B2's writer contract: update-old-to-terminal THEN insert attempt_no + 1,
      // both inside ONE transaction, so the one-live-per-ask unique never sees
      // two live rows even transiently.
      await sql().begin(async (tx) => {
        const prior = await supersedeLiveRender(tx, {
          askId,
          accountId: accountId(),
          businessId,
        });
        expect(prior).toEqual({ priorAttemptNo: 1 });
        await insertOutreachRender(
          tx,
          renderInput(askId, contactId, { attemptNo: prior!.priorAttemptNo + 1 }),
        );
      });

      const rows = await readAskRows(askId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        attempt_no: 1,
        delivery_status: 'cancelled',
        disposition_reason: 'superseded',
      });
      expect(rows[1]).toMatchObject({
        attempt_no: 2,
        delivery_status: 'rendered',
        disposition_reason: null,
      });
    });

    it('supersedeLiveRender returns null for released and withheld rows so the caller refuses', async () => {
      // AMEND B2: released rows are never superseded, and a terminal withheld
      // row has nothing live to supersede — both must answer null, and the row
      // must be left untouched.
      const queuedAskId = await seedAsk();
      await insertOutreachFixture(sql(), {
        accountId: accountId(),
        businessId,
        batchId,
        askId: queuedAskId,
        contactId: await contactIdOfAsk(queuedAskId),
        deliveryStatus: 'queued',
        queuedAt: sql()`NOW()`,
      });

      const withheldAskId = await seedAsk();
      const withheldContactId = await contactIdOfAsk(withheldAskId);
      await sql().begin((tx) =>
        insertOutreachRender(
          tx,
          renderInput(withheldAskId, withheldContactId, {
            deliveryStatus: 'withheld',
            dispositionReason: 'lint_failed',
            lintDetail: ['pressure'],
          }),
        ),
      );

      for (const askId of [queuedAskId, withheldAskId]) {
        const result = await sql().begin((tx) =>
          supersedeLiveRender(tx, { askId, accountId: accountId(), businessId }),
        );
        expect(result).toBeNull();
      }
      expect((await readAskRows(queuedAskId))[0]!.delivery_status).toBe('queued');
      expect((await readAskRows(withheldAskId))[0]!.delivery_status).toBe('withheld');
    });

    it('writes a withheld moderation_high render whose body a direct authenticated read cannot return', async () => {
      const visibleAskId = await seedAsk();
      const visibleContactId = await contactIdOfAsk(visibleAskId);
      const hiddenAskId = await seedAsk();
      const hiddenContactId = await contactIdOfAsk(hiddenAskId);
      let hiddenBodyStored: string | null = null;
      let readAsOwner: { ask_id: string }[] = [];

      // Everything happens inside ONE transaction that always rolls back. The
      // local bootstrap stubs auth.uid() to NULL and grants `authenticated`
      // nothing, so owner_account_id() would be NULL and EVERY row would be
      // hidden — a vacuous pass. Redefining auth.uid() and granting SELECT for
      // the duration of the transaction is what makes the assertion mean
      // something in both directions (migration-091 suite precedent); ROLLBACK
      // restores the bootstrap exactly.
      try {
        await sql().begin(async (tx) => {
          await insertOutreachRender(tx, renderInput(visibleAskId, visibleContactId));
          const hiddenOutreachId = await insertOutreachRender(
            tx,
            renderInput(hiddenAskId, hiddenContactId, {
              deliveryStatus: 'withheld',
              dispositionReason: 'moderation_high',
              moderationStatus: 'flagged',
              moderationDetail: { harassment: 0.97 },
            }),
          );

          // The body IS stored — the withholding below must be RLS, not absence.
          const [stored] = await tx<{ rendered_body: string | null }[]>`
            SELECT rendered_body FROM solicitation_outreach
            WHERE id = ${hiddenOutreachId}::uuid
          `;
          hiddenBodyStored = stored!.rendered_body;

          await tx.unsafe(
            `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
             AS $probe$ SELECT '${ownerAuthId}'::uuid $probe$`,
          );
          await tx`GRANT USAGE ON SCHEMA public, auth TO authenticated`;
          await tx`GRANT SELECT ON solicitation_outreach, users TO authenticated`;

          await tx`SET LOCAL ROLE authenticated`;
          readAsOwner = await tx<{ ask_id: string }[]>`
            SELECT ask_id FROM solicitation_outreach ORDER BY ask_id
          `;
          throw new RollbackAfterProbe();
        });
      } catch (error) {
        if (!(error instanceof RollbackAfterProbe)) throw error;
      }

      expect(hiddenBodyStored).not.toBeNull();
      // The owner sees their own rendered outreach (generate-then-approve
      // requires it) but never the moderation_high row — invariant #4 read
      // straight across (091's D6a carve-out).
      expect(readAsOwner.map((row) => row.ask_id)).toEqual([visibleAskId]);
    });

    it('a render_failed row satisfies every 091 and 092 constraint with the locked fills', async () => {
      // Locked decision 2: subject/body NULL, lint_detail '[]',
      // moderation_detail '{}', moderation_status 'error',
      // interpolation_inputs = the actual snapshot.
      const askId = await seedAsk();
      const contactId = await contactIdOfAsk(askId);

      await expect(
        sql().begin((tx) =>
          insertOutreachRender(
            tx,
            renderInput(askId, contactId, {
              deliveryStatus: 'withheld',
              dispositionReason: 'render_failed',
              renderedSubject: null,
              renderedBody: null,
              lintDetail: [],
              moderationStatus: 'error',
              moderationDetail: {},
            }),
          ),
        ),
      ).resolves.toBeDefined();

      const [row] = await readAskRows(askId);
      expect(row).toMatchObject({
        attempt_no: 1,
        delivery_status: 'withheld',
        disposition_reason: 'render_failed',
        rendered_subject: null,
        rendered_body: null,
        moderation_status: 'error',
      });

      // The parsers narrow the read-back JSONB, whichever wire shape the pool
      // handed us (PgBouncer can return JSONB as strings).
      const outreachId = 'render-failed-readback';
      expect(parseOutreachLintDetail(row!.lint_detail, outreachId)).toEqual([]);
      expect(parseOutreachModerationDetail(row!.moderation_detail, outreachId)).toEqual({});
      expect(parseOutreachInterpolationInputs(row!.interpolation_inputs, outreachId)).toEqual(
        SNAPSHOT,
      );
    });

    it('a second live render for the same ask is rejected by the one-live-per-ask unique index', async () => {
      // The insert is deliberately unconditional (no ON CONFLICT): the
      // existence check lives upstream in the generation lane, so a race past
      // it must surface as 23505 rather than be silently absorbed.
      const askId = await seedAsk();
      const contactId = await contactIdOfAsk(askId);
      await sql().begin((tx) => insertOutreachRender(tx, renderInput(askId, contactId)));

      await expect(
        sql().begin((tx) =>
          insertOutreachRender(tx, renderInput(askId, contactId, { attemptNo: 2 })),
        ),
      ).rejects.toThrow(/solicitation_outreach_one_live_per_ask/);
    });

    it('the JSONB parsers accept the PgBouncer string form and throw on foreign shapes', () => {
      const outreachId = randomUUID();

      expect(parseOutreachLintDetail('["pressure","gating_funnel"]', outreachId)).toEqual([
        'pressure',
        'gating_funnel',
      ]);
      expect(() => parseOutreachLintDetail('{}', outreachId)).toThrow(/not an array/);
      expect(() => parseOutreachLintDetail(['not_a_lint_class'], outreachId)).toThrow(
        /non-lint-class/,
      );
      // moderation_high is a block reason but never a LINT class.
      expect(() => parseOutreachLintDetail(['moderation_high'], outreachId)).toThrow(
        /non-lint-class/,
      );

      expect(parseOutreachModerationDetail('{"harassment":0.97}', outreachId)).toEqual({
        harassment: 0.97,
      });
      expect(() => parseOutreachModerationDetail('[]', outreachId)).toThrow(/not an object/);
      expect(() => parseOutreachModerationDetail(3, outreachId)).toThrow(/not an object/);

      expect(parseOutreachInterpolationInputs('{}', outreachId)).toBeNull();
      expect(parseOutreachInterpolationInputs(JSON.stringify(SNAPSHOT), outreachId)).toEqual(
        SNAPSHOT,
      );
      expect(() =>
        parseOutreachInterpolationInputs({ contact_first_name: 'Ada' }, outreachId),
      ).toThrow(/discriminant/);
      expect(() => parseOutreachInterpolationInputs(null, outreachId)).toThrow(/not an object/);
    });
  },
);
