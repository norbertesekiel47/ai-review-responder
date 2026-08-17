import { randomUUID, createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '../../../src/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '../../../src/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
} from '../../../src/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '../../../src/lib/shared/__tests__/live-db-tenant';
import { insertOutreach } from '../../../src/lib/shared/__tests__/helpers/outreach-fixture';
import { abortingExecutor } from '../../../src/lib/shared/__tests__/helpers/abort-injection';
import { CONSENT_ATTESTATION_VERSION } from '../../../src/lib/solicitation/attestation';
import { handleSolicitationResendEvent } from '../resend/solicitation-lane';

// Live-DB suite for the Solicitation lane's seven event effects (#657 Task 6,
// spec §5). RED until `worker/ingress/resend/solicitation-lane.ts` exists.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions the schema to
// head and this suite ASSERTS it with assertSchemaReady. It holds the
// cross-process live-DB lock because one case watches pg_stat_activity for a
// backend parked on a row lock — an unrelated live-DB writer in another vitest
// process would make that unreadable — and because it writes the same
// `solicitation_*` tables the sibling solicitation suites do.
//
// Four things can only be proven against the real schema:
//
//  1. THE WRITE SURFACE. The lane writes ONLY the async signal columns migration
//     091 calls "columns, NOT statuses (D13)" — bounced_at, complained_at,
//     provider_error — plus the Suppression ledger. delivery_status, sent_at and
//     unsubscribed_at belong to #630 and to the RFC 8058 POST respectively, and
//     a webhook write to any of them would race 091's ladder CHECKs.
//  2. THE TRANSACTION BOUNDARY. The attribution read, its FOR UPDATE lock, the
//     outreach UPDATE and the ledger insert are one commit or none.
//  3. THE LEDGER PREDICATES. recordSuppression's byte-for-byte ON CONFLICT
//     clauses only no-op against the REAL partial unique indexes.
//  4. THE HANDLE. `solicitation_contacts.email` IS the Normalized handle
//     (migration 086); there is no `normalized_handle` column on that table.
//
// Deliberately NOT here: routing. That is pure and lives in
// resend-solicitation-routing.test.ts.

// The two ingress cases below (503 retry, duplicate svix id) drive the REAL
// handleResendWebhook, which reaches the shared src/lib/db/server client. That
// module reads DATABASE_POOL_URL at module-evaluation time, so the test database
// has to be in place before ANY import evaluates.
vi.hoisted(() => {
  const url = process.env.TEST_DATABASE_POOL_URL;
  if (url) process.env.DATABASE_POOL_URL = url;
});

const testDatabaseUrl = resolveTestDatabaseUrl();

const WEBHOOK_SECRET = `whsec_${Buffer.from('resend-solicitation-lane-int').toString('base64')}`;

let db: postgresType.Sql | undefined;
/** A SECOND connection, for the row-lock interleaving case. */
let otherDb: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let handleResendWebhook: typeof import('../resend').handleResendWebhook;

const businessId = randomUUID();
const usedSvixIds: string[] = [];

function sql(): postgresType.Sql {
  if (!db) throw new Error('solicitation lane integration database was not initialized');
  return db;
}

function other(): postgresType.Sql {
  if (!otherDb) throw new Error('solicitation lane second connection was not initialized');
  return otherDb;
}

function accountId(): string {
  if (!tenant) throw new Error('solicitation lane integration tenant was not seeded');
  return tenant.accountId;
}

// ── fixtures ──────────────────────────────────────────────────────────────

interface SeededOutreach {
  outreachId: string;
  /** The contact's `email` column — the Normalized handle for this channel. */
  handle: string;
  contactId: string;
  askId: string;
  batchId: string;
}

interface SeedOutreachInput {
  providerMessageId: string;
  /** Pre-existing bounded error from #630's dispatch, for the COALESCE case. */
  providerError?: string;
  renderedSubject?: string;
  renderedBody?: string;
}

/**
 * One account → business → upload → contact → batch → ask → Outreach row chain.
 * Built from the fixtures the sibling solicitation live-DB suites already use
 * (`seedTenantAccount`, `insertOutreach`) rather than a second seeding
 * vocabulary.
 *
 * The row is seeded as a REAL dispatched attempt (`delivery_status='sent'` with
 * its queued/sent stamps), because that is the only state in which a provider
 * webhook can refer to it — and it is what makes the "never writes
 * delivery_status / sent_at" cases meaningful.
 *
 * Every stamp is resolved in SQL off NOW(): postgres.js truncates timestamptz
 * microseconds, so a JS-derived stamp can mis-order against a NOW()-defaulted
 * sibling and trip a 091 ladder CHECK for a reason no case is about.
 */
