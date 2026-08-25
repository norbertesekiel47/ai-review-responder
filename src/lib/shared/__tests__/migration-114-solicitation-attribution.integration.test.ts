// Shape assertions for migration 114 — the four `solicitation_outreach`
// attribution columns, the one-directional consistency CHECK, and the three
// indexes (the unique attributed-review index, the candidate index and the
// `job_outbox` in-flight index).
//
// Task 0 authors every promised title parked; Task 1 lands the migration and
// the bodies. The runnable form follows
// `migration-091-send-mode-spine.integration.test.ts` for shape and
// `approval-system-halt.integration.test.ts` for the cross-process live-DB
// lock, and asserts the schema with `assertSchemaReady` from
// `@/lib/shared/__tests__/helpers/schema-ready` rather than applying any DDL at
// run time (`ci:live-db-suites` R2).
//
// ── what this suite deliberately does NOT do ────────────────────────────────
//
// It executes NO DDL. `pnpm test:db:setup` provisions the container to head and
// every case here either reads the catalogue (`information_schema`,
// `pg_indexes`, `pg_constraint`) or writes rows under its own seeded tenant.
// That is why the file is absent from `MIGRATION_SHAPE_FILES` in
// `scripts/ci/live-db-suites-audit.ts`: that allowlist exists for suites where
// APPLYING the migration is the subject (074 and 088 re-execute the checked-in
// SQL through `db.unsafe()`), and adding a read-only suite to it would widen a
// sanctioned-DDL escape hatch over a file that needs no escape. Every read-only
// shape suite that landed after #573 — 093, 096, 098, 099, 100, 105 — is absent
// for the same reason.
//
// It DOES take the cross-process lock, per the header above. The lock helper's
// own rule would permit skipping it (own-tenant writes, catalogue reads), but
// the uniqueness case proves a GLOBAL index, and serializing one fast suite
// costs nothing next to a false green.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { ATTRIBUTION_RULES } from '@/lib/solicitation/attribution';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  insertOutreach,
  seedContactCsvUpload,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { REVIEW_STATUS } from '@/lib/reviews/status';

/**
 * Declared here rather than exported from `schema-ready.ts` because Task 1's
 * file scope is the migration plus this suite. The moment a SECOND suite needs
 * it — Task 4's `job-outbox-helpers-attribution.integration.test.ts` will —
 * it belongs in `schema-ready.ts` beside the other migration requirements,
 * which is that module's stated "owned in ONE place" contract.
 */
const MIGRATION_114_SOLICITATION_ATTRIBUTION: SchemaRequirement = {
  migration: '114_solicitation_attribution',
  columns: [
    'solicitation_outreach.attributed_review_id',
    'solicitation_outreach.attributed_at',
    'solicitation_outreach.attribution_rule',
    'solicitation_outreach.attribution_detail',
  ],
  indexes: [
    'solicitation_outreach_attributed_review_uniq',
    'solicitation_outreach_attribution_candidates',
    'job_outbox_solicitation_attribution_inflight',
  ],
  constraints: [
    {
      table: 'solicitation_outreach',
      name: 'solicitation_outreach_attribution_consistency',
    },
  ],
};

/**
 * One of the two rule names the CHECK admits. Local on purpose: the exported
 * constant arrives with `src/lib/solicitation/attribution.ts` in Task 2, and
 * the CHECK — not this suite — is the authority until then.
 */
const RULE_FULL_NAME = 'full_name';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 114 integration database was not initialized');
  return db;
}

function seededTenant(): TenantSeed {
  if (!tenant) throw new Error('migration 114 integration tenant was not seeded');
  return tenant;
}

function accountId(): string {
  return seededTenant().accountId;
}

// ── fixtures ────────────────────────────────────────────────────────────────

interface OutreachChain {
  businessId: string;
  uploadId: string;
  batchId: string;
  contactId: string;
  askId: string;
  outreachId: string;
}

/**
 * One location and the whole upload → contact → batch → ask → outreach chain
 * under it, ending in a `sent` row — the only delivery status the candidate
 * index's predicate admits, and the only one an attribution can land on.
 */
