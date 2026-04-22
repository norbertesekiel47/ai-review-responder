import { describe, it, expect, beforeEach } from 'vitest';
import { getChannel } from '../index';

describe('getChannel', () => {
  beforeEach(() => {
    delete process.env.CHANNELS_SMS_ENABLED;
  });

  it('returns EmailChannel for email regardless of flag state', () => {
    const ch = getChannel('email');
    expect(ch.id).toBe('email');
  });

  it('throws for sms when CHANNELS_SMS_ENABLED is unset', () => {
    expect(() => getChannel('sms')).toThrow(/disabled by CHANNELS_SMS_ENABLED/);
  });

  it('throws for sms when CHANNELS_SMS_ENABLED=false', () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    expect(() => getChannel('sms')).toThrow(/disabled by CHANNELS_SMS_ENABLED/);
  });

  it('returns SmsChannel instance when flag is on', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    const ch = getChannel('sms');
    expect(ch.id).toBe('sms');
    expect(ch.supportsInlineActions).toBe(false);
    expect(ch.requiresOptInHandshake).toBe(false);
  });

  it('throws not-yet-implemented for whatsapp regardless of flag', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    expect(() => getChannel('whatsapp')).toThrow(/not yet implemented/);
  });

  describe('getChannel — telegram', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it('returns TelegramChannel when flag on', async () => {
      process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
      const { getChannel, TelegramChannel } = await import('../index');
      expect(getChannel('telegram')).toBeInstanceOf(TelegramChannel);
    });

    it('throws with clear message when flag off', () => {
      process.env.CHANNELS_TELEGRAM_ENABLED = 'false';
      expect(() => getChannel('telegram')).toThrow(/CHANNELS_TELEGRAM_ENABLED/);
    });

    it('throws with clear message when flag unset', () => {
      delete process.env.CHANNELS_TELEGRAM_ENABLED;
      expect(() => getChannel('telegram')).toThrow(/CHANNELS_TELEGRAM_ENABLED/);
    });
  });
});