async function seedOutreach(input: SeedOutreachInput): Promise<SeededOutreach> {
  const uploadId = randomUUID();
  const contactId = randomUUID();
  const batchId = randomUUID();
  const askId = randomUUID();
  const outreachId = randomUUID();
  const handle = `customer-${contactId}@example.test`;

  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`solicitation-lane-${uploadId}.csv`}, 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, 'Solicitation Lane Customer',
            ${handle}, ${uploadId}::uuid)
  `;
  await sql()`
    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
    VALUES (${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
            ${uploadId}::uuid, NOW())
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({ contact_id: contactId, decision: 'send', policy_version: 'lane-fixture' })},
      NOW()
    )
  `;
  await insertOutreach(sql(), {
    id: outreachId,
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    renderedSubject: input.renderedSubject,
    renderedBody: input.renderedBody,
    deliveryStatus: 'sent',
    queuedAt: sql()`NOW() - INTERVAL '2 seconds'`,
    sentAt: sql()`NOW() - INTERVAL '1 second'`,
  });
  await sql()`
    UPDATE solicitation_outreach
       SET provider_message_id = ${input.providerMessageId},
           provider_error = ${input.providerError ?? null}
     WHERE id = ${outreachId}::uuid
  `;

  return { outreachId, handle, contactId, askId, batchId };
}

interface OutreachSnapshot {
  delivery_status: string;
  disposition_reason: string | null;
  provider_error: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  unsubscribed_at: string | null;
  sent_at: string | null;
  queued_at: string | null;
}

/** Every column the lane could plausibly touch, as text so no µs is truncated. */
async function readOutreach(outreachId: string): Promise<OutreachSnapshot> {
  const [row] = await sql()<OutreachSnapshot[]>`
    SELECT delivery_status,
           disposition_reason,
           provider_error,
           bounced_at::text     AS bounced_at,
           complained_at::text  AS complained_at,
           unsubscribed_at::text AS unsubscribed_at,
           sent_at::text        AS sent_at,
           queued_at::text      AS queued_at
      FROM solicitation_outreach
     WHERE id = ${outreachId}::uuid
  `;
  if (!row) throw new Error(`outreach row ${outreachId} vanished`);
  return row;
}

interface LedgerRow {
  scope: string;
  source: string;
  channel: string;
  normalized_handle: string;
  account_id: string | null;
  suppressed_at: string;
}

async function readLedger(handle?: string): Promise<LedgerRow[]> {
  return handle === undefined
    ? sql()<LedgerRow[]>`
        SELECT scope, source, channel, normalized_handle, account_id,
               suppressed_at::text AS suppressed_at
          FROM solicitation_suppressions
         WHERE account_id = ${accountId()}::uuid
         ORDER BY suppressed_at
      `
    : sql()<LedgerRow[]>`
        SELECT scope, source, channel, normalized_handle, account_id,
               suppressed_at::text AS suppressed_at
          FROM solicitation_suppressions
         WHERE channel = 'email' AND normalized_handle = ${handle}
         ORDER BY suppressed_at
      `;
}

// ── console capture ───────────────────────────────────────────────────────
//
// createWorkerLogger emits one JSON object per line: info → console.log,
// warn → console.warn, error → console.error.

interface ConsoleCapture {
  lines: string[];
  warns: string[];
  restore: () => void;
}

function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const warns: string[] = [];
  const toLine = (args: unknown[]): string => args.map((a) => String(a)).join(' ');
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(toLine(args));
    }),
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const line = toLine(args);
      lines.push(line);
      warns.push(line);
    }),
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(toLine(args));
    }),
  ];
  return {
    lines,
    warns,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

// ── ingress helpers (the two cases that drive the real webhook) ────────────

function signedRequest(body: unknown, svixId: string): never {
  usedSvixIds.push(svixId);
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', secretBytes)
    .update(`${svixId}.${timestamp}.${rawBody}`)
    .digest('base64');
  return {
    body,
    rawBody,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  } as unknown as never;
}

function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (body: unknown) => {
      captured.body = body;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}

/**
 * Resolves once some backend is PARKED on a row lock whose statement matches
 * `fragment`, and returns that statement. Which statement waits is the whole
 * point: the correct lane parks on its `SELECT … FOR UPDATE OF o`, while an
 * implementation that read attribution OUTSIDE the transaction would sail past
 * the lock and park on the later UPDATE instead.
 */
async function waitForLockedQuery(fragment: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql()<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
    `;
    const hit = rows.find((row) => row.query.includes(fragment));
    if (hit) return hit.query;
    if (Date.now() > deadline) {
      throw new Error(
        `no backend ever parked on a lock while running a statement containing "${fragment}"; ` +
          `waiting statements: ${JSON.stringify(rows.map((r) => r.query))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeWithDb(
  'Resend solicitation lane effects (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      // Four connections: the handler's transaction, the pg_stat_activity probe,
      // and the fixture/assertion queries.
      db = postgres(databaseUrl, { max: 4, prepare: false });
      otherDb = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_096_SOLICITATION_SUPPRESSIONS,
      ]);

      process.env.DATABASE_POOL_URL = databaseUrl;
      process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const workerConfig = await import('../../../src/lib/config/worker');
      workerConfig.resetWorkerConfigForTests();
      ({ handleResendWebhook } = await import('../resend'));

      tenant = await seedTenantAccount(db, {
        userName: 'Solicitation Lane Owner',
        accountDisplayName: 'Solicitation Lane Account',
      });
      await db`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
        VALUES (${businessId}::uuid, 'Solicitation Lane Business', 'Lane Owner',
                ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db) return;
      vi.restoreAllMocks();
      // A Suppression ledger row has no expiry and no ordinary delete path, so a
      // leaked one is a permanent record — take the analytics rows
      // recordSuppression wrote in the same transaction with it.
      const ledger = await db<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions WHERE account_id = ${accountId()}::uuid
      `;
      for (const row of ledger) {
        await db`DELETE FROM analytics_events WHERE event_key = ${`solicitation_suppressed_${row.id}`}`;
      }
      await db`DELETE FROM solicitation_suppressions WHERE account_id = ${accountId()}::uuid`;
      await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
      if (usedSvixIds.length > 0) {
        await db`DELETE FROM inbound_events WHERE external_event_key = ANY(${usedSvixIds})`;
        usedSvixIds.length = 0;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // Release in the reverse of acquisition order, and on every path: a
    // `beforeAll` that failed after taking the lock still holds it, and a leaked
    // advisory lock blocks every other live-DB suite until the session dies.
    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM solicitation_suppressions WHERE account_id = ${accountId()}::uuid`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (otherDb) await otherDb.end({ timeout: 5 });
          if (db) await db.end({ timeout: 5 });
          // The ingress cases opened the shared db/server client; leaving its
          // sockets open hangs the vitest fork.
          const { sql: serverSql } = await import('../../../src/lib/db/server');
          await serverSql.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── §5.1 unmatched attribution ────────────────────────────────────────

    it('the solicitation lane warns and acks when no outreach row matches the provider message id', async () => {
      const captured = captureConsole();
      try {
        // email.failed is observability-only: nothing is lost that a later event
        // cannot re-establish, so §5.1's warn-and-ack is right for it.
        await expect(
          handleSolicitationResendEvent(sql(), 'email.failed', 'msg_unmatched_ack', {
            failed: { reason: 'unknown' },
          }),
        ).resolves.toBeUndefined();
      } finally {
        captured.restore();
      }

      const joined = captured.warns.join('\n');
      expect(joined).toMatch(/matched no outreach row/i);
      expect(joined).toContain('msg_unmatched_ack');
    });

    it('the solicitation lane writes no suppression when no outreach row matches the provider message id', async () => {
      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_unmatched_soft', {
        bounce: { type: 'Transient' },
      });

      // A ledger row with no artifact behind it is unattributable and permanent.
      expect(await readLedger()).toHaveLength(0);
    });

    // ── §5.3 bounce ───────────────────────────────────────────────────────

    it('the solicitation lane records bounced_at and the classified reason for a permanent bounce', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_hard_bounce' });

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_hard_bounce', {
        bounce: { type: 'Permanent' },
      });

      const row = await readOutreach(seeded.outreachId);
      expect(row.bounced_at).not.toBeNull();
      // The classifier is reused VERBATIM from the notification path, so the
      // admin overview's `bounced:hard:` prefix filter cannot disagree with it.
      expect(row.provider_error).toBe('bounced:hard:permanent');
    });

    it('the solicitation lane writes a bounce_permanent global suppression for a permanent bounce', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_hard_bounce_ledger' });

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_hard_bounce_ledger', {
        bounce: { type: 'hard_bounce' },
      });

      const ledger = await readLedger(seeded.handle);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        scope: 'global',
        channel: 'email',
        source: 'bounce_permanent',
        normalized_handle: seeded.handle,
        // account_id on a global row is PROVENANCE — which account's send
        // produced it — never the Suppression scope.
        account_id: accountId(),
      });
    });

    it('the solicitation lane records bounced_at without suppressing for a temporary bounce', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_soft_bounce' });

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_soft_bounce', {
        bounce: { type: 'Transient' },
      });

      const row = await readOutreach(seeded.outreachId);
      expect(row.bounced_at).not.toBeNull();
      expect(row.provider_error).toBe('bounced:soft:transient');
      // A full mailbox is not an opt-out. Suppressing here would permanently
      // silence a real customer over a transient condition.
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    it('the solicitation lane treats an unknown bounce type as soft and writes no suppression', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_unknown_bounce' });

      // No bounce/reason/status field at all — the payload shape the classifier
      // falls through to 'unknown' on.
      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_unknown_bounce', {});

      const row = await readOutreach(seeded.outreachId);
      expect(row.provider_error).toBe('bounced:soft:unknown');
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    // ── §5.3 complaint ────────────────────────────────────────────────────

    it('the solicitation lane records complained_at and writes a complaint global suppression', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_complaint' });

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_complaint', {});

      const row = await readOutreach(seeded.outreachId);
      expect(row.complained_at).not.toBeNull();
      // A complaint is the recipient speaking — always global, always immediate.
      const ledger = await readLedger(seeded.handle);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ scope: 'global', source: 'complaint' });
    });

    // ── §6.2 provider-suppressed ──────────────────────────────────────────

    it('the solicitation lane writes a provider_suppressed global suppression for email.suppressed', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_provider_suppressed' });

      await handleSolicitationResendEvent(sql(), 'email.suppressed', 'msg_provider_suppressed', {});

      const ledger = await readLedger(seeded.handle);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ scope: 'global', source: 'provider_suppressed' });
      // There is no Outreach column for this event — the ledger IS the record.
      const row = await readOutreach(seeded.outreachId);
      expect(row.bounced_at).toBeNull();
      expect(row.complained_at).toBeNull();
    });

    it('the solicitation lane logs loudly for email.suppressed', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_suppressed_loud' });
      const captured = captureConsole();
      try {
        await handleSolicitationResendEvent(sql(), 'email.suppressed', 'msg_suppressed_loud', {});
      } finally {
        captured.restore();
      }

      // Resend's suppression list is team-wide across every domain and API key
      // INCLUDING transactional, so a real divergence from our ledger is an
      // admin-attention condition — a warn, not an info line.
      const joined = captured.warns.join('\n');
      expect(joined).toMatch(/suppressed/i);
      expect(joined).toContain(seeded.outreachId);
      // ...and it must never name the person it is about.
      expect(captured.lines.join('\n')).not.toContain(seeded.handle);
    });

    // ── §5.3 send failure ─────────────────────────────────────────────────

    it('the solicitation lane records provider_error for email.failed and writes no suppression', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_failed' });

      await handleSolicitationResendEvent(sql(), 'email.failed', 'msg_failed', {
        failed: { reason: 'Mailbox Full' },
      });

      const row = await readOutreach(seeded.outreachId);
      expect(row.provider_error).toBe('failed:mailbox full');
      // A send-side failure says nothing about the recipient's wishes, and it
      // must not touch the bounce column either.
      expect(row.bounced_at).toBeNull();
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    // ── observability-only events ─────────────────────────────────────────

    it('the solicitation lane writes nothing for email.delivery_delayed', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_delayed' });
      const before = await readOutreach(seeded.outreachId);

      await handleSolicitationResendEvent(sql(), 'email.delivery_delayed', 'msg_delayed', {});

      // A delay is not a bounce. Suppressing on one would silence a recipient
      // whose mail server was merely slow.
      expect(await readOutreach(seeded.outreachId)).toEqual(before);
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    it('the solicitation lane writes nothing for email.sent', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_sent' });
      const before = await readOutreach(seeded.outreachId);

      await handleSolicitationResendEvent(sql(), 'email.sent', 'msg_sent', {});

      expect(await readOutreach(seeded.outreachId)).toEqual(before);
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    it('the solicitation lane writes nothing for email.delivered', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_delivered' });
      const before = await readOutreach(seeded.outreachId);

      await handleSolicitationResendEvent(sql(), 'email.delivered', 'msg_delivered', {});

      // §5.3's delivered_at effect is dropped: the column does not exist and
      // this ticket carries no migration.
      expect(await readOutreach(seeded.outreachId)).toEqual(before);
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    it('the solicitation lane refuses email.opened without throwing', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_opened' });
      const before = await readOutreach(seeded.outreachId);
      const captured = captureConsole();
      try {
        // Refused, not crashed on: a throw here would 503 and make Resend retry
        // an event we will never want.
        await expect(
          handleSolicitationResendEvent(sql(), 'email.opened', 'msg_opened', {}),
        ).resolves.toBeUndefined();
      } finally {
        captured.restore();
      }

      expect(captured.warns.join('\n')).toMatch(/unsupported|refus/i);
      expect(await readOutreach(seeded.outreachId)).toEqual(before);
    });

    it('the solicitation lane refuses email.clicked without throwing', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_clicked' });
      const before = await readOutreach(seeded.outreachId);
      const captured = captureConsole();
      try {
        await expect(
          handleSolicitationResendEvent(sql(), 'email.clicked', 'msg_clicked', {}),
        ).resolves.toBeUndefined();
      } finally {
        captured.restore();
      }

      expect(captured.warns.join('\n')).toMatch(/unsupported|refus/i);
      expect(await readOutreach(seeded.outreachId)).toEqual(before);
    });

    // ── the write surface, stated as three prohibitions ───────────────────

    it('the solicitation lane never writes delivery_status', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_no_status' });

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_no_status', {
        bounce: { type: 'Permanent' },
      });
      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_no_status', {});
      await handleSolicitationResendEvent(sql(), 'email.failed', 'msg_no_status', {
        failed: { reason: 'nope' },
      });

      const row = await readOutreach(seeded.outreachId);
      // #630 owns the send lifecycle. A webhook write here would race 091's
      // status/reason and status/timestamp ladder CHECKs.
      expect(row.delivery_status).toBe('sent');
      expect(row.disposition_reason).toBeNull();
      // ...and the signal columns DID move, so this is not a vacuous no-op.
      expect(row.bounced_at).not.toBeNull();
      expect(row.complained_at).not.toBeNull();
    });

    it('the solicitation lane never writes sent_at', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_no_sent_at' });
      const before = await readOutreach(seeded.outreachId);

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_no_sent_at', {
        bounce: { type: 'Permanent' },
      });
      await handleSolicitationResendEvent(sql(), 'email.delivered', 'msg_no_sent_at', {});

      const row = await readOutreach(seeded.outreachId);
      expect(row.sent_at).toBe(before.sent_at);
      expect(row.queued_at).toBe(before.queued_at);
      expect(row.bounced_at).not.toBeNull();
    });

    it('the solicitation lane never writes unsubscribed_at', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_no_unsub' });

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_no_unsub', {});
      await handleSolicitationResendEvent(sql(), 'email.suppressed', 'msg_no_unsub', {});

      const row = await readOutreach(seeded.outreachId);
      // The RFC 8058 one-click POST lands on worker/ingress/unsubscribe.ts. A
      // complaint is not an unsubscribe, and writing the column here would make
      // the two indistinguishable afterwards.
      expect(row.unsubscribed_at).toBeNull();
      expect(row.complained_at).not.toBeNull();
    });

    it('the solicitation lane preserves an existing provider_error rather than overwriting it', async () => {
      const seeded = await seedOutreach({
        providerMessageId: 'msg_preserve_error',
        providerError: 'send_failed:429_rate_limited',
      });

      await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_preserve_error', {
        bounce: { type: 'Permanent' },
      });

      const row = await readOutreach(seeded.outreachId);
      // #630 writes a bounded error class at dispatch; a later generic webhook
      // string would erase it. Same rule the Watchdog terminalizer adopted in
      // #736 — preserve a non-empty error, write the generic text as a fallback.
      expect(row.provider_error).toBe('send_failed:429_rate_limited');
      // The signal column still moves, and the ledger row is still written —
      // preservation is about the error text only.
      expect(row.bounced_at).not.toBeNull();
      expect(await readLedger(seeded.handle)).toHaveLength(1);
    });

    // ── the Normalized handle ─────────────────────────────────────────────

    it('the solicitation lane keys its suppression on the stored normalized handle from the contact row', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_handle_source' });

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_handle_source', {});

      const [row] = await readLedger(seeded.handle);
      // `solicitation_contacts.email` IS the Normalized handle (migration 086).
      // There is no `normalized_handle` column on that table — a query naming
      // one throws at runtime on every solicitation event.
      expect(row?.normalized_handle).toBe(seeded.handle);
      const [contact] = await sql()<{ email: string | null }[]>`
        SELECT email FROM solicitation_contacts WHERE id = ${seeded.contactId}::uuid
      `;
      expect(row?.normalized_handle).toBe(contact?.email);
    });

    it('the solicitation lane never normalizes the provider-echoed recipient address', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_echoed_recipient' });
      const echoed = '  SOMEONE.Else+tag@Example.TEST ';

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_echoed_recipient', {
        to: [echoed],
        email: echoed,
      });

      // Normalization happened ONCE, at CSV ingest. Re-deriving a handle from
      // provider-echoed text would mint a second key for the same person and let
      // a later send sail past the §1.2 lookup.
      const ledger = await readLedger();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.normalized_handle).toBe(seeded.handle);
      expect(await readLedger('someone.else+tag@example.test')).toHaveLength(0);
      expect(await readLedger(echoed.trim())).toHaveLength(0);
    });

    // ── the transaction boundary ──────────────────────────────────────────

    it('the solicitation lane commits the outreach signal write and the suppression row in one transaction', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_one_tx' });

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_one_tx', {});

      const row = await readOutreach(seeded.outreachId);
      const [ledger] = await readLedger(seeded.handle);
      // Postgres' NOW() is the TRANSACTION start timestamp, at microsecond
      // resolution. `complained_at` (NOW() in the UPDATE) and `suppressed_at`
      // (the ledger column's NOW() default) are therefore equal to the
      // microsecond if and only if both statements ran in ONE transaction —
      // two transactions could not agree on it.
      expect(ledger?.suppressed_at).toBeDefined();
      expect(row.complained_at).toBe(ledger?.suppressed_at);
    });

    it('a failed suppression write rolls back the outreach signal write', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_rollback_bounce' });

      // The abort originates in POSTGRES, not in JS: a plain throw does not put
      // the transaction into aborted state, which is the state the real hazard
      // produces. This INSERT violates
      // `solicitation_suppressions_account_scope_pairing` (an account-scoped row
      // requires an account_id), so it raises 23514 deterministically — and it
      // fails on the very table whose write this case is about. Never a
      // temporary constraint (house rule, #694).
      const poisonedSql = abortingExecutor(sql(), (tx) => tx`
        INSERT INTO solicitation_suppressions
          (id, channel, normalized_handle, scope, account_id, source)
        VALUES (${randomUUID()}::uuid, 'email', ${`poison-${seeded.handle}`},
                'account', NULL, 'owner_manual')
      `);

      await expect(
        handleSolicitationResendEvent(poisonedSql, 'email.bounced', 'msg_rollback_bounce', {
          bounce: { type: 'Permanent' },
        }),
      ).rejects.toThrow();

      const row = await readOutreach(seeded.outreachId);
      // An artifact claiming a hard bounce with no ledger row behind it would
      // let the next batch contact an address the provider already rejected.
      expect(row.bounced_at).toBeNull();
      expect(row.provider_error).toBeNull();
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    // ── ingress-level behaviour ───────────────────────────────────────────

    it('a failed solicitation event returns 503 so Resend retries', async () => {
      const svixId = `msg_503_${randomUUID()}`;
      // A complaint whose provider id matches nothing is suppression-bearing, so
      // the lane throws rather than acking — the #630 commit window.
      const body = {
        type: 'email.complained',
        data: {
          email_id: `provider_${randomUUID()}`,
          tags: [{ name: 'lane', value: 'solicitation' }],
        },
      };
      const { reply, captured } = makeReply();

      await handleResendWebhook(signedRequest(body, svixId), reply);

      expect(captured.status).toBe(503);
      expect(captured.body).toMatchObject({ retry: true });
      // The claimed row is left reclaimable, so the retry actually reprocesses.
      const [event] = await sql()<{ status: string }[]>`
        SELECT status FROM inbound_events WHERE external_event_key = ${svixId}
      `;
      expect(event?.status).toBe('failed');
    });

    it('a duplicate solicitation webhook writes no second suppression row', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_duplicate_ledger' });

      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_duplicate_ledger', {});
      const first = await readOutreach(seeded.outreachId);
      await handleSolicitationResendEvent(sql(), 'email.complained', 'msg_duplicate_ledger', {});

      // First-write-wins (§2.1) through recordSuppression's ON CONFLICT, and
      // COALESCE on the artifact side. A second row would break the uniqueness
      // that makes the §1.2 lookup a plain equality.
      expect(await readLedger(seeded.handle)).toHaveLength(1);
      expect((await readOutreach(seeded.outreachId)).complained_at).toBe(first.complained_at);
    });

    it('a duplicate svix id acks without reprocessing the solicitation lane', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_svix_dedup' });
      const svixId = `msg_dedup_${randomUUID()}`;
      const body = {
        type: 'email.complained',
        data: {
          email_id: 'msg_svix_dedup',
          tags: [{ name: 'lane', value: 'solicitation' }],
        },
      };

      const first = makeReply();
      await handleResendWebhook(signedRequest(body, svixId), first.reply);
      expect(first.captured.status).toBe(200);
      expect((await readOutreach(seeded.outreachId)).complained_at).not.toBeNull();

      // Erase the signal, then replay the SAME svix id. If the lane ran again it
      // would rewrite complained_at; the dedup claim is what stops it.
      await sql()`
        UPDATE solicitation_outreach SET complained_at = NULL WHERE id = ${seeded.outreachId}::uuid
      `;

      const second = makeReply();
      await handleResendWebhook(signedRequest(body, svixId), second.reply);

      expect(second.captured.status).toBe(200);
      expect(second.captured.body).toMatchObject({ received: true });
      expect((await readOutreach(seeded.outreachId)).complained_at).toBeNull();
    });

    // ── §9.2 logging ──────────────────────────────────────────────────────

    it('the solicitation lane logs no recipient address or message body', async () => {
      const subject = 'Bright Smile Dental would love your feedback';
      const bodyText = 'Would you mind leaving a review for your visit last Tuesday?';
      const seeded = await seedOutreach({
        providerMessageId: 'msg_no_pii_logs',
        renderedSubject: subject,
        renderedBody: bodyText,
      });

      const captured = captureConsole();
      try {
        await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_no_pii_logs', {
          bounce: { type: 'Permanent' },
        });
        await handleSolicitationResendEvent(sql(), 'email.suppressed', 'msg_no_pii_logs', {});
        await handleSolicitationResendEvent(sql(), 'email.failed', 'msg_no_pii_logs', {
          failed: { reason: 'nope' },
        });
      } finally {
        captured.restore();
      }

      const joined = captured.lines.join('\n');
      expect(joined).not.toContain(seeded.handle);
      expect(joined).not.toContain(subject);
      expect(joined).not.toContain(bodyText);
      // The ids that make an incident investigable ARE logged — this is a
      // redaction rule, not a silence rule.
      expect(joined).toContain(seeded.outreachId);
      expect(joined).toContain(accountId());
    });

    // ── plan review round 1: F1, F2, F3, F8 ───────────────────────────────

    it('the solicitation lane retries rather than acknowledging an unmatched suppression-bearing event', async () => {
      // No outreach row carries this provider id yet — the #630 commit window,
      // where provider_message_id is persisted only after Resend responds.
      await expect(
        handleSolicitationResendEvent(sql(), 'email.complained', 'msg_never_committed', {}),
      ).rejects.toThrow(/unmatched/i);

      // A soft bounce in the same state is ack-able, not retryable: nothing
      // compliance-relevant is lost by dropping it.
      await expect(
        handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_never_committed', {
          bounce: { type: 'Temporary' },
        }),
      ).resolves.toBeUndefined();

      // The retry is bounded for free by the existing 300s stale-svix-timestamp
      // window, so a genuinely-unknown id is 401'd rather than retrying forever.
      expect(await readLedger()).toHaveLength(0);
    });

    it('the solicitation lane writes nothing when its attributed outreach row is removed mid-transaction', async () => {
      // MUTATION-SENSITIVITY IS THE POINT. Asserting write atomicity would pass
      // against the BUGGY version too — its UPDATE and ledger insert were always
      // in one transaction. The actual bug was that the ATTRIBUTION READ sat
      // outside the transaction and took no lock.
      //
      // So test the lock, by holding the row from a second connection and
      // observing WHICH statement parks: the correct lane blocks inside its
      // `SELECT … FOR UPDATE OF o`, while a version that read attribution
      // outside the transaction would sail past and park on the later UPDATE.
      const seeded = await seedOutreach({ providerMessageId: 'msg_race' });

      let releaseHolder!: () => void;
      const holderMayFinish = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });

      // Second connection: take the row lock, then DELETE and commit only after
      // the handler is provably parked behind it.
      const holder = other().begin(async (tx) => {
        await tx`SELECT id FROM solicitation_outreach WHERE id = ${seeded.outreachId}::uuid FOR UPDATE`;
        await holderMayFinish;
        await tx`DELETE FROM solicitation_outreach WHERE id = ${seeded.outreachId}::uuid`;
      });

      // Give the holder its lock before the handler starts.
      await waitForHolderLock();

      const handler = handleSolicitationResendEvent(sql(), 'email.complained', 'msg_race', {});
      const parked = await waitForLockedQuery('FOR UPDATE');
      // The blocked statement is the locking attribution READ, not the later
      // UPDATE — which is precisely what the buggy version would have parked on.
      expect(parked).toContain('solicitation_outreach');
      expect(parked).toMatch(/SELECT[\s\S]*FOR UPDATE/i);

      releaseHolder();
      await holder;

      // The row the lane was attributing to is gone by the time its lock is
      // granted, and a complaint is suppression-bearing — so it retries rather
      // than writing a ledger row with no artifact behind it.
      await expect(handler).rejects.toThrow();
      expect(await readLedger()).toHaveLength(0);
      const [remaining] = await sql()<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM solicitation_outreach
         WHERE id = ${seeded.outreachId}::uuid
      `;
      expect(remaining?.count).toBe(0);
    });

    it('the solicitation lane rolls back its outreach signal when the ledger write fails', async () => {
      // Separate property from the race above: artifact and ledger commit
      // together or not at all. Forced through helpers/abort-injection.ts, whose
      // export is `abortingExecutor(base, poison)` — never a temporary
      // constraint (house rule).
      const seeded = await seedOutreach({ providerMessageId: 'msg_atomic' });

      const poisonedSql = abortingExecutor(sql(), (tx) => tx`
        INSERT INTO solicitation_suppressions
          (id, channel, normalized_handle, scope, account_id, source)
        VALUES (${randomUUID()}::uuid, 'email', ${`poison-${seeded.handle}`},
                'account', NULL, 'owner_manual')
      `);

      await expect(
        handleSolicitationResendEvent(poisonedSql, 'email.complained', 'msg_atomic', {}),
      ).rejects.toThrow();

      const row = await readOutreach(seeded.outreachId);
      expect(row.complained_at).toBeNull();
      expect(await readLedger(seeded.handle)).toHaveLength(0);
    });

    it('the solicitation lane refuses an ambiguous provider message id without mutating an arbitrary outreach row', async () => {
      // No unique index on provider_message_id stops two rows from sharing one.
      const a = await seedOutreach({ providerMessageId: 'msg_dup' });
      const b = await seedOutreach({ providerMessageId: 'msg_dup' });

      await expect(
        handleSolicitationResendEvent(sql(), 'email.complained', 'msg_dup', {}),
      ).rejects.toThrow(/ambiguous/i);

      // Two rows is an impossible state — refuse, rather than mutate whichever
      // row the planner happened to return first.
      const rows = await sql()<{ complained_at: string | null }[]>`
        SELECT complained_at::text AS complained_at FROM solicitation_outreach
         WHERE id IN (${a.outreachId}::uuid, ${b.outreachId}::uuid)
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.complained_at === null)).toBe(true);
      expect(await readLedger()).toHaveLength(0);
    });

    it('the solicitation lane never logs a raw provider bounce or failure reason', async () => {
      const seeded = await seedOutreach({ providerMessageId: 'msg_leak' });
      const captured = captureConsole();
      try {
        await handleSolicitationResendEvent(sql(), 'email.bounced', 'msg_leak', {
          bounce: { type: 'Permanent: victim@example.test mailbox unavailable' },
        });
      } finally {
        captured.restore();
      }

      const all = captured.lines.join('\n');
      expect(all).not.toContain('victim@example.test');
      expect(all).not.toContain('mailbox unavailable');
      expect(all).toContain('"bounce_kind":"hard"');

      // The full classified value is still STORED — a column is not a log.
      const row = await readOutreach(seeded.outreachId);
      expect(row.provider_error).toContain('victim@example.test');
    });

    it('the solicitation lane never logs a raw provider failure reason', async () => {
      // The title above says "bounce or failure". email.failed is a SEPARATE
      // code path reading failed.reason, so a regression that logs it verbatim
      // would survive the bounce-only case. Cover it explicitly.
      const seeded = await seedOutreach({ providerMessageId: 'msg_fail_leak' });
      const captured = captureConsole();
      try {
        await handleSolicitationResendEvent(sql(), 'email.failed', 'msg_fail_leak', {
          failed: { reason: 'rejected recipient victim@example.test reached_daily_quota' },
        });
      } finally {
        captured.restore();
      }

      const all = captured.lines.join('\n');
      expect(all).not.toContain('victim@example.test');
      expect(all).not.toContain('reached_daily_quota');
      expect(all).toContain('"has_reason":true');

      const row = await readOutreach(seeded.outreachId);
      expect(row.provider_error).toContain('victim@example.test');
    });
  },
);

/**
 * Waits until the second connection's transaction actually holds the row lock,
 * so the handler that starts next is guaranteed to queue behind it rather than
 * winning the race and making the interleaving vacuous.
 */
async function waitForHolderLock(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `idle in transaction` with a locking SELECT as the last statement is
    // exactly the holder's state: the lock is granted and it is parked on the
    // barrier, not still executing.
    const [held] = await sql()<{ holders: number }[]>`
      SELECT COUNT(*)::int AS holders
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND state = 'idle in transaction'
         AND query ILIKE '%FOR UPDATE%'
    `;
    if ((held?.holders ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('the second connection never took the outreach row lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
