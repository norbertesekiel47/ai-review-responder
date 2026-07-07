import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { statusArraySql } from '../response-status-sql';
import { HANDLED_STATUSES } from '../response-status';

// statusArraySql now takes its `sql`/`tx` client explicitly (injection
// convention). Postgres.js is lazy — constructing a client opens no socket, and
// statusArraySql only BUILDS a fragment (never awaits it), so this stays a pure
// unit test with no DB. A real client (not a stub) keeps the assertions below
// meaningful: the return value is a genuine Postgres.js fragment object.
const db = postgres('postgres://user:pass@localhost:5432/response_status_test', {
  prepare: false,
});

afterAll(async () => {
  await db.end({ timeout: 0 });
});

describe('statusArraySql (pure shape)', () => {
  it('returns a Postgres.js fragment object, not a raw string', () => {
    const fragment = statusArraySql(db, HANDLED_STATUSES);
    expect(typeof fragment).not.toBe('string');
    expect(fragment).toBeTypeOf('object');
    expect(fragment).not.toBeNull();
  });

  it('does not throw and accepts any readonly status group', () => {
    expect(() => statusArraySql(db, HANDLED_STATUSES)).not.toThrow();
    expect(() => statusArraySql(db, ['approved', 'edited'])).not.toThrow();
  });
});
