import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_110_SEND_GOVERNORS,
  MIGRATION_126_OUTREACH_REMNANT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { verificationQuery } from '@/lib/account-offboarding/purge-verification';
import {
  runContentPurgeStage,
  type AccountOffboardingPurgeRow,
} from '../../../../worker/jobs/account-offboarding/purge-stages';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { readLatestBatch } from '../batch-view';
import { deleteContact } from '../contacts-repo';
import { evaluateSendBreaker } from '../send-breaker';
import { recordSuppression } from '../suppression';

// #1350 / ADR 0033 — a per-contact hard delete erases the person and keeps the
// anonymous send signal as an **Outreach remnant**. Everything here is a fact
// about the real schema (migration 126's column-scoped SET NULL FKs, 091/092's
// body-presence CHECK, 090's evidence CHECK, 088's NULLS-DISTINCT unique), so it
// runs only against a live database.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions the schema to
// head and this suite ASSERTS it (MIGRATION_126_OUTREACH_REMNANT).

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let seededBusinessId: string | undefined;

class Rollback extends Error {
  override readonly name = 'Rollback';
}

function expectRollback(error: unknown): void {
  if ((error as { name?: string })?.name !== 'Rollback') throw error;
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('remnant suite database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('remnant suite tenant was not seeded');
  return tenant.accountId;
}

function businessId(): string {
  if (!seededBusinessId) throw new Error('remnant suite location was not seeded');
  return seededBusinessId;
}

// ── The column classification (ADR 0033 "Limits", first entry) ──────────────
//
// Every column of `solicitation_outreach` and `solicitation_asks` is named here
// exactly once. The guard test below FAILS when a column joins either table
// without being classified — without it the anonymity claim silently rots the
// day someone adds a column that carries a name, an address or a quoted body.
// The behavioural tests then hold each class to its promise: KEPT is
// byte-identical across the delete, REDACTED is emptied.

/** Anonymous facts a remnant keeps, byte for byte. */
const OUTREACH_KEPT = [
  'id',
  'account_id',
  'business_id',
  'batch_id',
  'channel',
  'attempt_no',
  'source',
  'prompt_version',
  'prompt_hash',
  'rendered_at',
  'ask_lint_version',
  'lint_detail', // matched lint CLASS names only
  'moderation_status',
  'moderation_detail', // provider category map, no text
  'consent_basis',
  'consent_attestation_version',
  'delivery_status',
  'disposition_reason',
  'queued_at',
  'sending_at',
  'sent_at',
  'bounced_at',
  'complained_at',
  'unsubscribed_at',
  'bounce_kind',
  'agent_run_id',
  'created_at',
  'attributed_at',
  'attribution_rule',
  'attribution_detail', // carries no PII by 114's contract
] as const;

/** Person-bearing columns deleteContact empties in the delete's transaction. */
const OUTREACH_REDACTED = [
  'rendered_subject',
  'rendered_body',
  'interpolation_inputs', // -> '{}'::jsonb; stays NOT NULL (091/092 CHECK)
  'provider_message_id',
  'provider_error',
  'consent_row_id',
  // Not in the issue's list, classified here: the review id joins straight to
  // reviews.reviewer_name — the erased person's own name (ADR decision 4).
  'attributed_review_id',
] as const;

/** Nulled by migration 126's FK action, or stamped by the redaction. */
const OUTREACH_LIFECYCLE = [
  'contact_id', // SET NULL (contact_id)
  'ask_id', // kept when the ask survives; SET NULL (ask_id) when it is deleted
  'body_redacted_at', // stamped
  'updated_at', // touched
] as const;

const ASK_KEPT = [
  'id',
  'account_id',
  'business_id',
  'batch_id',
  'status',
  'withheld_reason',
  'agent_run_id',
  'decided_at',
  'created_at',
] as const;
/** Reduced to `{decision, reason}` — 090's CHECK pins exactly those two keys. */
const ASK_REDACTED = ['evidence'] as const;
const ASK_LIFECYCLE = ['contact_id'] as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Batch {
  uploadId: string;
  batchId: string;
}

async function seedBatch(tenantAccountId = accountId(), bizId = businessId()): Promise<Batch> {
  const uploadId = randomUUID();
  const batchId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${tenantAccountId}::uuid, ${bizId}::uuid,
      ${`remnant-${uploadId}.csv`}, 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  await sql()`
    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
    VALUES (${batchId}::uuid, ${tenantAccountId}::uuid, ${bizId}::uuid, ${uploadId}::uuid, NOW())
  `;
  return { uploadId, batchId };
}

async function seedContact(batch: Batch, bizId = businessId()): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `remnant-${id}@example.test`;
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${id}::uuid, ${bizId}::uuid, 'Remy Remnant', ${email}, ${batch.uploadId}::uuid)
  `;
  await sql()`
    INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, upload_id)
    VALUES (${randomUUID()}::uuid, ${id}::uuid, ${bizId}::uuid, CURRENT_DATE - 3, ${batch.uploadId}::uuid)
  `;
  return { id, email };
}

async function seedAsk(
  batch: Batch,
  contactId: string,
  decision: 'send' | 'over_contacted',
  tenantAccountId = accountId(),
  bizId = businessId(),
): Promise<string> {
  const id = randomUUID();
  const evidence =
    decision === 'send'
      ? { decision: 'send', contact_id: contactId, policy_version: 'restraint_v1', decided_at: 'x' }
      : {
          decision: 'withhold',
          reason: 'over_contacted',
          contact_id: contactId,
          policy_version: 'restraint_v1',
          decided_at: 'x',
          prior_batch_id: randomUUID(),
          prior_decision_at: '2026-09-01T00:00:00Z',
          min_gap_days: 30,
        };
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${id}::uuid, ${tenantAccountId}::uuid, ${bizId}::uuid, ${batch.batchId}::uuid,
      ${contactId}::uuid,
      ${decision === 'send' ? 'send' : 'withhold'},
      ${decision === 'send' ? null : 'over_contacted'},
      ${sql().json(evidence)}, NOW()
    )
  `;
  return id;
}

