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

  it('throws not-yet-implemented for telegram regardless of flag', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    expect(() => getChannel('telegram')).toThrow(/not yet implemented/);
  });

  it('throws not-yet-implemented for whatsapp regardless of flag', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    expect(() => getChannel('whatsapp')).toThrow(/not yet implemented/);
  });
});
