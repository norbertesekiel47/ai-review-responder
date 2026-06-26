import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withOnboardingDemoCostGuard,
  reserveOnboardingDemoBudget,
  checkCostThreshold,
  CostCeilingExceeded,
} from '../onboarding-demo-cost-guard';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  pexpire: vi.fn(),
  sadd: vi.fn(),
};

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockRedis,
}));

describe('onboarding-demo-cost-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.incrby.mockResolvedValue(20);
    mockRedis.decrby.mockResolvedValue(0);
    mockRedis.pexpire.mockResolvedValue(1);
    mockRedis.sadd.mockResolvedValue(1);
  });

  it('reserve succeeds when under ceiling', async () => {
    const r = await reserveOnboardingDemoBudget();
    expect(r.release).toBeTypeOf('function');
    expect(mockRedis.incrby).toHaveBeenCalledWith(expect.stringContaining('cost:onboarding-demo:'), 20);
  });

  it('reserve throws CostCeilingExceeded when over ceiling', async () => {
    mockRedis.incrby.mockResolvedValue(1020);
    await expect(reserveOnboardingDemoBudget()).rejects.toBeInstanceOf(CostCeilingExceeded);
    expect(mockRedis.decrby).toHaveBeenCalled();
  });

  it('withOnboardingDemoCostGuard: success path finalizes cost', async () => {
    const result = await withOnboardingDemoCostGuard(
      { ipKey: '1.2.3.4' },
      async () => ({ value: 'done', actualCostCents: 15 }),
    );
    expect(result).toBe('done');
    expect(mockRedis.incrby).toHaveBeenCalled();
  });

  it('withOnboardingDemoCostGuard: fn throws releases reservation', async () => {
    await expect(
      withOnboardingDemoCostGuard(
        { ipKey: '1.2.3.4' },
        async () => { throw new Error('boom'); },
      ),
    ).rejects.toThrow('boom');
    expect(mockRedis.decrby).toHaveBeenCalled();
  });

  it('checkCostThreshold returns newly-crossed thresholds on first call', async () => {
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('600');
    mockRedis.sadd.mockResolvedValue(1);
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([50]);
    expect(mockRedis.sadd).toHaveBeenCalledWith('cost:onboarding-demo:alerted:2026-05-03', '50');
    expect(mockRedis.pexpire).toHaveBeenCalled();
  });

  it('checkCostThreshold dedupes: returns [] when threshold already alerted today', async () => {
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('600');
    mockRedis.sadd.mockResolvedValue(0);
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([]);
    expect(mockRedis.pexpire).not.toHaveBeenCalled();
  });

  it('checkCostThreshold returns multiple thresholds when spend leaps past several', async () => {
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('950');
    mockRedis.sadd.mockResolvedValue(1);
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([50, 90]);
  });
});

// Behavior-preservation spot-check for the migrated ONBOARDING_DEMO_DAILY_CENTS
// read (now via getServerConfig(), Stage-3 src-lib batch). The env-override
// ceiling branch in resolveCeilingCents must still: prefer the Redis override,
// else honor a valid positive ONBOARDING_DEMO_DAILY_CENTS, else fall back to
// DEFAULT_DAILY_CENTS (1000). Driven through reserveOnboardingDemoBudget, whose
// CostCeilingExceeded throw fires once the running total exceeds the ceiling.
describe('onboarding-demo-cost-guard: ONBOARDING_DEMO_DAILY_CENTS env ceiling', () => {
  let SNAP: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null); // no Redis override
    mockRedis.decrby.mockResolvedValue(0);
    mockRedis.pexpire.mockResolvedValue(1);
    SNAP = process.env.ONBOARDING_DEMO_DAILY_CENTS;
    delete process.env.ONBOARDING_DEMO_DAILY_CENTS;
  });
  afterEach(() => {
    if (SNAP === undefined) delete process.env.ONBOARDING_DEMO_DAILY_CENTS;
    else process.env.ONBOARDING_DEMO_DAILY_CENTS = SNAP;
  });

  async function freshGuard() {
    vi.resetModules();
    return import('../onboarding-demo-cost-guard');
  }

  it('honors a valid ONBOARDING_DEMO_DAILY_CENTS override (lower ceiling rejects sooner)', async () => {
    process.env.ONBOARDING_DEMO_DAILY_CENTS = '100';
    const { reserveOnboardingDemoBudget, CostCeilingExceeded } = await freshGuard();
    // running total 120 > 100 ceiling → reject (would be UNDER the 1000 default).
    mockRedis.incrby.mockResolvedValue(120);
    await expect(reserveOnboardingDemoBudget()).rejects.toBeInstanceOf(CostCeilingExceeded);
  });

  it('falls back to the 1000-cent default when ONBOARDING_DEMO_DAILY_CENTS is unset', async () => {
    const { reserveOnboardingDemoBudget } = await freshGuard();
    // running total 120 is under the 1000 default → succeeds.
    mockRedis.incrby.mockResolvedValue(120);
    const r = await reserveOnboardingDemoBudget();
    expect(r.release).toBeTypeOf('function');
  });
});