type OutreachShape = 'sent_bounced' | 'rendered';

async function seedOutreach(input: {
  batch: Batch;
  askId: string;
  contactId: string;
  shape: OutreachShape;
  attemptNo?: number;
  consentRowId?: string | null;
  attributedReviewId?: string | null;
  tenantAccountId?: string;
  bizId?: string;
}): Promise<string> {
  const id = randomUUID();
  const sent = input.shape === 'sent_bounced';
  // Every timestamp computed IN POSTGRES: a JS Date loses microseconds (#520),
  // and the byte-identity assertion below compares ::text.
  await sql()`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id, attempt_no,
      rendered_subject, rendered_body, prompt_version, prompt_hash,
      interpolation_inputs, rendered_at, ask_lint_version, lint_detail,
      moderation_status, moderation_detail, consent_basis,
      consent_attestation_version, consent_row_id, delivery_status,
      queued_at, sending_at, sent_at, provider_message_id, provider_error,
      bounced_at, bounce_kind, complained_at,
      attributed_review_id, attributed_at, attribution_rule, attribution_detail
    ) VALUES (
      ${id}::uuid, ${input.tenantAccountId ?? accountId()}::uuid,
      ${input.bizId ?? businessId()}::uuid, ${input.batch.batchId}::uuid,
      ${input.askId}::uuid, ${input.contactId}::uuid, ${input.attemptNo ?? 1},
      'Remy, how did we do?', 'Hi Remy, thanks for visiting on Tuesday.',
      'solicitation_ask_v1', ${'a'.repeat(64)},
      ${sql().json({ contact_first_name: 'Remy', visit_note: 'Tuesday haircut' })},
      NOW() - INTERVAL '2 days' + INTERVAL '419 microseconds',
      'ask_lint_v1', ${sql().json(['urgency'])}, 'clean',
      ${sql().json({ harassment: false })},
      ${sent ? 'owner_attested' : null}, ${sent ? CONSENT_ATTESTATION_VERSION : null},
      ${input.consentRowId ?? null}::uuid,
      ${sent ? 'sent' : 'rendered'},
      ${sent ? sql()`NOW() - INTERVAL '1 day' - INTERVAL '2 minutes'` : null},
      ${sent ? sql()`NOW() - INTERVAL '1 day' - INTERVAL '1 minute'` : null},
      ${sent ? sql()`NOW() - INTERVAL '1 day' + INTERVAL '7 microseconds'` : null},
      ${sent ? `msg-${id}` : null},
      ${sent ? 'provider 421 for remy@example.test, retried' : null},
      ${sent ? sql()`NOW() - INTERVAL '20 hours'` : null},
      ${sent ? 'hard' : null},
      ${sent ? sql()`NOW() - INTERVAL '19 hours'` : null},
      ${input.attributedReviewId ?? null}::uuid,
      ${input.attributedReviewId ? sql()`NOW() - INTERVAL '5 hours'` : null},
      ${input.attributedReviewId ? 'full_name' : null},
      ${input.attributedReviewId ? sql().json({ window_days: 14 }) : null}
    )
  `;
  return id;
}

