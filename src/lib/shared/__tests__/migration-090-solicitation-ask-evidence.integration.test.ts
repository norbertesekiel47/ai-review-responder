import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  MIGRATION_090_SOLICITATION_ASK_EVIDENCE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { CONSENT_ATTESTATION_VERSION } from '@/lib/solicitation/attestation';

// #593. `solicitation_asks.evidence` is JSONB NOT NULL with no CHECK: the
// decision discriminant was enforced only by a throw in batch-view.ts's
// `parseEvidence`, at read time, and that read builds the whole Requests view
// from one statement — so one malformed row failed the view for the entire
// account. 090 moves enforcement to the write.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS, then exercises the constraint's behaviour.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/090_solicitation_ask_evidence_check.sql',
);

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('migration 090 checked-in SQL contract', () => {
  const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
  const migrationSql = normalizeSql(rawSql);
  // Comment-free view: the header quotes the rejected `=` spelling in order to
  // explain it, which a naive scan of the whole file would read as the bug.
  const statements = normalizeSql(
    rawSql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n'),
  );

  it('exists', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('compares NULL-safely — a CHECK passes on NULL, so `=` would let the #593 row in', () => {
    // `evidence->>'decision' = status` yields NULL when the key is absent, and
    // a CHECK rejects only FALSE. The first draft of 090 had exactly that hole.
    expect(statements).not.toContain("evidence->>'decision' = status");
    expect(statements).not.toContain("evidence->>'reason' = withheld_reason");
    expect(statements).toContain("evidence->>'decision' IS NOT DISTINCT FROM status");
  });

  it('ties the JSONB discriminant to the status and withheld_reason columns', () => {
    expect(migrationSql).toContain(normalizeSql(`
      ADD CONSTRAINT solicitation_asks_evidence_matches_columns CHECK (
        jsonb_typeof(evidence) = 'object'
        AND evidence->>'decision' IS NOT DISTINCT FROM status
        AND evidence->>'reason' IS NOT DISTINCT FROM withheld_reason
      ) NOT VALID
    `));
  });

  it('validates the constraint rather than leaving it NOT VALID', () => {
    // NOT VALID alone would constrain new writes and say nothing about rows
    // already stored — half the fix, and the silent half.
    expect(migrationSql).toContain(
      'VALIDATE CONSTRAINT solicitation_asks_evidence_matches_columns',
    );
  });

  it('bounds the ALTER with a lock_timeout', () => {
    expect(migrationSql).toContain("SET lock_timeout = '5s'");
  });
});

describeWithDb(
  'migration 090 live constraint behaviour',
  { enabled: Boolean(testDatabaseUrl), timeout: 30_000 },
  () => {
    let tenant: TenantSeed | undefined;
    const businessId = randomUUID();
    const uploadId = randomUUID();
    const contactId = randomUUID();
    const batchId = randomUUID();

    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_090_SOLICITATION_ASK_EVIDENCE,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Migration 090 Owner',
        accountDisplayName: 'Migration 090 Account',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Migration 090 Business', 'M090 Owner',
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
          'migration-090.csv', 1,
          ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
          NULL, 'completed', ${db.json({ accepted: 0 })},
          ${tenant.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
        )
      `;
      await db`
        INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
        VALUES (
          ${contactId}::uuid, ${businessId}::uuid, 'M090 Candidate',
          ${`${contactId}@example.test`}, ${uploadId}::uuid
        )
      `;
      await db`
        INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
        VALUES (
          ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid, ${uploadId}::uuid
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM solicitation_asks WHERE batch_id = ${batchId}::uuid`;
          await db`DELETE FROM solicitation_batches WHERE id = ${batchId}::uuid`;
          await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
          await db.end({ timeout: 5 });
        }
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, 120_000);

    const insertAsk = (input: {
      status: string;
      withheldReason: string | null;
      evidence: unknown;
    }): Promise<unknown> =>
      db!`
        INSERT INTO solicitation_asks (
          id, account_id, business_id, batch_id, contact_id,
          status, withheld_reason, evidence, decided_at
        ) VALUES (
          ${randomUUID()}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
          ${batchId}::uuid, ${contactId}::uuid,
          ${input.status}, ${input.withheldReason},
          ${db!.json(input.evidence as never)}, NOW()
        )
      `;

    // Deleted between cases so the (batch_id, contact_id) unique constraint
    // never masks a CHECK failure as a duplicate-key one.
    const clearAsks = (): Promise<unknown> =>
      db!`DELETE FROM solicitation_asks WHERE batch_id = ${batchId}::uuid`;

    it('accepts the send decision batch-builder actually writes', async () => {
      await clearAsks();
      await expect(
        insertAsk({
          status: 'send',
          withheldReason: null,
          evidence: {
            contact_id: contactId,
            policy_version: 'restraint_v1',
            decided_at: '2026-07-27T00:00:00.000Z',
            decision: 'send',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('accepts a withhold decision whose evidence reason matches the column', async () => {
      await clearAsks();
      await expect(
        insertAsk({
          status: 'withhold',
          withheldReason: 'no_consent',
          evidence: {
            contact_id: contactId,
            policy_version: 'restraint_v1',
            decided_at: '2026-07-27T00:00:00.000Z',
            decision: 'withhold',
            reason: 'no_consent',
            upload_id: uploadId,
          },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects evidence with no decision discriminant — the #593 row', async () => {
      await clearAsks();
      await expect(
        insertAsk({
          status: 'send',
          withheldReason: null,
          evidence: { contact_id: contactId, policy_version: 'restraint_v1' },
        }),
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });

    it.each([
      ['a JSON array', []],
      ['a JSON string', 'send'],
      ['a JSON number', 7],
    ])('rejects evidence that is %s rather than an object', async (_label, value) => {
      await clearAsks();
      await expect(
        insertAsk({ status: 'send', withheldReason: null, evidence: value }),
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });

    it('rejects a JSON null evidence value', async () => {
      // `sql.json(null)` binds SQL NULL, not JSONB 'null' — a different
      // rejection. Cast explicitly so this exercises jsonb_typeof, not NOT NULL.
      await clearAsks();
      await expect(
        db!`
          INSERT INTO solicitation_asks (
            id, account_id, business_id, batch_id, contact_id,
            status, withheld_reason, evidence, decided_at
          ) VALUES (
            ${randomUUID()}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
            ${batchId}::uuid, ${contactId}::uuid,
            'send', NULL, 'null'::jsonb, NOW()
          )
        `,
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });

    it('rejects a discriminant that contradicts the status column', async () => {
      await clearAsks();
      await expect(
        insertAsk({
          status: 'send',
          withheldReason: null,
          evidence: { decision: 'withhold', reason: 'no_consent' },
        }),
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });

    it('rejects a withhold whose evidence reason contradicts withheld_reason', async () => {
      await clearAsks();
      await expect(
        insertAsk({
          status: 'withhold',
          withheldReason: 'no_consent',
          evidence: { decision: 'withhold', reason: 'suppressed' },
        }),
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });

    it('rejects a send decision carrying a stray reason', async () => {
      // withheld_reason is NULL for a send (088's own constraint), so evidence
      // must not smuggle one in — that is the shape parseEvidence would render
      // as a withhold under a send row.
      await clearAsks();
      await expect(
        insertAsk({
          status: 'send',
          withheldReason: null,
          evidence: { decision: 'send', reason: 'no_consent' },
        }),
      ).rejects.toThrow('solicitation_asks_evidence_matches_columns');
    });
  },
);
