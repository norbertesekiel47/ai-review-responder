import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_PER_TICK_BUDGET } from '../release';

// ─────────────────────────────────────────────────────────────────────────────
// The §7.1 pin (#923, ADR 0022).
//
// The deliverability spec asks dispatch to YIELD to transactional mail on
// Resend's shared 10 req/s TEAM limit. ADR 0022 refuses to build that yield and
// accepts the rate cap instead — a per-tick release budget plus single
// concurrency on the send worker. That refusal is only honest if raising either
// dial fails LOUDLY, which is what this file is.
//
// It is a PIN, not a behaviour test. Nothing here exercises a code path; every
// assertion re-states a number ADR 0022 reasoned about, so a change to that
// number lands on a human who then has to read the ADR. A green suite after a
// dial change would mean the spec and the code had silently diverged again —
// which is the exact state issue #923 called unacceptable.
//
// SOURCE-TEXT ASSERTIONS ARE DELIBERATE for the two worker-side dials. The
// interval constant is module-private, and both worker files are composition
// roots that import the `sql` singleton — importing either from a unit test
// would open a database connection to read a number. Reading the registration
// site as text is the precedent already used by
// `worker/ingress/__tests__/unsubscribe-rate-limit.test.ts` and
// `worker/background/schedulers/__tests__/AutonomyGovernorScheduler.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Resend's published limit. PER TEAM, not per key — a separate
 *  `SOLICITATION_RESEND_API_KEY` (§1.6) does not split it, which is the whole
 *  reason §7.1 exists. */
const RESEND_TEAM_LIMIT_PER_SECOND = 10;

/** The ceiling ADR 0022 accepted. The solicitation lane may consume at most
 *  this share of the team limit before the refusal has to be re-opened. */
const MAX_ACCEPTED_SHARE_OF_TEAM_LIMIT = 0.01; // 1%

const ADR = 'ADR 0022 (docs/adr/0022-solicitation-rate-cap-not-yield.md)';

function readPoller(): string {
  return readFileSync(
    path.join(REPO_ROOT, 'worker/background/pollers/SolicitationReleasePoller.ts'),
    'utf8',
  );
}

function readWorkerEntry(): string {
  return readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
}

/** The poller's default interval, read from its source because the constant is
 *  module-private. Returns milliseconds. */
function releaseIntervalMs(): number {
  const raw = /const DEFAULT_INTERVAL_MS = ([\d_]+);/.exec(readPoller())?.[1] ?? '';
  expect(
    raw,
    'SolicitationReleasePoller no longer declares DEFAULT_INTERVAL_MS in the shape this pin reads. '
      + `The release cadence is one of the four dials ${ADR} bounds — re-derive the share of the `
      + 'team limit before changing how it is spelled.',
  ).not.toBe('');
  return Number(raw.replace(/_/g, ''));
}

describe('#923 / §7.1 — the solicitation lane is rate-capped, not yielding', () => {
  it('pins RELEASE_PER_TICK_BUDGET, dial 1 of four', () => {
    expect(
      RELEASE_PER_TICK_BUDGET,
      'RELEASE_PER_TICK_BUDGET changed. This is dial 1 of the four bounds in '
        + `${ADR}, which refuses to build the shared limiter §7.1 asks for BECAUSE the `
        + 'solicitation lane cannot reach the transactional lane at these values. Raising it '
        + 'spends that refusal. Read the ADR, decide whether the yield now has to be built, '
        + 'and update BOTH the constant and the ADR.',
    ).toBe(2);
  });

  it('pins the release poll interval, the other half of dial 1', () => {
    expect(
      releaseIntervalMs(),
      `The release poll interval changed. Budget and interval are one dial in ${ADR} — `
        + 'halving the interval doubles the lane\'s throughput exactly as raising the budget does.',
    ).toBe(60_000);
  });

  it('pins send-worker single concurrency, dial 2 of four', () => {
    const source = readWorkerEntry();
    const registration = /QUEUE_NAMES\.SOLICITATION_SEND,[\s\S]{0,400}?concurrency: 1\b/.exec(source);
    expect(
      registration,
      'The solicitation send worker is no longer registered with concurrency: 1. That is dial 2 '
        + `of the four bounds in ${ADR}: single concurrency is what makes the per-tick budget a `
        + 'BURST bound and not merely an average one.',
    ).not.toBeNull();
  });

  it('keeps the boot assertion that makes dial 2 fail loudly rather than silently', () => {
    const source = readWorkerEntry();
    expect(
      source.includes('assertSingleConcurrencyWorker(QUEUE_NAMES.SOLICITATION_SEND'),
      'worker/index.ts no longer boot-asserts single concurrency for the solicitation send queue. '
        + `Without it, dial 2 of ${ADR} can be raised by an edit that boots clean.`,
    ).toBe(true);
  });

  it('re-derives the lane share of the Resend team limit and holds it under 1%', () => {
    // The instantaneous bound, not the daily one. Single concurrency means the
    // lane cannot burst above this average within a tick.
    const sendsPerSecond = RELEASE_PER_TICK_BUDGET / (releaseIntervalMs() / 1000);
    const share = sendsPerSecond / RESEND_TEAM_LIMIT_PER_SECOND;

    expect(
      share,
      `The solicitation lane now claims ${(share * 100).toFixed(2)}% of Resend's ${RESEND_TEAM_LIMIT_PER_SECOND} `
        + `req/s TEAM limit, past the ${MAX_ACCEPTED_SHARE_OF_TEAM_LIMIT * 100}% ceiling ${ADR} accepted. `
        + 'At that share the "two per minute against ten per second is not contention" argument no '
        + 'longer carries the refusal, and §7.1\'s yield has to be built.',
    ).toBeLessThanOrEqual(MAX_ACCEPTED_SHARE_OF_TEAM_LIMIT);

    // Non-vacuity: the derivation above must be reading real numbers, not two
    // zeroes that would satisfy any ceiling.
    expect(sendsPerSecond).toBeGreaterThan(0);
  });

  it('names the ADR at the constant, so the dial and the decision are one hop apart', () => {
    const release = readFileSync(
      path.join(REPO_ROOT, 'src/lib/solicitation/release.ts'),
      'utf8',
    );
    expect(
      release.includes('ADR 0022'),
      'RELEASE_PER_TICK_BUDGET\'s docstring no longer points at ADR 0022. The pointer is the '
        + 'only thing that puts the arithmetic in front of the person changing the number.',
    ).toBe(true);
  });
});
