import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { terminateWedges } from '../reaper-query';

/** A minimal tagged-template stand-in for postgres.Sql that resolves to `rows`. */
function fakeSql(rows: unknown[]): { sql: postgres.Sql; calls: number } {
  const state = { calls: 0 };
  const fn = (..._args: unknown[]) => {
    state.calls += 1;
    return Promise.resolve(rows);
  };
  return { sql: fn as unknown as postgres.Sql, get calls() { return state.calls; } };
}

describe('terminateWedges', () => {
  const targets = [
    { pid: 101, backendStart: '2026-07-18 00:00:00.111+00' },
    { pid: 202, backendStart: '2026-07-18 00:00:01.222+00' },
  ];

  it('tolerates an already-gone tuple: an empty result set does not throw', async () => {
    const { sql } = fakeSql([]); // both backends vanished between SELECT and terminate
    await expect(terminateWedges(sql, targets, 300)).resolves.toEqual([]);
  });

  it('tolerates terminated=false rows (the backend was already gone)', async () => {
    const { sql } = fakeSql([{ pid: 101, terminated: false }]);
    const outcomes = await terminateWedges(sql, targets, 300);
    expect(outcomes).toEqual([{ pid: 101, terminated: false }]);
  });

  it('maps surviving matched backends to their termination outcome', async () => {
    const { sql } = fakeSql([
      { pid: 101, terminated: true },
      { pid: 202, terminated: false },
    ]);
    const outcomes = await terminateWedges(sql, targets, 300);
    expect(outcomes).toEqual([
      { pid: 101, terminated: true },
      { pid: 202, terminated: false },
    ]);
  });

  it('short-circuits with no query when there are no targets', async () => {
    const query = vi.fn();
    await expect(terminateWedges(query as unknown as postgres.Sql, [], 300)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
