import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMobileDeepLink } from '../deep-links';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthStagingBot';
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('buildMobileDeepLink', () => {
  it('the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER', () => {
    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';

    expect(buildMobileDeepLink('whatsapp', 'tok-1')).toBe(
      'https://wa.me/15551234567?text=start-tok-1',
    );
  });

  it('admin and owner build the same wa.me deep link for the same token', () => {
    // One builder, one result — the divergence this refactor closes is that the
    // two portals used to own separate copies of this expression.
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';

    const first = buildMobileDeepLink('whatsapp', 'tok-2');
    const second = buildMobileDeepLink('whatsapp', 'tok-2');

    expect(first).toBe(second);
    expect(first).toBe('https://wa.me/15551234567?text=start-tok-2');
  });

  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank', () => {
    process.env.TELEGRAM_BOT_USERNAME = '   ';

    expect(buildMobileDeepLink('telegram', 'tok-3')).toBe('https://t.me/RepWorthBot?start=tok-3');
  });

  it('uses the configured Telegram bot username when it is set', () => {
    expect(buildMobileDeepLink('telegram', 'tok-4')).toBe(
      'https://t.me/RepWorthStagingBot?start=tok-4',
    );
  });
});
