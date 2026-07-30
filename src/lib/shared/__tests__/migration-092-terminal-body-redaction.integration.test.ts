import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  checksum,
  deriveDispatchStamps,
  insertOutreach,
} from '@/lib/shared/__tests__/helpers/outreach-fixture';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';

// Shape suite for migration 092 — outreach body redaction reaches every
// TERMINAL row, not just `sent` (#636, deferred from #624 as finding S2).
//
// The defect 092 closes was true BY CONSTRUCTION rather than by oversight:
// 091's body-presence CHECK required `sent_at IS NOT NULL` of any redaction,
// and its status/timestamp CHECK made `sent_at IS NOT NULL` equivalent to
// `delivery_status = 'sent'`. So `body_redacted_at` was unrepresentable on a
// `withheld`/`cancelled`/`failed`/`unknown` row, and those rows kept their
// bodies AND their `interpolation_inputs` (contact_first_name, visit_note)
// permanently. The sweep could not have reached them even if the constraint
// had allowed it: it keys on `sent_at`, which is NULL on all four.
//
// This suite therefore proves three separable facts, because they can fail
// independently:
//
//  1. Each non-`sent` terminal status can now CARRY a redaction (constraint).
//  2. No LIVE status can — the wedge 091's arm existed to prevent is still
//     closed, at any age (constraint).
//  3. The sweep's predicate and the index's predicate name the SAME statuses
//     (text). The poller re-spells the list literally, because a bind
//     parameter would stop the planner inferring the partial index — so
//     "these three agree" is a fact with no single owner and needs asserting.
//
// Row-level sweep BEHAVIOUR is proved separately, against the real poller, in
// worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then exercises behaviour.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/092_terminal_outreach_body_redaction.sql',
);

/** The four terminal statuses 091 left unredactable. `sent` is arm 9's. */
const UNSENT_TERMINAL_STATUSES = ['withheld', 'cancelled', 'failed', 'unknown'] as const;

/** 091's status/reason CHECK is total, so each status needs a legal reason. */
const REASON_BY_STATUS: Record<(typeof UNSENT_TERMINAL_STATUSES)[number], string> = {
  withheld: 'suppressed',
  cancelled: 'owner_veto',
  failed: 'send_failed',
  unknown: 'send_indeterminate',
};

