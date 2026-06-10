import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getChannel } from '../index';

describe('getChannel', () => {
  it('returns EmailChannel for email regardless of flag state', () => {
    const ch = getChannel('email');
    expect(ch.id).toBe('email');
  });

  it('throws for an unknown channel string (stale DB row defense)', () => {
    expect(() => getChannel('sms' as never)).toThrow(/Unknown channel/);
  });

  it('throws when whatsapp flag is off', () => {
    delete process.env.CHANNELS_WHATSAPP_ENABLED;
    expect(() => getChannel('whatsapp')).toThrow(/whatsapp channel disabled/i);
  });

  it('returns WhatsAppChannel when flag is on', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    const ch = getChannel('whatsapp');
    expect(ch.id).toBe('whatsapp');
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
