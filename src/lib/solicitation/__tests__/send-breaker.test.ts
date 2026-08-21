import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { readSendBreaker } from '../send-breaker';

describe('readSendBreaker', () => {
  it('readSendBreaker propagates a database failure so the caller halts rather than sends', async () => {
    // THE fail-closed invariant (#622 §3.2B): a DB failure inside the breaker's
    // own read degrades to HALT, never to "unmeasured therefore send". The
    // interface carries this fact — readSendBreaker returns state or THROWS, and
    // the throw IS the halt signal. It must never resolve to a "clear" verdict.
    const boom = new Error('connection terminated unexpectedly');
    const failing = (() => {
      throw boom;
    }) as unknown as Sql;

    await expect(readSendBreaker(failing)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});