async function seedReview(): Promise<string> {
  const id = randomUUID();
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${id}::uuid, ${businessId()}::uuid, 'zernio', ${`remnant-${id}`},
      ${`zernio://remnant-1350/reviews/${id}`}, 'zernio://remnant-1350/locations/1',
      'Remy Remnant', 5, 'Remnant fixture review', NOW(), NOW(), ${REVIEW_STATUS.NEW}
    )
  `;
  return id;
}

async function seedConsent(email: string): Promise<string> {
  const id = randomUUID();
  await sql()`
    INSERT INTO solicitation_consent (
      id, channel, normalized_handle, business_id, basis, attestation_version, attested_at
    ) VALUES (
      ${id}::uuid, 'email', ${email}, ${businessId()}::uuid, 'owner_attested',
      ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  return id;
}

async function seedToken(email: string, askId: string, outreachId: string): Promise<string> {
  const id = randomUUID();
  await sql()`
    INSERT INTO solicitation_unsubscribe_tokens (
      id, token_hash, normalized_handle, channel, account_id, business_id,
      ask_id, outreach_id, sent_at
    ) VALUES (
      ${id}::uuid, ${id.replaceAll('-', '').padEnd(64, '0')}, ${email}, 'email',
      ${accountId()}::uuid, ${businessId()}::uuid, ${askId}::uuid, ${outreachId}::uuid, NOW()
    )
  `;
  return id;
}

/** Every column of one row as text, so "byte-identical" means exactly that. */
async function rowAsText(table: 'solicitation_outreach' | 'solicitation_asks', id: string): Promise<Record<string, string | null>> {
  const [row] = await sql()<{ row: Record<string, string | null> }[]>`
    SELECT (
      SELECT jsonb_object_agg(e.key, e.value #>> '{}')
      FROM jsonb_each(to_jsonb(t)) AS e
    ) AS row
    FROM ${sql()(table)} t
    WHERE t.id = ${id}::uuid
  `;
  if (!row) throw new Error(`${table} row ${id} is absent`);
  return typeof row.row === 'string' ? (JSON.parse(row.row) as Record<string, string | null>) : row.row;
}

async function rowExists(table: 'solicitation_outreach' | 'solicitation_asks', id: string): Promise<boolean> {
  const rows = await sql()`SELECT 1 FROM ${sql()(table)} WHERE id = ${id}::uuid`;
  return rows.length > 0;
}

