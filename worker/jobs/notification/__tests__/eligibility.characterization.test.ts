// worker/jobs/notification/__tests__/eligibility.characterization.test.ts
//
// Characterization pins for getEligibleChannels' per-channel flag filter and
// its flag-disabled skip-log line. eligibility.ts had NO direct tests; these
// lock the OBSERVABLE behavior (which channels survive the filter + the exact
// skip-log strings, including the 'Telegram'/'WhatsApp' display labels) so the
// 2e-4 single-sourcing of the channel→flag map (flags.ts) and the display-label
// map is provably behavior-preserving. MUST stay green byte-for-byte before AND
// after that refactor.
//
// resolveChannels is mocked to return a controlled enrollment list (the DB read
// is out of scope). checkSubscription is pure (status-driven) so 'active' is
// used to reach the filter. The per-channel flags are read from process.env via
// readFlag (NOT mocked, not memoized) — toggled directly here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockResolveChannels } = vi.hoisted(() => ({ mockResolveChannels: vi.fn() }));

vi.mock('@/lib/notifications/resolve-channels', () => ({
  resolveChannels: mockResolveChannels,
}));

import { getEligibleChannels, type EligibilityInput } from '../eligibility';
import type { ResolvedChannel } from '@/lib/notifications/resolve-channels';

const ORIGINAL_ENV = { ...process.env };

const TELEGRAM_FLAG = 'CHANNELS_TELEGRAM_ENABLED';
const WHATSAPP_FLAG = 'CHANNELS_WHATSAPP_ENABLED';

const LOCATION_ID = 'loc-abc';

const EMAIL: ResolvedChannel = { channel: 'email', handle: 'owner@example.com', location_id: null };
const TELEGRAM: ResolvedChannel = { channel: 'telegram', handle: '123456789', location_id: null };
const WHATSAPP: ResolvedChannel = { channel: 'whatsapp', handle: '+15550000001', location_id: null };

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    accountId: 'acct-1',
    locationId: LOCATION_ID,
    subscriptionStatus: 'active',
    ...overrides,
  };
}

function makeLogger() {
  return { log: vi.fn() };
}

/** Byte-exact expected skip-log line (note the em-dash U+2014). */
function skipLine(label: string, locationId: string): string {
  return `${label} channel disabled by flag — skipping enrollment for location ${locationId}`;
}

function setFlag(name: string, on: boolean): void {
  if (on) process.env[name] = 'true';
  else delete process.env[name];
}

beforeEach(() => {
  mockResolveChannels.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getEligibleChannels — flag filter + skip-log characterization', () => {
  it('both flags OFF: only email survives; telegram + whatsapp each logged (byte-exact, in order)', async () => {
    setFlag(TELEGRAM_FLAG, false);
    setFlag(WHATSAPP_FLAG, false);
    mockResolveChannels.mockResolvedValue([EMAIL, TELEGRAM, WHATSAPP]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: true, enrollments: [EMAIL] });
    expect(logger.log.mock.calls).toEqual([
      [skipLine('Telegram', LOCATION_ID)],
      [skipLine('WhatsApp', LOCATION_ID)],
    ]);
  });

  it('telegram ON, whatsapp OFF: email + telegram survive; only whatsapp logged', async () => {
    setFlag(TELEGRAM_FLAG, true);
    setFlag(WHATSAPP_FLAG, false);
    mockResolveChannels.mockResolvedValue([EMAIL, TELEGRAM, WHATSAPP]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: true, enrollments: [EMAIL, TELEGRAM] });
    expect(logger.log.mock.calls).toEqual([[skipLine('WhatsApp', LOCATION_ID)]]);
  });

  it('whatsapp ON, telegram OFF: email + whatsapp survive; only telegram logged', async () => {
    setFlag(TELEGRAM_FLAG, false);
    setFlag(WHATSAPP_FLAG, true);
    mockResolveChannels.mockResolvedValue([EMAIL, TELEGRAM, WHATSAPP]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: true, enrollments: [EMAIL, WHATSAPP] });
    expect(logger.log.mock.calls).toEqual([[skipLine('Telegram', LOCATION_ID)]]);
  });

  it('both flags ON: all three survive; nothing logged', async () => {
    setFlag(TELEGRAM_FLAG, true);
    setFlag(WHATSAPP_FLAG, true);
    mockResolveChannels.mockResolvedValue([EMAIL, TELEGRAM, WHATSAPP]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: true, enrollments: [EMAIL, TELEGRAM, WHATSAPP] });
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('email always survives regardless of flags (no flag gate)', async () => {
    setFlag(TELEGRAM_FLAG, false);
    setFlag(WHATSAPP_FLAG, false);
    mockResolveChannels.mockResolvedValue([EMAIL]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: true, enrollments: [EMAIL] });
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('skip-log location is input.locationId even when enrollment is a per-location override', async () => {
    setFlag(TELEGRAM_FLAG, false);
    const override: ResolvedChannel = { channel: 'telegram', handle: '999', location_id: 'other-loc' };
    mockResolveChannels.mockResolvedValue([override]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input({ locationId: 'loc-input' }), logger);

    expect(result).toEqual({ ok: true, enrollments: [] });
    expect(logger.log.mock.calls).toEqual([[skipLine('Telegram', 'loc-input')]]);
  });

  it('subscription gate denies before resolving (cancelled → ok:false)', async () => {
    const logger = makeLogger();

    const result = await getEligibleChannels(
      {} as never,
      input({ subscriptionStatus: 'cancelled' }),
      logger,
    );

    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(mockResolveChannels).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('no resolved enrollments → ok:false reason no_verified_enrollments', async () => {
    mockResolveChannels.mockResolvedValue([]);
    const logger = makeLogger();

    const result = await getEligibleChannels({} as never, input(), logger);

    expect(result).toEqual({ ok: false, reason: 'no_verified_enrollments' });
    expect(logger.log).not.toHaveBeenCalled();
  });
});
