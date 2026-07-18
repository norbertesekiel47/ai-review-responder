import { describe, expect, it } from 'vitest';
import { createDedicatedPostgresClient, sql } from '../server';

// Constructing a postgres.js client does NOT open a connection (it connects
// lazily on the first query), so these assertions are offline and side-effect
// free — no real DB is touched. We assert against the client's parsed `.options`,
// which postgres.js exposes.
describe('createDedicatedPostgresClient', () => {
  it('returns a NEW client distinct from the shared sql singleton', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client).not.toBe(sql);
    // A postgres.js client is a callable tagged-template function.
    expect(typeof client).toBe('function');
    void client.end({ timeout: 0 });
  });

  it('honors the requested max (pool size) override', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client.options.max).toBe(2);
    void client.end({ timeout: 0 });
  });

  it('defaults max to 2 when no override is given (dedicated clients are small)', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db');
    expect(client.options.max).toBe(2);
    void client.end({ timeout: 0 });
  });

  it('inherits the pinned base config (prepare:false + 30s statement_timeout default)', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client.options.prepare).toBe(false);
    expect(client.options.connection.statement_timeout).toBe(30_000);
    void client.end({ timeout: 0 });
  });

  it('lets a caller override statement_timeout and application_name via connection', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', {
      max: 2,
      connection: { statement_timeout: 5_000, application_name: 'rw-wedge-reaper' },
    });
    expect(client.options.connection.statement_timeout).toBe(5_000);
    expect(client.options.connection.application_name).toBe('rw-wedge-reaper');
    void client.end({ timeout: 0 });
  });
});