async function tableColumns(table: string): Promise<string[]> {
  const rows = await sql()<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `;
  return rows.map((row) => row.column_name);
}

async function del(contactId: string): Promise<boolean> {
  return deleteContact(sql(), accountId(), businessId(), contactId);
}

describeWithDb(
  'contact delete leaves an Outreach remnant (live DB, #1350)',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_096_SOLICITATION_SUPPRESSIONS,
        MIGRATION_110_SEND_GOVERNORS,
        MIGRATION_126_OUTREACH_REMNANT,
      ]);
      tenant = await seedTenantAccount(db, { accountDisplayName: 'Remnant Fixture' });
      const location = await seedLocation(db, tenant.accountId, { name: 'Remnant Location' });
      seededBusinessId = location.businessId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db || !tenant) return;
      // Neither ledger carries an FK the account cascade reaches (096: purge is
      // explicit, never a cascade side effect), so sweep both by hand.
      await db`DELETE FROM solicitation_unsubscribe_tokens WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM solicitation_suppressions WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM solicitation_consent WHERE business_id = ${businessId()}::uuid`;
      await db`DELETE FROM contact_csv_uploads WHERE account_id = ${tenant.accountId}::uuid`;
      await db`DELETE FROM reviews WHERE business_id = ${businessId()}::uuid`;
    });

    afterAll(async () => {
      try {
        if (db && tenant) {
          if (seededBusinessId) await db`DELETE FROM businesses WHERE id = ${seededBusinessId}::uuid`;
          await cleanupTenantAccount(db, { accountId: tenant.accountId, userId: tenant.userId });
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

    describe('schema (migration 126)', () => {
      it('cuts all three cascade edges with COLUMN-SCOPED SET NULL, keeping tenant scope', async () => {
        const rows = await sql()<{ conname: string; def: string }[]>`
          SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
          WHERE conname IN (
            'solicitation_asks_contact_business_fk',
            'solicitation_outreach_contact_business_fk',
            'solicitation_outreach_ask_tenant_fk',
            'solicitation_asks_batch_contact_uniq'
          )
        `;
        const def = new Map(rows.map((row) => [row.conname, row.def]));
        expect(def.get('solicitation_asks_contact_business_fk')).toBe(
          'FOREIGN KEY (contact_id, business_id) REFERENCES solicitation_contacts(id, business_id) ON DELETE SET NULL (contact_id)',
        );
        expect(def.get('solicitation_outreach_contact_business_fk')).toBe(
          'FOREIGN KEY (contact_id, business_id) REFERENCES solicitation_contacts(id, business_id) ON DELETE SET NULL (contact_id)',
        );
        expect(def.get('solicitation_outreach_ask_tenant_fk')).toBe(
          'FOREIGN KEY (ask_id, account_id, business_id) REFERENCES solicitation_asks(id, account_id, business_id) ON DELETE SET NULL (ask_id)',
        );
        // Trap 4: NULLS DISTINCT (the default) is what lets two remnants share a
        // batch. pg renders NULLS NOT DISTINCT explicitly, so its absence here IS
        // the default.
        expect(def.get('solicitation_asks_batch_contact_uniq')).toBe('UNIQUE (batch_id, contact_id)');
      });

      it('classifies every column of both tables as kept, redacted or lifecycle (anonymity guard)', async () => {
        const outreachClassified = [...OUTREACH_KEPT, ...OUTREACH_REDACTED, ...OUTREACH_LIFECYCLE];
        const askClassified = [...ASK_KEPT, ...ASK_REDACTED, ...ASK_LIFECYCLE];
        // No column is in two classes.
        expect(new Set(outreachClassified).size).toBe(outreachClassified.length);
        expect(new Set(askClassified).size).toBe(askClassified.length);
        // A new column that is not classified fails here, by name.
        expect(await tableColumns('solicitation_outreach')).toEqual([...outreachClassified].sort());
        expect(await tableColumns('solicitation_asks')).toEqual([...askClassified].sort());
      });
    });

    describe('deleteContact', () => {
      it('keeps the sent outreach row as a remnant: person gone, signal byte-identical', async () => {
        const batch = await seedBatch();
        const contact = await seedContact(batch);
        const consentId = await seedConsent(contact.email);
        const reviewId = await seedReview();
        const askId = await seedAsk(batch, contact.id, 'send');
        const outreachId = await seedOutreach({
          batch,
          askId,
          contactId: contact.id,
          shape: 'sent_bounced',
          consentRowId: consentId,
          attributedReviewId: reviewId,
        });
        const before = await rowAsText('solicitation_outreach', outreachId);
        // The fixture must populate every redacted column, or "emptied" proves nothing.
        for (const column of OUTREACH_REDACTED) {
          expect(before[column], column).not.toBeNull();
        }
        expect(before.interpolation_inputs).not.toBe('{}');

        expect(await del(contact.id)).toBe(true);

        const after = await rowAsText('solicitation_outreach', outreachId);
        expect(after.contact_id).toBeNull();
        expect(after.ask_id).toBe(askId); // the ask survives, so the link does
        expect(after.body_redacted_at).not.toBeNull();
        for (const column of OUTREACH_REDACTED) {
          if (column === 'interpolation_inputs') expect(after[column]).toBe('{}');
          else expect(after[column], column).toBeNull();
        }
        for (const column of OUTREACH_KEPT) {
          expect(after[column], column).toBe(before[column]);
        }
        // The four columns the Send breaker reads, named once more on purpose.
        for (const column of ['sent_at', 'bounced_at', 'complained_at', 'bounce_kind'] as const) {
          expect(after[column], column).not.toBeNull();
          expect(after[column]).toBe(before[column]);
        }
        expect(await rowExists('solicitation_asks', askId)).toBe(true);
      });

      it('keeps settled asks as remnants reduced to their decision discriminant', async () => {
        const batch = await seedBatch();
        const contact = await seedContact(batch);
        const sendAskId = await seedAsk(batch, contact.id, 'send');
        await seedOutreach({ batch, askId: sendAskId, contactId: contact.id, shape: 'sent_bounced' });
        const otherBatch = await seedBatch();
        const withholdAskId = await seedAsk(otherBatch, contact.id, 'over_contacted');
        const sendBefore = await rowAsText('solicitation_asks', sendAskId);
        const withholdBefore = await rowAsText('solicitation_asks', withholdAskId);

        await del(contact.id);

        const sendAfter = await rowAsText('solicitation_asks', sendAskId);
        const withholdAfter = await rowAsText('solicitation_asks', withholdAskId);
        expect(sendAfter.contact_id).toBeNull();
        expect(withholdAfter.contact_id).toBeNull();
        expect(JSON.parse(sendAfter.evidence!)).toEqual({ decision: 'send' });
        expect(JSON.parse(withholdAfter.evidence!)).toEqual({
          decision: 'withhold',
          reason: 'over_contacted',
        });
        for (const column of ASK_KEPT) {
          expect(sendAfter[column], column).toBe(sendBefore[column]);
          expect(withholdAfter[column], column).toBe(withholdBefore[column]);
        }
      });

      it('deletes an in-flight ask and its live attempt outright, as before (no bodyless live row)', async () => {
        const batch = await seedBatch();
        const contact = await seedContact(batch);
        const liveAskId = await seedAsk(batch, contact.id, 'send');
        const liveOutreachId = await seedOutreach({
          batch,
          askId: liveAskId,
          contactId: contact.id,
          shape: 'rendered',
        });
        // A send ask whose render has not landed yet: in flight too.
        const unrenderedBatch = await seedBatch();
        const unrenderedAskId = await seedAsk(unrenderedBatch, contact.id, 'send');

        await del(contact.id);

        expect(await rowExists('solicitation_outreach', liveOutreachId)).toBe(false);
        expect(await rowExists('solicitation_asks', liveAskId)).toBe(false);
        expect(await rowExists('solicitation_asks', unrenderedAskId)).toBe(false);
      });

      it('lets two remnants share one batch (NULLS DISTINCT, trap 4)', async () => {
        const batch = await seedBatch();
        const first = await seedContact(batch);
        const second = await seedContact(batch);
        const firstAsk = await seedAsk(batch, first.id, 'over_contacted');
        const secondAsk = await seedAsk(batch, second.id, 'over_contacted');

        expect(await del(first.id)).toBe(true);
        expect(await del(second.id)).toBe(true);

        const [row] = await sql()<{ remnants: number }[]>`
          SELECT COUNT(*)::int AS remnants FROM solicitation_asks
          WHERE batch_id = ${batch.batchId}::uuid AND contact_id IS NULL
            AND id IN (${firstAsk}::uuid, ${secondAsk}::uuid)
        `;
        expect(row?.remnants).toBe(2);
      });

      it('leaves the Suppression ledger untouched and cuts the token links to the remnant', async () => {
        const batch = await seedBatch();
        const contact = await seedContact(batch);
        await seedConsent(contact.email);
        const askId = await seedAsk(batch, contact.id, 'send');
        const outreachId = await seedOutreach({
          batch,
          askId,
          contactId: contact.id,
          shape: 'sent_bounced',
        });
        const tokenId = await seedToken(contact.email, askId, outreachId);
        await sql().begin((tx) =>
          recordSuppression(tx, {
            scope: 'account',
            channel: 'email',
            normalizedHandle: contact.email,
            accountId: accountId(),
            source: 'owner_manual',
            createdByUserId: tenant!.userId,
          }),
        );
        const suppressionBefore = await sql()`
          SELECT * FROM solicitation_suppressions WHERE normalized_handle = ${contact.email}
        `;
        expect(suppressionBefore).toHaveLength(1);

        await del(contact.id);

        const suppressionAfter = await sql()`
          SELECT * FROM solicitation_suppressions WHERE normalized_handle = ${contact.email}
        `;
        expect(suppressionAfter).toEqual(suppressionBefore);
        const consent = await sql()`
          SELECT 1 FROM solicitation_consent WHERE normalized_handle = ${contact.email}
        `;
        expect(consent).toHaveLength(0);
        // The token keeps its handle (statutory redemption must still work) but
        // no longer points at the remnant — a join through it would re-identify
        // the anonymous row.
        const [token] = await sql()<
          { normalized_handle: string; ask_id: string | null; outreach_id: string | null; account_id: string | null }[]
        >`
          SELECT normalized_handle, ask_id::text, outreach_id::text, account_id::text
          FROM solicitation_unsubscribe_tokens WHERE id = ${tokenId}::uuid
        `;
        expect(token).toEqual({
          normalized_handle: contact.email,
          ask_id: null,
          outreach_id: null,
          account_id: accountId(),
        });
      });

      it('still refuses a contact outside the caller account and touches nothing', async () => {
        const batch = await seedBatch();
        const contact = await seedContact(batch);
        const askId = await seedAsk(batch, contact.id, 'send');
        const outreachId = await seedOutreach({ batch, askId, contactId: contact.id, shape: 'sent_bounced' });
        const before = await rowAsText('solicitation_outreach', outreachId);

        expect(await deleteContact(sql(), randomUUID(), businessId(), contact.id)).toBe(false);

        expect(await rowAsText('solicitation_outreach', outreachId)).toEqual(before);
      });
    });

    describe('readers of a nullable contact_id', () => {
      it('the Send breaker window reads the same counts before and after every contact is deleted', async () => {
        // 100 sends, 3 hard bounces: a 3% breach. Before #1350 the cascade took
        // every row with its contact and this finding went to null.
        const batch = await seedBatch();
        const contacts: string[] = [];
        for (let i = 0; i < 100; i += 1) {
          const contact = await seedContact(batch);
          const askId = await seedAsk(batch, contact.id, 'send');
          const outreachId = await seedOutreach({ batch, askId, contactId: contact.id, shape: 'sent_bounced' });
          if (i >= 3) {
            await sql()`
              UPDATE solicitation_outreach SET bounced_at = NULL, bounce_kind = NULL, complained_at = NULL
              WHERE id = ${outreachId}::uuid
            `;
          }
          contacts.push(contact.id);
        }
        const measure = async (): Promise<unknown> => {
          let finding: unknown;
          await sql()
            .begin(async (tx) => {
              finding = await evaluateSendBreaker(tx);
              throw new Rollback();
            })
            .catch(expectRollback);
          return finding;
        };

        const before = await measure();
        expect(before).not.toBeNull();
        for (const contactId of contacts) {
          await del(contactId);
        }
        const after = await measure();

        expect(after).toEqual(before);
      });

      it('the Requests panel renders without the erased person and counts only the living', async () => {
        const batch = await seedBatch();
        const kept = await seedContact(batch);
        const erased = await seedContact(batch);
        await seedAsk(batch, kept.id, 'over_contacted');
        await seedAsk(batch, erased.id, 'over_contacted');

        await del(erased.id);
        const view = await readLatestBatch(sql(), accountId(), businessId(), { sendLane: true });

        expect(view.state).toBe('built');
        if (view.state !== 'built') return;
        expect(view.evaluated).toBe(1);
        expect(view.held).toBe(1);
        const overContacted = view.groups.find((group) => group.reason === 'over_contacted');
        expect(overContacted?.total).toBe(1);
        expect(overContacted?.sample.map((row) => row.contactId)).toEqual([kept.id]);
      });
    });

    describe('account purge', () => {
      it('still removes every remnant, and the verifier arms assert absence', async () => {
        const purgeTenant = await seedTenantAccount(sql(), { accountDisplayName: 'Remnant Purge' });
        try {
          const location = await seedLocation(sql(), purgeTenant.accountId, { name: 'Remnant Purge Loc' });
          const batch = await seedBatch(purgeTenant.accountId, location.businessId);
          const contact = await seedContact(batch, location.businessId);
          const askId = await seedAsk(batch, contact.id, 'send', purgeTenant.accountId, location.businessId);
          const outreachId = await seedOutreach({
            batch,
            askId,
            contactId: contact.id,
            shape: 'sent_bounced',
            tenantAccountId: purgeTenant.accountId,
            bizId: location.businessId,
          });
          expect(
            await deleteContact(sql(), purgeTenant.accountId, location.businessId, contact.id),
          ).toBe(true);
          expect(await rowExists('solicitation_outreach', outreachId)).toBe(true);

          await runContentPurgeStage(sql(), {
            account_id: purgeTenant.accountId,
          } as AccountOffboardingPurgeRow);

          expect(await rowExists('solicitation_outreach', outreachId)).toBe(false);
          expect(await rowExists('solicitation_asks', askId)).toBe(false);
          const input = { accountId: purgeTenant.accountId, offboardingId: randomUUID() };
          for (const table of ['solicitation_outreach', 'solicitation_asks'] as const) {
            const [row] = await verificationQuery(table, input, sql());
            expect(Number(row?.violation_count), table).toBe(0);
          }
        } finally {
          await sql()`DELETE FROM contact_csv_uploads WHERE account_id = ${purgeTenant.accountId}::uuid`;
          await sql()`DELETE FROM businesses WHERE account_id = ${purgeTenant.accountId}::uuid`;
          await cleanupTenantAccount(sql(), purgeTenant);
        }
      });
    });
  },
);
