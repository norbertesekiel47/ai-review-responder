import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The Sending identity's own Resend client (#657 Task 4, spec §1.6/§9). RED
// until `getSolicitationResend` exists — today `../client` exports only
// `getResend`.
//
// The Resend SDK is faked at the module boundary so the constructor argument is
// observable: the ONE fact this file exists to prove is that the solicitation
// lane never reaches for RESEND_API_KEY. A key leaked from this lane must not be
// able to send transactional mail, or it can forge an approval email and reach
// invariants #3 and #5 sideways.

const { constructedKeys } = vi.hoisted(() => ({ constructedKeys: [] as (string | undefined)[] }));

vi.mock('resend', () => ({
  Resend: class FakeResend {
    constructor(public readonly apiKey?: string) {
      constructedKeys.push(apiKey);
    }
  },
}));

const TRANSACTIONAL_KEY = 're_transactional_657_key';
const SOLICITATION_KEY = 're_solicitation_657_key';

/**
 * A fresh module graph per case, so the lazy singletons inside `client.ts` and
 * the memoized `getServerConfig()` both start empty. Returns the config module
 * too, for the one case that changes env WITHOUT resetting the graph.
 */
async function freshClientModule() {
  vi.resetModules();
  constructedKeys.length = 0;
  const config = await import('@/lib/config/server');
  const client = await import('../client');
  return { client, config };
}

describe('getSolicitationResend', () => {
  const KEYS = ['RESEND_API_KEY', 'SOLICITATION_RESEND_API_KEY'] as const;
  const SNAP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      SNAP[k] = process.env[k];
      delete process.env[k];
    }
    process.env.RESEND_API_KEY = TRANSACTIONAL_KEY;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k];
      else process.env[k] = SNAP[k];
    }
    vi.resetModules();
  });

  it('getSolicitationResend throws when SOLICITATION_RESEND_API_KEY is unset', async () => {
    const { client } = await freshClientModule();

    // Fail closed. `getResend()` tolerates an undefined key (it predates this
    // rule); this one must not, because a client built with `undefined` would
    // fail at dispatch time instead of at the first call.
    expect(() => client.getSolicitationResend()).toThrow(/SOLICITATION_RESEND_API_KEY/);
    // Nothing was constructed, so nothing is cached behind the throw.
    expect(constructedKeys).toHaveLength(0);
  });

  it('getSolicitationResend never falls back to the transactional Resend client', async () => {
    process.env.SOLICITATION_RESEND_API_KEY = SOLICITATION_KEY;
    const { client } = await freshClientModule();

    const solicitation = client.getSolicitationResend();
    const transactional = client.getResend();

    // Two clients, two keys, two identities.
    expect(solicitation).not.toBe(transactional);
    expect(constructedKeys).toContain(SOLICITATION_KEY);
    expect((solicitation as unknown as { apiKey?: string }).apiKey).toBe(SOLICITATION_KEY);
    expect((solicitation as unknown as { apiKey?: string }).apiKey).not.toBe(TRANSACTIONAL_KEY);

    // And with only the transactional key present it refuses rather than
    // quietly borrowing it — the failure mode this whole split exists to stop.
    const second = await freshClientModule();
    delete process.env.SOLICITATION_RESEND_API_KEY;
    expect(() => second.client.getSolicitationResend()).toThrow();
    expect(constructedKeys).not.toContain(TRANSACTIONAL_KEY);
  });

  it('getSolicitationResend caches its client across calls', async () => {
    process.env.SOLICITATION_RESEND_API_KEY = SOLICITATION_KEY;
    const { client, config } = await freshClientModule();

    const first = client.getSolicitationResend();
    const second = client.getSolicitationResend();

    expect(second).toBe(first);
    expect(constructedKeys.filter((key) => key === SOLICITATION_KEY)).toHaveLength(1);

    // The contract this documents (review round 1, F4): the cache means a key
    // change does NOT take effect in a running process. Rotating or unsetting
    // the key requires a worker restart — which Railway does on any env change.
    // Asserting the opposite would pin a behaviour we are not building.
    process.env.SOLICITATION_RESEND_API_KEY = 're_rotated_657_key';
    config.resetServerConfigForTests();
    expect(client.getSolicitationResend()).toBe(first);
    expect(constructedKeys).not.toContain('re_rotated_657_key');
  });
});
