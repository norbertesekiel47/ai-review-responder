import { getCacheRedis } from '@/lib/db/redis-cache';

const DEFAULT_DAILY_CENTS = 1000; // $10/day
const RESERVATION_CENTS = 20;     // ~$0.01 SerpAPI + ~$0.015 LLM + headroom

export class CostCeilingExceeded extends Error {
  constructor(public readonly date: string) {
    super(`Onboarding demo daily cost ceiling exceeded for ${date}`);
    this.name = 'CostCeilingExceeded';
  }
}

function dailyKey(date: string): string {
  return `cost:onboarding-demo:${date}`;
}

function overrideKey(): string {
  return 'cost:onboarding-demo:override:cents';
}

/**
 * Reserves budget for one onboarding demo. Returns a release function
 * that MUST be called on tx failure to avoid leaking the reservation.
 */
export async function reserveOnboardingDemoBudget(): Promise<{
  release: () => Promise<void>;
  date: string;
}> {
  const date = new Date().toISOString().slice(0, 10);
  const key = dailyKey(date);

  const redis = getCacheRedis();
  const override = await redis.get(overrideKey());
  const ceiling = override ? parseInt(override, 10) : DEFAULT_DAILY_CENTS;

  const current = await redis.incrby(key, RESERVATION_CENTS);
  if (current > ceiling) {
    // Roll back the reservation
    await redis.decrby(key, RESERVATION_CENTS);
    throw new CostCeilingExceeded(date);
  }

  // Ensure TTL (defense against leaks)
  await redis.pexpire(key, 25 * 60 * 60 * 1000); // 25 hours

  return {
    release: async () => {
      await redis.decrby(key, RESERVATION_CENTS);
    },
    date,
  };
}

/**
 * Finalizes the cost reservation with actual spend. The difference between
 * reservation (20¢) and actual is left as "pre-spent" headroom.
 */
export async function finalizeOnboardingDemoCost(
  date: string,
  actualCostCents: number,
): Promise<void> {
  if (!Number.isSafeInteger(actualCostCents) || actualCostCents < 0) {
    throw new TypeError(`Invalid actualCostCents=${actualCostCents}`);
  }
  const delta = actualCostCents - RESERVATION_CENTS;
  if (delta !== 0) {
    const redis = getCacheRedis();
    await redis.incrby(dailyKey(date), delta);
  }
}

export interface ThresholdResult {
  crossed: number[];
}

/**
 * Returns the thresholds NEWLY crossed on this call — i.e. percentages of
 * the daily ceiling that current spend has reached AND that have not yet
 * been alerted today. Each threshold fires at most once per day per lane,
 * so callers (worker → Sentry) don't get spammed when the daily counter
 * sits above a threshold for the rest of the day.
 *
 * Implementation: SADD into a daily set returns 1 only on first insert
 * per member, giving us atomic per-threshold "did I just fire this?"
 * semantics. The set TTLs at 25h to align with the spend counter and
 * avoid leaking keys across day boundaries.
 *
 * Thresholds: [50, 90, 100] means alert at 50%, 90%, and 100% of ceiling.
 */
export async function checkCostThreshold(
  lane: string,
  date: string,
  thresholds: number[],
): Promise<ThresholdResult> {
  const redis = getCacheRedis();

  const override = await redis.get(`cost:${lane}:override:cents`);
  const ceiling = override ? parseInt(override, 10) : DEFAULT_DAILY_CENTS;

  const currentRaw = await redis.get(`cost:${lane}:${date}`);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  const alertedKey = `cost:${lane}:alerted:${date}`;
  const newlyCrossed: number[] = [];

  for (const t of thresholds) {
    const thresholdCents = Math.floor((ceiling * t) / 100);
    if (current < thresholdCents) continue;
    const added = await redis.sadd(alertedKey, String(t));
    if (added === 1) newlyCrossed.push(t);
  }

  if (newlyCrossed.length > 0) {
    await redis.pexpire(alertedKey, 25 * 60 * 60 * 1000);
  }

  return { crossed: newlyCrossed };
}

/**
 * Wraps a function with onboarding demo cost guard.
 * Reservation lives OUTSIDE the fn but INSIDE try/catch.
 */
export async function withOnboardingDemoCostGuard<T>(
  _opts: { ipKey: string },
  fn: () => Promise<{ value: T; actualCostCents: number }>,
): Promise<T> {
  const reservation = await reserveOnboardingDemoBudget();
  try {
    const { value, actualCostCents } = await fn();
    await finalizeOnboardingDemoCost(reservation.date, actualCostCents);
    return value;
  } catch (err) {
    await reservation.release();
    throw err;
  }
}