async function seedChain(label: string): Promise<OutreachChain> {
  const businessId = randomUUID();
  await seedLocation(sql(), accountId(), {
    businessId,
    name: `Attribution ${label} Location`,
    // `businesses_account_primary_uniq` allows ONE primary per account, so the
    // second location of the two-business case is a secondary.
    isPrimary: label === 'A',
  });

  const uploadId = await seedContactCsvUpload(sql(), {
    accountId: accountId(),
    businessId,
    attestedByUserId: seededTenant().userId,
    filenamePrefix: `attribution-114-${label}`,
    attestationVersion: 'attribution-114-test',
  });

  const batchId = randomUUID();
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id, created_at, built_at
    ) VALUES (
      ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${uploadId}::uuid, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'
    )
  `;

  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, ${`Attribution ${label} Contact`},
            ${`${contactId}@example.test`}, ${uploadId}::uuid)
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
        policy_version: 'attribution-114-fixture',
        decision: 'send',
      })},
      NOW() - INTERVAL '2 days'
    )
  `;

  // 091's status/timestamp CHECK requires queued_at AND sent_at of a `sent`
  // row; both are SQL intervals, so nothing here depends on a JS round-trip.
  const outreachId = await insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    deliveryStatus: 'sent',
    queuedAt: sql()`NOW() - INTERVAL '47 hours'`,
    sentAt: sql()`NOW() - INTERVAL '46 hours'`,
  });

  return { businessId, uploadId, batchId, contactId, askId, outreachId };
}

let chainA: OutreachChain | undefined;
let chainB: OutreachChain | undefined;

function chain(which: 'A' | 'B'): OutreachChain {
  const value = which === 'A' ? chainA : chainB;
  if (!value) throw new Error(`migration 114 chain ${which} was not seeded`);
  return value;
}

/** A review under `businessId`. Identity is the provider name, which is UNIQUE. */
async function seedReview(businessId: string, reviewerName: string): Promise<string> {
  const reviewId = randomUUID();
  const marker = `attribution-114-${reviewId}`;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, 'zernio',
      ${marker}, ${`zernio://attribution-114/reviews/${marker}`},
      'zernio://attribution-114/locations/1', ${reviewerName},
      5, 'Attribution fixture review', NOW() - INTERVAL '3 hours',
      NOW() - INTERVAL '2 hours', ${REVIEW_STATUS.NEW}
    )
  `;
  return reviewId;
}

/**
 * Records an attribution exactly as the Task 2+ worker will.
 *
 * `attribution_detail` carries NO personal data (deviation D2) — no reviewer
 * name, no contact name. Both live in their own tables and the owner surface
 * joins for them; a denormalized copy here would outlive the review's deletion,
 * because the FK is ON DELETE SET NULL and this row survives it.
 */
async function attribute(outreachId: string, reviewId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_outreach
       SET attributed_review_id = ${reviewId}::uuid,
           attributed_at        = NOW(),
           attribution_rule     = ${RULE_FULL_NAME},
           attribution_detail   = ${sql().json({
             rule: RULE_FULL_NAME,
             matched_field: 'reviewer_name',
             candidate_count: 1,
           })},
           updated_at           = NOW()
     WHERE id = ${outreachId}::uuid
       AND account_id = ${accountId()}::uuid
  `;
}

interface AttributionRow {
  attributed_review_id: string | null;
  attributed_at: Date | null;
  attribution_rule: string | null;
  attribution_detail: unknown;
  delivery_status: string;
}

async function readAttribution(outreachId: string): Promise<AttributionRow> {
  const [row] = await sql()<AttributionRow[]>`
    SELECT attributed_review_id::text AS attributed_review_id, attributed_at,
           attribution_rule, attribution_detail, delivery_status
    FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid AND account_id = ${accountId()}::uuid
  `;
  if (!row) throw new Error(`outreach ${outreachId} vanished`);
  return row;
}

/** Postgres.js behind PgBouncer can hand JSONB back as a string. */
function jsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('expected a JSONB object');
  }
  return parsed as Record<string, unknown>;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function indexDefinition(indexName: string): Promise<string> {
  const [row] = await sql()<{ definition: string }[]>`
    SELECT indexdef AS definition FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = ${indexName}
  `;
  if (!row) throw new Error(`index ${indexName} is absent`);
  return squash(row.definition);
}

