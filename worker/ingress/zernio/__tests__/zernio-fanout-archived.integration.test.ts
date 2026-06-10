// worker/ingress/zernio/__tests__/zernio-fanout-archived.integration.test.ts
//
// True SQL-level companion to the mock-seam pins in zernio-webhook.test.ts.
// The unit tests pin the fan-out query TEXT (inner businesses join +
// archived_at IS NULL + conditional location fragment); this test proves the
// query BEHAVES against real Postgres: an archived location with a
// status='active' Zernio connection (kept by design for reactivation
// backfill) must NOT receive an ingest_zernio_review outbox row, while its
// active sibling at the same Zernio account must.
//
// Exercises the REAL handleZernioWebhook (HMAC signature, inbound_events
// dedup, fan-out INSERT…SELECT, archived-vs-unconnected EXISTS probe) by
// pointing the shared src/lib/db/server client at the test database before
// the handler module loads.
//
// Gated on a real test database (TEST_DATABASE_POOL_URL), like the repo's
// other live-DB integration tests (see
// src/lib/shared/__tests__/migration-056-account-offboarding.integration.test.ts);
// skips cleanly without one (e.g. in the no-DB CI test job). The database is
// expected to already have all migrations applied.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { createHmac, randomUUID } from 'node:crypto';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../../src/lib/shared/worker-types';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '../../../../src/lib/shared/__tests__/live-db-tenant';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

const WEBHOOK_SECRET = 'zernio-fanout-archived-integration-secret';

let db: postgresType.Sql | undefined;
let handleZernioWebhook: typeof import('../zernio').handleZernioWebhook;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
  activeBusinessId: randomUUID(),
  archivedBusinessId: randomUUID(),
  zernioAccountId: `zernio-acct-${randomUUID()}`,
  activeLocationId: `loc-active-${randomUUID()}`,
  archivedLocationId: `loc-archived-${randomUUID()}`,
};
const ownerEmail = `zernio-fanout-archived-${tenant.accountId}@test.local`;
const usedEventIds: string[] = [];

function sql(): postgresType.Sql {
  if (!db) throw new Error('zernio fan-out integration database was not initialized');
  return db;
}

function signedRequest(body: Record<string, unknown>, eventId: string): unknown {
  usedEventIds.push(eventId);
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: {
      'x-zernio-signature': createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'),
      'x-zernio-event-id': eventId,
    },
  };
}

function mkReply() {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  return { status, send };
}

async function postReviewWebhook(reviewId: string, locationId?: string): Promise<ReturnType<typeof mkReply>> {
  const eventId = `evt_zernio_fanout_int_${randomUUID()}`;
  const reply = mkReply();
  await handleZernioWebhook(
    signedRequest(
      {
        event: 'review.new',
        id: eventId,
        account: { id: tenant.zernioAccountId },
        review: {
          id: locationId
            ? `accounts/g-acc/locations/${locationId}/reviews/${reviewId}`
            : reviewId,
        },
      },
      eventId,
    ) as never,
    reply as never,
  );
  expect(reply.status).toHaveBeenCalledWith(200);
  return reply;
}

async function fanoutRowsByBusiness(): Promise<Map<string, number>> {
  const rows = await sql()<{ aggregate_id: string; count: string }[]>`
    SELECT aggregate_id, COUNT(*)::text AS count
    FROM job_outbox
    WHERE topic = 'ingest_zernio_review'
      AND aggregate_id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
    GROUP BY aggregate_id
  `;
  return new Map(rows.map((row) => [row.aggregate_id, Number(row.count)]));
}