/** A redaction is only legal once the body is gone and the inputs are empty. */
const LIVE_STATUSES = ['rendered', 'queued', 'sending'] as const;

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('migration 092 checked-in SQL contract', () => {
  const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
  // Comment-free view: the header quotes the REJECTED `NOT IN (live)` spelling
  // in order to explain why it was rejected, which a scan of the whole file
  // would read as the shipped predicate.
  const statements = normalizeSql(
    rawSql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n'),
  );

  it('exists', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('names the terminal set positively rather than negating the live set', () => {
    // Direction of failure, not style. Under the explicit list a future status
    // is non-redactable until someone adds it — a retention gap, loud at test
    // time. Under `NOT IN ('rendered','queued','sending')` a future LIVE status
    // would be redactable the day it is added, silently reopening the wedge
    // that this arm exists to prevent.
    expect(statements).toContain(
      "delivery_status IN ('sent', 'withheld', 'cancelled', 'failed', 'unknown')",
    );
    expect(statements).not.toContain("delivery_status NOT IN");
  });

  it('bounds the ALTER with a lock_timeout and validates the constraint', () => {
    expect(statements).toContain("SET lock_timeout = '5s'");
    // NOT VALID alone would constrain new writes and say nothing about stored
    // rows — half the change, and the silent half.
    expect(statements).toContain('VALIDATE CONSTRAINT solicitation_outreach_body_presence');
  });

  it('carries 091 T2 forward — a redaction still implies emptied interpolation_inputs', () => {
    // 092 REPLACES the whole constraint, so every arm it does not mean to
    // change has to be re-spelled. Dropping this one would silently undo #624's
    // T2 fix: the sweep would still empty the column, but a second writer of
    // body_redacted_at could stamp a redaction and leave the PII in place.
    expect(statements).toContain(
      "body_redacted_at IS NULL OR interpolation_inputs = '{}'::jsonb",
    );
  });
});

describeWithDb(
  'migration 092 live constraint + predicate behaviour',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    let tenant: TenantSeed | undefined;
    const businessId = randomUUID();
    const uploadId = randomUUID();
    const contactId = randomUUID();
    const batchId = randomUUID();
    const askId = randomUUID();

    /** Ids every row in this suite shares; only the ask attempt varies. */
    function chain() {
      return {
        accountId: tenant!.accountId,
        businessId,
        batchId,
        askId,
        contactId,
      };
    }

    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION,
      ]);

      tenant = await seedTenantAccount(db, {
        userName: 'Migration 092 Owner',
        accountDisplayName: 'Migration 092 Account',
      });
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Migration 092 Business', 'M092 Owner',
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
          'migration-092.csv', 1, ${checksum(uploadId)},
          NULL, 'completed', ${db.json({ accepted: 1 })},
          ${tenant.userId}::uuid, NOW(), 'migration-092-test', NOW()
        )
      `;
      await db`
        INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
        VALUES (
          ${contactId}::uuid, ${businessId}::uuid, 'M092 Candidate',
          ${`${contactId}@example.test`}, ${uploadId}::uuid
        )
      `;
      await db`
        INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id)
        VALUES (
          ${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid, ${uploadId}::uuid
        )
      `;
      await db`
        INSERT INTO solicitation_asks (
          id, account_id, business_id, batch_id, contact_id, status, evidence, decided_at
        ) VALUES (
          ${askId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${batchId}::uuid, ${contactId}::uuid, 'send',
          ${db.json({ contact_id: contactId, policy_version: 'migration-092', decision: 'send' })},
          NOW()
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // `solicitation_outreach_one_live_per_ask` and the (ask_id, attempt_no)
    // unique are both scoped to one ask, so rows are cleared between cases
    // rather than sharing the ask — otherwise a CHECK failure could be masked
    // by a duplicate-key one, or vice versa.
    afterEach(async () => {
      await db!`DELETE FROM solicitation_outreach WHERE ask_id = ${askId}::uuid`;
    });

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
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

    // ── 1. every non-`sent` terminal can carry a redaction ───────────────────

    it.each(UNSENT_TERMINAL_STATUSES)(
      'accepts a redacted %s row — the state 091 made unrepresentable',
      async (deliveryStatus) => {
        await expect(
          insertOutreach(db!, {
            ...chain(),
            deliveryStatus,
            dispositionReason: REASON_BY_STATUS[deliveryStatus],
            renderedSubject: null,
            sentAt: null,
            bodyRedactedAt: new Date(),
          }),
        ).resolves.toBeDefined();
      },
    );

    it('still accepts a redacted sent row — 092 widens the arm, it does not move it', async () => {
      const sentAt = new Date();
      await expect(
        insertOutreach(db!, {
          ...chain(),
          deliveryStatus: 'sent',
          renderedSubject: null,
          sentAt,
          ...deriveDispatchStamps({ deliveryStatus: 'sent', sentAt }),
          bodyRedactedAt: new Date(sentAt.getTime() + 1_000),
        }),
      ).resolves.toBeDefined();
    });

    // ── 2. no live status can, at any age ────────────────────────────────────

    it.each(LIVE_STATUSES)(
      'rejects a redacted %s row — a live attempt must never be bodyless',
      async (deliveryStatus) => {
        // The hazard the arm exists for: a bodyless live row can neither send
        // nor settle, and wedges its whole batch behind
        // solicitation_outreach_one_live_per_ask. 092 relaxes "redaction means
        // sent" to "redaction means terminal", which must not touch this.
        await expect(
          insertOutreach(db!, {
            ...chain(),
            deliveryStatus,
            renderedSubject: null,
            ...deriveDispatchStamps({ deliveryStatus }),
            bodyRedactedAt: new Date(),
          }),
        ).rejects.toThrow(/solicitation_outreach_body_presence/);
      },
    );

    it('rejects a redacted live row that is older than the retention window', async () => {
      // Age is not a licence. The sweep's predicate excludes live rows, but the
      // constraint is the thing that makes that non-negotiable for every other
      // writer, and a 400-day-old `rendered` row is the case where a naive
      // age-only sweep would do the damage.
      await expect(
        insertOutreach(db!, {
          ...chain(),
          deliveryStatus: 'rendered',
          renderedSubject: null,
          renderedAt: db!`NOW() - INTERVAL '400 days'`,
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
    });

    it('rejects a terminal redaction that leaves the body or the inputs behind', async () => {
      // Two arms 092 carries forward verbatim, asserted on the statuses it just
      // opened up — otherwise "cancelled rows are now redactable" could be true
      // in the loosest possible sense.
      await expect(
        insertOutreach(db!, {
          ...chain(),
          deliveryStatus: 'cancelled',
          dispositionReason: 'owner_veto',
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);

      await expect(
        insertOutreach(db!, {
          ...chain(),
          attemptNo: 2,
          deliveryStatus: 'cancelled',
          dispositionReason: 'owner_veto',
          renderedSubject: null,
          interpolationInputs: { contact_first_name: 'Dana' },
          bodyRedactedAt: new Date(),
        }),
      ).rejects.toThrow(/solicitation_outreach_body_presence/);
    });

    // ── 3. the three spellings of the status set agree ───────────────────────

    it('gives the new sweep index the same four statuses the poller filters on', async () => {
      const [row] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_solicitation_outreach_unsent_terminal_redaction_sweep'
      `;
      expect(row).toBeDefined();
      const indexdef = normalizeSql(row!.indexdef);
      expect(indexdef).toContain('btree (rendered_at)');
      expect(indexdef).toContain('body_redacted_at IS NULL');
      for (const status of UNSENT_TERMINAL_STATUSES) {
        expect(indexdef).toContain(`'${status}'::text`);
      }
      // `sent` is arm 9's, keyed on sent_at. If it appeared here the two arms
      // would both claim the same rows and the counts would double-report.
      expect(indexdef).not.toContain("'sent'::text");
    });

    it('plans the sweep predicate as an index scan with no residual filter', async () => {
      // The predicate is what makes the arm bounded: if the planner cannot
      // prove it implies the partial index, the sweep degrades to a seq scan of
      // every outreach row on every cycle. Sequential scan is disabled so this
      // asserts the index is USABLE rather than merely cheapest on an empty
      // table; an unmatched predicate would still show a Seq Scan or a Filter.
      //
      // Run inside a transaction with SET LOCAL so the seqscan setting is
      // scoped to this probe, and through template queries rather than
      // `sql.unsafe` — `ci:live-db-suites` reads `.unsafe(` in a file that also
      // names supabase/migrations as run-time DDL, which this is not.
      const plan = await db!.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        return tx<{ 'QUERY PLAN': string }[]>`
          EXPLAIN SELECT id FROM solicitation_outreach
          WHERE rendered_at < NOW() - make_interval(days => 90)
            AND body_redacted_at IS NULL
            AND delivery_status IN ('withheld', 'cancelled', 'failed', 'unknown')
          ORDER BY rendered_at
          LIMIT 5000
        `;
      });
      const planText = JSON.stringify(plan);
      expect(planText).toContain('idx_solicitation_outreach_unsent_terminal_redaction_sweep');
      // No Sort node: ORDER BY rendered_at is served by the index itself, which
      // is what makes progress monotonic across cycles.
      expect(planText).not.toContain('Sort');
    });
  },
);