describeWithDb(
  'migration 114 solicitation attribution',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_114_SOLICITATION_ATTRIBUTION]);
      tenant = await seedTenantAccount(db, {
        userName: 'Attribution 114 Owner',
        accountDisplayName: 'Attribution 114 Account',
      });
      chainA = await seedChain('A');
      chainB = await seedChain('B');
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      for (const which of ['A', 'B'] as const) {
        const { businessId } = chain(which);
        // Attribution first, reviews second: clearing the columns keeps the
        // consistency CHECK satisfied at every intermediate state.
        await sql()`
          UPDATE solicitation_outreach
             SET attributed_review_id = NULL, attributed_at = NULL,
                 attribution_rule = NULL, attribution_detail = NULL
           WHERE business_id = ${businessId}::uuid
        `;
        await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      }
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          for (const seeded of [chainA, chainB]) {
            if (!seeded) continue;
            await db`DELETE FROM solicitation_outreach WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM solicitation_asks WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM solicitation_batches WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM solicitation_contacts WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM contact_csv_uploads WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM reviews WHERE business_id = ${seeded.businessId}::uuid`;
            await db`DELETE FROM businesses WHERE id = ${seeded.businessId}::uuid`;
          }
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
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('migration 114: attribution columns, the consistency CHECK and the partial unique index exist', async () => {
      const cols = await sql()<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'solicitation_outreach'
           AND column_name IN ('attributed_review_id','attributed_at','attribution_rule','attribution_detail')
         ORDER BY column_name
      `;
      expect(cols.map((c) => c.column_name)).toEqual([
        'attributed_at',
        'attributed_review_id',
        'attribution_detail',
        'attribution_rule',
      ]);
      // All four nullable: an Outreach row is unattributed for its whole life
      // unless a review matches, which is the common case.
      expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);

      const [check] = await sql()<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'solicitation_outreach'::regclass
           AND conname = 'solicitation_outreach_attribution_consistency'
      `;
      expect(check).toBeDefined();

      const idx = await sql()<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'solicitation_outreach'
           AND indexname IN (
             'solicitation_outreach_attributed_review_uniq',
             'solicitation_outreach_attribution_candidates'
           )
         ORDER BY indexname
      `;
      expect(idx.map((i) => i.indexname)).toEqual([
        'solicitation_outreach_attributed_review_uniq',
        'solicitation_outreach_attribution_candidates',
      ]);
    });

    it('migration 114: the CHECK and all three index definitions carry the required keys, uniqueness and predicates', async () => {
      const [constraint] = await sql()<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'solicitation_outreach'::regclass
           AND conname = 'solicitation_outreach_attribution_consistency'
      `;
      const checkDef = squash(constraint?.definition ?? '');
      // One-directional: a review id REQUIRES the other three, but a timestamp
      // may outlive its review id — which is what ON DELETE SET NULL leaves.
      expect(checkDef).toContain('(attributed_review_id IS NULL)');
      expect(checkDef).toContain('(attributed_at IS NOT NULL)');
      // BUILT from ATTRIBUTION_RULES, not hand-typed (branch-review C4/L6).
      // `attribution.ts` claims that constant "byte-matches migration 114's
      // CHECK"; hand-typing the same text here left the claim unenforced and the
      // array with no runtime reader at all. Deriving it means adding a rule to
      // the TypeScript union without adding it to the migration turns this red.
      expect(checkDef).toContain(
        `(attribution_rule = ANY (ARRAY[${ATTRIBUTION_RULES.map((r) => `'${r}'::text`).join(', ')}]))`,
      );
      expect(checkDef).toContain('(attribution_detail IS NOT NULL)');
      // A CHECK is SATISFIED by NULL, so without the `IS TRUE` wrapper a row
      // carrying a review id, a timestamp and a detail with a NULL rule
      // evaluates to NULL and is ADMITTED. The wrapper is the whole guard.
      expect(checkDef).toContain('IS TRUE');

      const uniq = await indexDefinition('solicitation_outreach_attributed_review_uniq');
      // Keyed on the review id ALONE — the composite (business_id, …) form
      // would have permitted the same review once per business.
      expect(uniq).toContain('CREATE UNIQUE INDEX');
      expect(uniq).toContain('ON public.solicitation_outreach USING btree (attributed_review_id)');
      expect(uniq).toContain('WHERE (attributed_review_id IS NOT NULL)');

      const candidates = await indexDefinition('solicitation_outreach_attribution_candidates');
      expect(candidates).toContain('CREATE INDEX');
      expect(candidates).not.toContain('CREATE UNIQUE INDEX');
      expect(candidates).toContain(
        'ON public.solicitation_outreach USING btree (business_id, sent_at DESC)',
      );
      // The unattributed marker is `attributed_at IS NULL`, NEVER
      // `attributed_review_id IS NULL`: the FK nulls the review id on a review
      // delete, so keying on it would make an already-attributed row a
      // candidate again and let the next match overwrite retained provenance.
      expect(candidates).toContain(
        "WHERE ((delivery_status = 'sent'::text) AND (attributed_at IS NULL) " +
          'AND (bounced_at IS NULL) AND (complained_at IS NULL))',
      );
      expect(candidates).not.toContain('attributed_review_id');

      const inflight = await indexDefinition('job_outbox_solicitation_attribution_inflight');
      expect(inflight).toContain('CREATE UNIQUE INDEX');
      expect(inflight).toContain('ON public.job_outbox USING btree (topic, aggregate_id)');
      // Members AND order: the status literal is a byte-for-byte contract owned
      // by `job-outbox-status.ts`, and the helper's `ON CONFLICT … WHERE`
      // infers this index by comparing predicates.
      expect(inflight).toContain(
        "WHERE ((topic = 'solicitation_attribution'::text) AND " +
          "(status = ANY (ARRAY['pending'::text, 'dispatching'::text, 'dispatched'::text])))",
      );
    });

    it('migration 114: one review cannot be attributed to outreach rows in two businesses', async () => {
      // The review belongs to business A, and nothing in the schema ties an
      // attribution to the review's own location — which is precisely why the
      // uniqueness has to be GLOBAL rather than per-business.
      const reviewId = await seedReview(chain('A').businessId, 'Dana Fixture');
      await attribute(chain('A').outreachId, reviewId);

      await expect(attribute(chain('B').outreachId, reviewId)).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'solicitation_outreach_attributed_review_uniq',
      });

      // The first attribution stands and the second row is untouched.
      expect((await readAttribution(chain('A').outreachId)).attributed_review_id).toBe(reviewId);
      const rowB = await readAttribution(chain('B').outreachId);
      expect(rowB.attributed_review_id).toBeNull();
      expect(rowB.attributed_at).toBeNull();
    });

    it('migration 114: deleting an attributed review nulls attributed_review_id and leaves the outreach row', async () => {
      const reviewId = await seedReview(chain('A').businessId, 'Erin Fixture');
      await attribute(chain('A').outreachId, reviewId);
      expect((await readAttribution(chain('A').outreachId)).attributed_review_id).toBe(reviewId);

      await sql()`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;

      // ON DELETE SET NULL, never CASCADE: the row recorded a real send to a
      // real person and must survive the review's deletion.
      const after = await readAttribution(chain('A').outreachId);
      expect(after.attributed_review_id).toBeNull();
      expect(after.delivery_status).toBe('sent');
      // `attributed_at` is never cleared — it is the honest "has this row ever
      // been attributed" fact, and the CHECK is one-directional, so the row
      // stays legal with its timestamp, rule and detail retained.
      expect(after.attributed_at).toBeInstanceOf(Date);
      expect(after.attribution_rule).toBe(RULE_FULL_NAME);
      const detail = jsonObject(after.attribution_detail);
      expect(detail.rule).toBe(RULE_FULL_NAME);
      // The retained evidence carries no personal data (D2): nothing here is a
      // copy of the reviewer's or the contact's name.
      expect(Object.keys(detail).sort()).toEqual(['candidate_count', 'matched_field', 'rule']);
    });
  },
);
