import { afterEach, describe, expect, it } from 'vitest';
import {
  channelsTelegramEnabled,
  channelsWhatsappEnabled,
  emailChannelReconcileDisabled,
} from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const FALSE_CASES: ReadonlyArray<[string, string | undefined]> = [
  ['missing', undefined],
  ['empty', ''],
  ['false', 'false'],
  ['uppercase TRUE', 'TRUE'],
  ['mixed case True', 'True'],
  ['numeric 1', '1'],
  ['padded true', ' true '],
];

const ACCESSORS: ReadonlyArray<[string, () => boolean]> = [
  ['CHANNELS_TELEGRAM_ENABLED', channelsTelegramEnabled],
  ['CHANNELS_WHATSAPP_ENABLED', channelsWhatsappEnabled],
  ['EMAIL_CHANNEL_RECONCILE_DISABLED', emailChannelReconcileDisabled],
];

describe.each(ACCESSORS)('%s accessor', (envName, accessor) => {
  it.each(FALSE_CASES)('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
    expect(accessor()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env[envName] = 'true';
    expect(accessor()).toBe(true);
  });
});
