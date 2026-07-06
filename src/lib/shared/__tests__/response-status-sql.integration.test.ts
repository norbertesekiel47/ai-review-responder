// src/lib/shared/__tests__/response-status-sql.integration.test.ts
//
// DB-gated integration test for statusArraySql. Skips without
// TEST_DATABASE_POOL_URL (mirrors archive-location-tx.integration.test.ts).
//
// Invariant under test: statusArraySql binds a response-status group as a
// Postgres `text[]` array so `status = ANY(${statusArraySql(GROUP)})` matches
// in-group values and rejects out-of-group ones against the real
// `responses.status` (text) column domain — proving the migrated READ
// predicates generate behavior-identical SQL.

import { afterAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

describeWithDb('statusArraySql (integration, real Postgres text[] binding)', () => {
  it('ANY(statusArraySql(HANDLED_STATUSES)) matches in-group and rejects out-of-group', async () => {
    // statusArraySql now takes its client explicitly (injection convention).
    // Import lazily so the local skip path never constructs a DB client.
    const { statusArraySql } = await import('../response-status-sql');
    const { HANDLED_STATUSES } = await import('../response-status');

    db = postgres(testDatabaseUrl!, { prepare: false });

    // Pass the SAME client that executes the query so the fragment composes
    // against the live Postgres service (DATABASE_POOL_URL, which CI points at
    // the Postgres service).
    const { sql } = await import('@/lib/db/server');
    const [row] = await sql<{ hit: boolean; miss: boolean; allposted: boolean }[]>`
      SELECT
        'approved'::text = ANY(${statusArraySql(sql, HANDLED_STATUSES)}) AS hit,
        'pending_approval'::text = ANY(${statusArraySql(sql, HANDLED_STATUSES)}) AS miss,
        'posted'::text = ANY(${statusArraySql(sql, HANDLED_STATUSES)}) AS allposted
    `;

    expect(row?.hit).toBe(true);
    expect(row?.miss).toBe(false);
    expect(row?.allposted).toBe(true);
  });
});
