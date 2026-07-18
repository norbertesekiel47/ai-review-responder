// Tests for the durable poller cursor store (T1): the write-sequence CAS that
// makes cursor persistence provably ordered under withTimeout's non-cancelling
// contract (ADR 0006). Property test (fast-check) for CAS monotonicity + the
// DECISIVE regression: a detached timed-out save landing after a higher-seq save
// is rejected at the DB.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadCursor, saveCursor } from '../billing-reconciliation/cursor-store';
import { POLLER_NAME } from '../billing-reconciliation/constants';
import { withTimeout } from '../../../../src/lib/shared/with-timeout';

type PersistedRow = { cursor: string | null; write_seq: number };

/**
 * An in-memory `sql` fake honoring poller_cursors' write-sequence CAS: an INSERT
 * applies only when its write_seq strictly exceeds the persisted one (or no row
 * exists). Reads return the persisted row. Optional per-INSERT gating lets a
 * save's underlying promise settle LATE (to model withTimeout non-cancellation).
 */
function makeCasStore(options: { gate?: (writeSeq: number) => Promise<void> | undefined } = {}) {
  let persisted: PersistedRow | null = null;

  const applyInsert = (cursor: string | null, writeSeq: number): void => {
    if (persisted === null || writeSeq > persisted.write_seq) {
      persisted = { cursor, write_seq: writeSeq };
    }
  };

  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const template = strings.join('?');
    if (template.includes('SELECT cursor, write_seq')) {
      return Promise.resolve(persisted === null ? [] : [{ ...persisted }]);
    }
    if (template.includes('INSERT INTO poller_cursors')) {
      const cursor = values[1] as string | null;
      const writeSeq = values[2] as number;
      const gate = options.gate?.(writeSeq);
      if (gate) {
        return gate.then(() => {
          applyInsert(cursor, writeSeq);
          return [] as unknown[];
        });
      }
      applyInsert(cursor, writeSeq);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };

  return { sql, read: (): PersistedRow | null => persisted };
}

describe('saveCursor — write-sequence CAS monotonicity', () => {
  it('over any interleaving of saves, the persisted value equals the highest-seq write', async () => {
    await fc.assert(
      fc.asyncProperty(
        // distinct seqs paired with cursor values, applied in the generated order
        fc
          .uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 30 })
          .chain((seqs) =>
            fc.tuple(
              fc.constant(seqs),
              fc.array(fc.option(fc.string({ minLength: 1 }), { nil: null }), {
                minLength: seqs.length,
                maxLength: seqs.length,
              }),
            ),
          ),
        async ([seqs, cursors]) => {
          const { sql, read } = makeCasStore();
          for (let i = 0; i < seqs.length; i++) {
            await saveCursor(sql, POLLER_NAME, cursors[i] ?? null, seqs[i]!);
          }
          const maxSeq = Math.max(...seqs);
          const winner = cursors[seqs.indexOf(maxSeq)] ?? null;
          expect(read()).toEqual({ cursor: winner, write_seq: maxSeq });
        },
      ),
    );
  });

  it('a lower-seq write arriving later is a no-op (replay after a higher seq)', async () => {
    const { sql, read } = makeCasStore();
    await saveCursor(sql, POLLER_NAME, 'acct-hi', 10);
    await saveCursor(sql, POLLER_NAME, 'acct-lo', 9); // stale replay
    expect(read()).toEqual({ cursor: 'acct-hi', write_seq: 10 });
  });
});

describe('saveCursor — the decisive detached-save race (ADR 0006)', () => {
  it('a timed-out save A that lands after a higher-seq save B is rejected by the CAS', async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    // Save A (seq 5) is gated so its underlying write settles LATE; all others apply now.
    const { sql, read } = makeCasStore({
      gate: (writeSeq) => (writeSeq === 5 ? aGate : undefined),
    });

    // A: wrapped in a tiny withTimeout → the wrapper REJECTS while A's underlying
    // promise is still pending (withTimeout races, it does not cancel).
    const aOutcome = await withTimeout(
      saveCursor(sql, POLLER_NAME, 'acct-A', 5),
      5,
      'save A',
    ).catch(() => 'timed-out');
    expect(aOutcome).toBe('timed-out');

    // B (higher seq) completes and lands.
    await saveCursor(sql, POLLER_NAME, 'acct-B', 6);
    expect(read()).toEqual({ cursor: 'acct-B', write_seq: 6 });

    // A's underlying write resolves LATE → CAS 5 > 6 is false → no-op.
    releaseA();
    await aGate;
    await new Promise((resolve) => setImmediate(resolve)); // flush A's chained apply
    expect(read()).toEqual({ cursor: 'acct-B', write_seq: 6 });
  });

  it('rotation/NULL boundary variant: a late seq-5 save cannot regress a NULL rotation-end save', async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const { sql, read } = makeCasStore({
      gate: (writeSeq) => (writeSeq === 5 ? aGate : undefined),
    });

    const aOutcome = await withTimeout(
      saveCursor(sql, POLLER_NAME, 'acct-A', 5),
      5,
      'save A',
    ).catch(() => 'timed-out');
    expect(aOutcome).toBe('timed-out');

    // B stamps a rotation boundary (cursor = null) at a higher seq.
    await saveCursor(sql, POLLER_NAME, null, 6);
    expect(read()).toEqual({ cursor: null, write_seq: 6 });

    releaseA();
    await aGate;
    await new Promise((resolve) => setImmediate(resolve));
    // The detached A must NOT resurrect 'acct-A' over the NULL rotation end.
    expect(read()).toEqual({ cursor: null, write_seq: 6 });
  });
});

describe('loadCursor', () => {
  it('returns the rotation-start default when no row exists', async () => {
    const { sql } = makeCasStore();
    expect(await loadCursor(sql, POLLER_NAME)).toEqual({ cursor: null, writeSeq: 0 });
  });

  it('round-trips a persisted cursor + seq', async () => {
    const { sql } = makeCasStore();
    await saveCursor(sql, POLLER_NAME, 'acct-42', 7);
    expect(await loadCursor(sql, POLLER_NAME)).toEqual({ cursor: 'acct-42', writeSeq: 7 });
  });

  it('coerces a bigint write_seq returned as a string (Postgres.js bigint shape)', async () => {
    const sql: any = () => Promise.resolve([{ cursor: 'acct-x', write_seq: '900719925474' }]);
    const loaded = await loadCursor(sql, POLLER_NAME);
    expect(loaded.writeSeq).toBe(900719925474);
    expect(typeof loaded.writeSeq).toBe('number');
  });
});