d('Zernio webhook fan-out vs archived locations (live DB)', () => {
  beforeAll(async () => {
    // Point the shared db/server client at the test database BEFORE the
    // handler module (and its transitive db/server import) is first loaded —
    // db/server reads DATABASE_POOL_URL at module-evaluation time.
    process.env.DATABASE_POOL_URL = testDatabaseUrl!;
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    process.env.ZERNIO_WEBHOOK_SECRET = WEBHOOK_SECRET;
    ({ handleZernioWebhook } = await import('../zernio'));

    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await seedTenantAccount(sql(), {
      userId: tenant.userId,
      accountId: tenant.accountId,
      ownerEmail,
      userName: 'Zernio Fanout Owner',
      accountDisplayName: 'Zernio Fanout Account',
    });
    // Domain rows reference the committed user/account pair — no deferral needed.
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, is_primary, display_label, subscription_status, archived_at)
      VALUES
        (${tenant.activeBusinessId}::uuid, 'Fanout Active Location', 'Zernio Fanout Owner', ${ownerEmail}, ${tenant.accountId}::uuid, TRUE, 'Fanout Active Location', 'active', NULL),
        (${tenant.archivedBusinessId}::uuid, 'Fanout Archived Location', 'Zernio Fanout Owner', ${ownerEmail}, ${tenant.accountId}::uuid, FALSE, 'Fanout Archived Location', 'active', NOW())
    `;
    // Archived locations keep status='active' connections BY DESIGN
    // (reactivation backfill) — this is exactly the trap the fan-out's
    // businesses join must defuse.
    await sql()`
      INSERT INTO zernio_connections (business_id, zernio_profile_id, zernio_account_id, zernio_location_id, status, connected_at)
      VALUES
        (${tenant.activeBusinessId}::uuid, ${`profile-${tenant.activeBusinessId}`}, ${tenant.zernioAccountId}, ${tenant.activeLocationId}, 'active', NOW()),
        (${tenant.archivedBusinessId}::uuid, ${`profile-${tenant.archivedBusinessId}`}, ${tenant.zernioAccountId}, ${tenant.archivedLocationId}, 'active', NOW())
    `;
  });

  afterAll(async () => {
    if (db) {
      await sql()`
        DELETE FROM job_outbox
        WHERE topic = 'ingest_zernio_review'
          AND aggregate_id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
      `;
      if (usedEventIds.length > 0) {
        await sql()`DELETE FROM inbound_events WHERE external_event_key = ANY(${usedEventIds})`;
      }
      await sql()`
        DELETE FROM zernio_connections
        WHERE business_id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
      `;
      await sql()`
        DELETE FROM businesses
        WHERE id IN (${tenant.activeBusinessId}::uuid, ${tenant.archivedBusinessId}::uuid)
      `;
      await cleanupTenantAccount(sql(), tenant);
      await db.end({ timeout: 5 });
    }
    // Close the handler's shared db/server client too, or the vitest fork
    // can hang on its open sockets.
    if (RUN) {
      const { sql: serverSql } = await import('../../../../src/lib/db/server');
      await serverSql.end({ timeout: 5 });
    }
  });

  it('account-wide fan-out enqueues only the active business, never the archived sibling', async () => {
    const reviewId = `rev-accountwide-${randomUUID()}`;
    await postReviewWebhook(reviewId); // bare review id → account-wide lane

    const rows = await fanoutRowsByBusiness();
    expect(rows.get(tenant.activeBusinessId)).toBe(1);
    expect(rows.has(tenant.archivedBusinessId)).toBe(false);
  });

  it('location-scoped fan-out at the active location enqueues exactly that business', async () => {
    const reviewId = `rev-located-${randomUUID()}`;
    await postReviewWebhook(reviewId, tenant.activeLocationId);

    const [row] = await sql()<{ aggregate_id: string; payload_location: string }[]>`
      SELECT aggregate_id, payload->>'zernio_location_id' AS payload_location
      FROM job_outbox
      WHERE topic = 'ingest_zernio_review'
        AND payload->>'zernio_review_id' = ${reviewId}
    `;
    expect(row?.aggregate_id).toBe(tenant.activeBusinessId);
    expect(row?.payload_location).toBe(tenant.activeLocationId);
  });

  it('location-scoped fan-out at the archived location inserts nothing and logs the archived skip', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log');
    try {
      const reviewId = `rev-archived-${randomUUID()}`;
      await postReviewWebhook(reviewId, tenant.archivedLocationId);

      const inserted = await sql()<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE topic = 'ingest_zernio_review'
          AND payload->>'zernio_review_id' = ${reviewId}
      `;
      expect(inserted).toHaveLength(0);

      // The dual-EXISTS probe must classify this 0-row fan-out as an expected
      // archived skip. The line emits via createWorkerLogger (one JSON object
      // per console.log call, object args under `data`) so the reason is a
      // structured queryable field — assert on the parsed record.
      const archivedRecords = (consoleLogSpy.mock.calls as unknown[][])
        .map((call: unknown[]) => call[0])
        .filter((arg: unknown): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .flatMap((line: string) => {
          try {
            return [JSON.parse(line) as { message?: string; data?: Record<string, unknown> }];
          } catch {
            return [];
          }
        })
        .filter((rec) => rec.data?.reason === SKIP_REASON_ARCHIVED_LOCATION);
      expect(archivedRecords).toHaveLength(1);
      expect(archivedRecords[0]!.message).toContain('all matching connection(s) archived');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
