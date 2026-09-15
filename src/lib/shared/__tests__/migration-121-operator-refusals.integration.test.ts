// Execute migration 121 under the exclusive local DB lock; never infer its
// safety from SQL text. Existing lane behavior is also covered by the 116 suite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock, assertLocalTestDatabaseUrl, resolveTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS, type LiveDbLock,
} from './helpers/live-db-lock';
import { seedTenantAccount, seedLocation, cleanupTenantAccount, type TenantSeed } from './live-db-tenant';
import { REFUSAL_SOURCES, REFUSAL_CATEGORIES, REFUSAL_SUBJECT_TYPES } from '@/lib/refusals/vocabulary';
import { writeRefusalEvent, type WriteRefusalEventInput } from '@/lib/refusals/write';

const url = resolveTestDatabaseUrl();
const migrationPath = 'supabase/migrations/121_operator_refusals.sql';
const changedConstraints = [
  'refusal_events_refusal_source_check',
  'refusal_events_refusal_category_check',
  'refusal_events_subject_type_check',
  'refusal_events_source_subject_pairing',
  'refusal_events_business_pairing',
];
let db: Sql;
let lock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let businessId: string;

async function definitions() {
  return db<{ conname: string; definition: string; convalidated: boolean }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint WHERE conrelid = 'public.refusal_events'::regclass
    ORDER BY conname
  `;
}

async function insert(overrides: {
  source?: string | null; business?: string | null; subject?: string | null;
  subjectId?: string | null; code?: string | null; codes?: string[] | null;
  category?: string | null;
} = {}) {
  if (!tenant) throw new Error('migration 121 tenant missing');
  const source = overrides.source === undefined ? 'operator_content_refused' : overrides.source;
  return db`
    INSERT INTO refusal_events
      (id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
       refusal_category, vocabulary_version, subject_type, subject_id, occurred_at)
    VALUES (${randomUUID()}::uuid, ${tenant.accountId}::uuid,
      ${overrides.business === undefined ? businessId : overrides.business}::uuid,
      ${source}, ${overrides.code === undefined ? 'invented_business_fact' : overrides.code},
      ${overrides.codes ?? null}::text[],
      ${overrides.category === undefined ? 'request_not_allowed' : overrides.category},
      'migration_121_test',
      ${overrides.subject === undefined ? 'operator_refusal' : overrides.subject},
      ${overrides.subjectId === undefined ? randomUUID() : overrides.subjectId}::uuid,
      clock_timestamp())
  `;
}

// Preserve the whole public table catalogue, not just the target table's RLS.
// Constraints deliberately exclude only the five declared replacements.
async function catalogue() {
  return db`
    SELECT c.relname, c.relowner::regrole::text AS owner,
      c.relrowsecurity, c.relforcerowsecurity, c.relacl::text,
      (SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid::regtype::text,
          a.attnotnull, a.attacl::text, pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d
         ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::text AS columns,
      (SELECT jsonb_agg(jsonb_build_array(p.polname, p.polcmd, p.polpermissive,
          p.polroles::text, pg_get_expr(p.polqual, p.polrelid),
          pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY p.polname)
       FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies,
      (SELECT jsonb_agg(jsonb_build_array(x.conname, pg_get_constraintdef(x.oid),
          x.convalidated) ORDER BY x.conname)
       FROM pg_constraint x WHERE x.conrelid = c.oid
         AND NOT (c.relname = 'refusal_events'
           AND x.conname = ANY(${changedConstraints}::text[])))::text AS constraints,
      (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text)
       FROM pg_index i WHERE i.indrelid = c.oid)::text AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `;
}

describeWithDb('migration 121 Operator refusals', { enabled: Boolean(url), timeout: 180_000 }, () => {
  beforeAll(async () => {
    const localUrl = assertLocalTestDatabaseUrl(url);
    lock = await acquireLiveDbLock(localUrl);
    db = postgres(localUrl, { max: 1, prepare: false, connection: { statement_timeout: 30_000 } });
    tenant = await seedTenantAccount(db);
    businessId = (await seedLocation(db, tenant.accountId)).businessId;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);
  afterEach(async () => {
    if (tenant) await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
  });
  afterAll(async () => {
    try {
      if (tenant) {
        await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid AND account_id = ${tenant.accountId}::uuid`;
        await cleanupTenantAccount(db, tenant);
      }
    } finally {
      try { if (db) await db.end({ timeout: 5 }); } finally { await lock?.release(); }
    }
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  it('migration 121 admits both Operator refusal lanes and preserves all existing lane constraints', async () => {
    await insert();
    await insert({ source: 'operator_policy_refused', business: null, code: 'incentives' });
    for (const invalid of [
      { business: null },
      { source: 'operator_policy_refused', business: businessId },
      { subject: 'response' }, { subject: null }, { subjectId: null },
      { code: null }, { codes: ['invented_business_fact'] },
      { source: 'unknown_lane' }, { category: 'unknown_category' },
    ]) {
      await expect(insert(invalid)).rejects.toMatchObject({ code: '23514' });
    }
    for (const invalid of [{ source: null }, { category: null }]) {
      await expect(insert(invalid)).rejects.toMatchObject({ code: '23502' });
    }
    // The old account-wide lane still points at no subject.
    await insert({ source: 'autonomy_suspended', business: null, subject: null,
      subjectId: null, code: 'judge_unavailable', category: 'autonomy_paused' });
    await expect(insert({ source: 'autonomy_suspended', business: null }))
      .rejects.toMatchObject({ code: '23514' });
    const checks = await definitions();
    for (const [name, members] of [
      ['refusal_events_refusal_source_check', REFUSAL_SOURCES],
      ['refusal_events_refusal_category_check', REFUSAL_CATEGORIES],
      ['refusal_events_subject_type_check', REFUSAL_SUBJECT_TYPES],
    ] as const) {
      const check = checks.find((row) => row.conname === name);
      expect(check?.convalidated).toBe(true);
      const stored = [...(check?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      expect(stored.sort()).toEqual([...members].sort());
    }
  });

  it('the shared ledger writer preserves both Operator lane scopes and retry identity', async () => {
    if (!tenant) throw new Error('migration 121 tenant missing');
    const common = {
      accountId: tenant.accountId,
      refusalCategory: 'request_not_allowed',
      subjectType: 'operator_refusal',
      allRefusalCodes: null,
      occurredAt: 'transaction_time',
    } as const;
    const inputs: WriteRefusalEventInput[] = [
      { ...common, refusalSource: 'operator_content_refused', businessId,
        subjectId: randomUUID(), refusalCode: 'invented_business_fact' },
      { ...common, refusalSource: 'operator_policy_refused', businessId: null,
        subjectId: randomUUID(), refusalCode: 'incentives' },
    ];
    await db.begin(async (tx) => {
      for (const input of inputs) {
        await writeRefusalEvent(tx, input);
        await writeRefusalEvent(tx, input);
      }
    });
    const rows = await db`
      SELECT refusal_source, business_id, subject_type, subject_id, refusal_code,
        refusal_category, all_refusal_codes, occurred_at = created_at AS decision_in_transaction
      FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid ORDER BY refusal_source
    `;
    expect(rows).toEqual(inputs.map((input) => ({
      refusal_source: input.refusalSource, business_id: input.businessId,
      subject_type: input.subjectType, subject_id: input.subjectId,
      refusal_code: input.refusalCode, refusal_category: input.refusalCategory,
      all_refusal_codes: null, decision_in_transaction: true,
    })));
  });

  it('migration 121 changes only the declared refusal constraints and preserves access posture', async () => {
    const migration = readFileSync(join(process.cwd(), migrationPath), 'utf8');
    const original = await definitions();
    const before = await catalogue();
    const oldSources = "('held_draft','auto_post_revoked','autonomy_suspended','ask_withheld','outreach_withheld','batch_halted','policy_gate_held')";
    const oldCategories = "('unsafe_content','watchdog_unavailable','below_our_bar','no_permission','wrong_moment','autonomy_paused','missing_information','owner_review_required')";
    const oldSubjects = "('response','solicitation_ask','solicitation_outreach','solicitation_batch')";
    const old = [
      `CHECK (refusal_source IN ${oldSources})`,
      `CHECK (refusal_category IN ${oldCategories})`,
      `CHECK (subject_type IN ${oldSubjects})`,
      `CHECK ((CASE refusal_source
        WHEN 'held_draft' THEN subject_type = 'response'
        WHEN 'policy_gate_held' THEN subject_type = 'response'
        WHEN 'auto_post_revoked' THEN subject_type = 'response'
        WHEN 'ask_withheld' THEN subject_type = 'solicitation_ask'
        WHEN 'outreach_withheld' THEN subject_type = 'solicitation_outreach'
        WHEN 'batch_halted' THEN subject_type = 'solicitation_batch'
        WHEN 'autonomy_suspended' THEN subject_type IS NULL END) IS TRUE)`,
      "CHECK ((business_id IS NOT NULL) = (refusal_source <> 'autonomy_suspended'))",
    ];
    try {
      await db.begin(async (tx) => {
        for (const [index, name] of changedConstraints.entries()) {
          await tx.unsafe(`ALTER TABLE refusal_events DROP CONSTRAINT ${name},
            ADD CONSTRAINT ${name} ${old[index]}`);
        }
      });
      const degraded = await definitions();
      expect(degraded.filter((row) => changedConstraints.includes(row.conname))).toHaveLength(5);
      expect(degraded.every((row) => !row.definition.includes('operator_'))).toBe(true);
      expect(degraded.every((row) => !row.definition.includes('request_not_allowed'))).toBe(true);
      await expect(insert()).rejects.toMatchObject({ code: '23514' });
      await db.unsafe(migration);
      await insert();
      await insert({ source: 'operator_policy_refused', business: null });
      expect(await catalogue()).toEqual(before);
      const applied = await definitions();
      expect(applied).toEqual(original);
      // Re-running the real file preserves the same validated constraints.
      await db.unsafe(migration);
      expect(await definitions()).toEqual(applied);
      expect(await catalogue()).toEqual(before);
    } finally {
      await db.unsafe('ROLLBACK');
      if (tenant) await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
      await db.begin(async (tx) => {
        for (const row of original.filter((item) => changedConstraints.includes(item.conname))) {
          await tx.unsafe(`ALTER TABLE refusal_events DROP CONSTRAINT IF EXISTS ${row.conname},
            ADD CONSTRAINT ${row.conname} ${row.definition}`);
        }
      });
    }
  });
});
