import { beforeEach, it, expect, vi } from 'vitest';

import { probePoolWait, __resetPoolWaitInflight } from '../pool-wait';

function fakeSql(reserveImpl: () => Promise<{ release: () => void }>) {
  return { reserve: reserveImpl } as unknown as import('postgres').Sql;
}
beforeEach(() => __resetPoolWaitInflight());

it('free pool → low waitMs, not timedOut, not saturating, releases once', async () => {
  const release = vi.fn();
  const r = await probePoolWait(fakeSql(async () => ({ release })), { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
  expect(r).toMatchObject({ timedOut: false, saturating: false, max: 20 });
  expect(r.waitMs).toBeLessThan(50);
  expect(release).toHaveBeenCalledTimes(1);
});

it('timeout → timedOut:true, saturating:true, waitMs=timeout, late connection still released (no leak)', async () => {
  const release = vi.fn();
  let resolveReserve!: (v: { release: () => void }) => void;
  const r = await probePoolWait(fakeSql(() => new Promise((res) => { resolveReserve = res; })), { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(r).toMatchObject({ waitMs: 20, timedOut: true, saturating: true });
  resolveReserve({ release }); await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
});

it('single-flight: concurrent probes over a PENDING reservation share ONE reserve()', async () => {
  const reserve = vi.fn(() => new Promise<{ release: () => void }>(() => { /* never resolves */ }));
  const s = fakeSql(reserve);
  await Promise.all([
    probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 }),
    probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 }),
  ]);
  expect(reserve).toHaveBeenCalledTimes(1); // both timed out; one reservation total
});

it('REGRESSION (#10): a timed-out call does NOT release the latch — the second call reuses the still-pending reserve(), released once on settlement', async () => {
  const release = vi.fn();
  let resolveReserve!: (v: { release: () => void }) => void;
  const reserve = vi.fn(() => new Promise<{ release: () => void }>((res) => { resolveReserve = res; }));
  const s = fakeSql(reserve);
  const first = await probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(first.timedOut).toBe(true);                 // call 1 times out; reservation still pending
  const secondP = probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(reserve).toHaveBeenCalledTimes(1);          // call 2 REUSES it — NO new reserve() (no accumulation)
  expect((await secondP).timedOut).toBe(true);
  resolveReserve({ release });                        // reservation finally settles
  await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);           // released exactly once
});

it('genuine reserve() rejection is re-thrown (handler maps to pool:null)', async () => {
  await expect(probePoolWait(fakeSql(async () => { throw new Error('refused'); }), { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 })).rejects.toThrow('refused');
});

it('REGRESSION (blocker): a rejecting reserve() with TWO concurrent awaiters emits NO unhandledRejection (the latch cleanup must not leave a derived rejected promise)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectReserve!: (e: Error) => void;
    const s = fakeSql(() => new Promise<{ release: () => void }>((_, rej) => { rejectReserve = rej; }));
    const p1 = probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
    const p2 = probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
    rejectReserve(new Error('reserve-refused'));
    await expect(p1).rejects.toThrow('reserve-refused'); // both awaiters see it
    await expect(p2).rejects.toThrow('reserve-refused');
    await new Promise((r) => setTimeout(r, 0));           // let any stray rejection surface a tick
    expect(unhandled).toHaveLength(0);                    // the r.finally() shape would fail HERE
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
