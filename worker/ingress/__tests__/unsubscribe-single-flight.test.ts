import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The single-flight seam is what keeps one genuinely-delivered token from
// occupying the SHARED write pool with unbounded concurrent replays on a route
// §9.2 forbids rate-limiting. These tests drive the injectable factory with a
// controllable promise — no timers, no HTTP, no ordering luck — exactly the shape
// unknown-token-window.test.ts established for the other bounded seam in this file.
//
// `sql` is imported for side effect by the module under test; stub it so no
// Postgres client is constructed for a suite that never touches one.
vi.mock('../../../src/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: (value: unknown) => value,
}));

import {
  createRedemptionSingleFlight,
  type RedemptionSingleFlight,
} from '../unsubscribe';
import type { UnsubscribeRedemption } from '../../../src/lib/solicitation/unsubscribe';

interface Deferred {
  promise: Promise<UnsubscribeRedemption>;
  resolve: (outcome: UnsubscribeRedemption) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (outcome: UnsubscribeRedemption) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UnsubscribeRedemption>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REDEEMED: UnsubscribeRedemption = { status: 'redeemed', tokenHashPrefix: 'a1b2c3d4e5f6' };
const ALREADY: UnsubscribeRedemption = {
  status: 'already_suppressed',
  tokenHashPrefix: 'a1b2c3d4e5f6',
};

/** Drains every pending microtask — the deterministic alternative to a sleep. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let unhandled: unknown[];
let onUnhandled: (reason: unknown) => void;

beforeEach(() => {
  unhandled = [];
  onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await drainMicrotasks();
  process.off('unhandledRejection', onUnhandled);
  // The map's cleanup hook must never leak a rejection: worker/index.ts treats an
  // unhandledRejection outside its narrow transient-DB allowlist as fatal, so a
  // `.finally()` chain here would turn one failed redemption into a dead worker.
  expect(unhandled).toEqual([]);
});

function buildRig(maxEntries = 8) {
  // A LIST per token, not one gate: past the cap the seam bypasses, so the same
  // token can legitimately have several redemptions open at once — and a rig that
  // overwrote the earlier gate would hang instead of proving that.
  const gates = new Map<string, Deferred[]>();
  const redeem = vi.fn(async (rawToken: string) => {
    const gate = deferred();
    gates.set(rawToken, [...(gates.get(rawToken) ?? []), gate]);
    return gate.promise;
  });
  const singleFlight: RedemptionSingleFlight = createRedemptionSingleFlight({
    maxEntries,
    redeem,
  });
  const takeGates = (rawToken: string): Deferred[] => {
    const pending = gates.get(rawToken) ?? [];
    gates.delete(rawToken);
    return pending;
  };
  return {
    singleFlight,
    redeem,
    settle: (rawToken: string, outcome: UnsubscribeRedemption) =>
      takeGates(rawToken).forEach((gate) => gate.resolve(outcome)),
    fail: (rawToken: string, reason: unknown) =>
      takeGates(rawToken).forEach((gate) => gate.reject(reason)),
  };
}

describe('unsubscribe redemption single-flight', () => {
  it('collapses N concurrent replays of one token into exactly one redemption', async () => {
    const rig = buildRig();

    const waiters = Array.from({ length: 12 }, () => rig.singleFlight.run('delivered-token'));
    await drainMicrotasks();
    rig.settle('delivered-token', REDEEMED);

    // Sharing is only sound because all three non-unknown outcomes map to 200 in
    // handleUnsubscribePost — every waiter gets an answer the adapter would have
    // given it anyway. Nothing is shed: all twelve resolve.
    await expect(Promise.all(waiters)).resolves.toEqual(Array(12).fill(REDEEMED));
    expect(rig.redeem).toHaveBeenCalledTimes(1);
    expect(rig.redeem).toHaveBeenCalledWith('delivered-token');
  });

  it('propagates a rejected in-flight redemption to every waiter', async () => {
    const rig = buildRig();
    const boom = new Error('ledger write exploded');

    const waiters = Array.from({ length: 5 }, () => rig.singleFlight.run('delivered-token'));
    // Attach handlers before the rejection so no waiter is momentarily unhandled.
    const settled = waiters.map((waiter) => waiter.catch((err: unknown) => err));
    await drainMicrotasks();
    rig.fail('delivered-token', boom);

    // Each waiter must take the adapter's normal catch → sanitized Sentry → 503
    // path on its own; a swallowed rejection would 200 a redemption that failed.
    await expect(Promise.all(settled)).resolves.toEqual(Array(5).fill(boom));
    expect(rig.redeem).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a resolved', (rig: ReturnType<typeof buildRig>) => rig.settle('t', REDEEMED)],
    ['a rejected', (rig: ReturnType<typeof buildRig>) => rig.fail('t', new Error('boom'))],
  ])('releases the entry after %s redemption settles', async (_label, settleFirst) => {
    const rig = buildRig();

    const first = rig.singleFlight.run('t').catch(() => undefined);
    await drainMicrotasks();
    settleFirst(rig);
    await first;
    await drainMicrotasks();

    // A leaked entry would serve the FIRST outcome to every later replay forever —
    // including one legitimately re-delivered after an audited correction.
    const second = rig.singleFlight.run('t');
    await drainMicrotasks();
    rig.settle('t', ALREADY);

    await expect(second).resolves.toEqual(ALREADY);
    expect(rig.redeem).toHaveBeenCalledTimes(2);
  });

  it('does not share an entry between two different tokens', async () => {
    const rig = buildRig();

    const first = rig.singleFlight.run('token-one');
    const second = rig.singleFlight.run('token-two');
    await drainMicrotasks();
    rig.settle('token-one', REDEEMED);
    rig.settle('token-two', ALREADY);

    await expect(first).resolves.toEqual(REDEEMED);
    await expect(second).resolves.toEqual(ALREADY);
    expect(rig.redeem).toHaveBeenCalledTimes(2);
  });

  it('falls back to direct redemption past the cap rather than rejecting', async () => {
    const rig = buildRig(2);

    const held = [rig.singleFlight.run('token-one'), rig.singleFlight.run('token-two')];
    await drainMicrotasks();

    // Past the cap the seam BYPASSES. Shedding a well-formed request here would be
    // an intentional silent loss of a statutory opt-out — the exact failure owner
    // review deleted the earlier bulkhead for. Bypassing degrades to the behaviour
    // that shipped before this seam existed, which is always a correct answer.
    const overflow = rig.singleFlight.run('token-three');
    const overflowReplay = rig.singleFlight.run('token-three');
    await drainMicrotasks();
    rig.settle('token-three', REDEEMED);

    await expect(overflow).resolves.toEqual(REDEEMED);
    await expect(overflowReplay).resolves.toEqual(REDEEMED);
    // Both overflow calls redeemed directly — no entry, therefore no sharing.
    expect(rig.redeem).toHaveBeenCalledTimes(4);

    rig.settle('token-one', REDEEMED);
    rig.settle('token-two', REDEEMED);
    await Promise.all(held);
  });

  it('resumes collapsing once capped entries drain', async () => {
    const rig = buildRig(1);

    const first = rig.singleFlight.run('token-one');
    await drainMicrotasks();
    const bypassed = rig.singleFlight.run('token-two');
    await drainMicrotasks();
    rig.settle('token-one', REDEEMED);
    rig.settle('token-two', REDEEMED);
    await Promise.all([first, bypassed]);
    await drainMicrotasks();

    const rejoined = [rig.singleFlight.run('token-three'), rig.singleFlight.run('token-three')];
    await drainMicrotasks();
    rig.settle('token-three', ALREADY);

    await expect(Promise.all(rejoined)).resolves.toEqual([ALREADY, ALREADY]);
    // 1 held + 1 bypassed + 1 for the collapsed PAIR = 3, not 4: the cap is a
    // temporary state, not a latch that disables the seam for the process.
    expect(rig.redeem).toHaveBeenCalledTimes(3);
  });
});
