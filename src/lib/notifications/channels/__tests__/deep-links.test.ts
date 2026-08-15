import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetServerConfigForTests } from '@/lib/config/server';
import { buildMobileDeepLink } from '../deep-links';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthStagingBot';
  // getServerConfig() memoizes process.env on first read, so without this reset
  // the first test to call the builder freezes the snapshot every later test
  // reads — and a test that sets its own env value would silently assert against
  // the beforeEach value instead. That produced a vacuously-green wa.me case in
  // the sibling admin bindings suite. Do NOT remove this to make a future
  // failure go away; the failure would be real.
  resetServerConfigForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetServerConfigForTests();
});

describe('buildMobileDeepLink', () => {
  it('the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER', () => {
    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';

    expect(buildMobileDeepLink('whatsapp', 'tok-1')).toBe(
      'https://wa.me/15551234567?text=start-tok-1',
    );
  });

  it('admin and owner build the same wa.me deep link for the same token', () => {
    // The two portals' copies diverged on NORMALISATION, not on the template:
    // admin stripped /^whatsapp:\+?/ (leaving spaces/parens in the path), owner
    // stripped /\D/g. So "same link" is only meaningful across the two env
    // spellings those copies used to disagree about — feed both through the one
    // surviving builder and require an identical result.
    //
    // Do NOT reduce this to calling the builder twice with identical arguments
    // and asserting the results match: that is a tautology over a pure function
    // and passes no matter what the builder does.
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    resetServerConfigForTests();
    const fromPrefixedForm = buildMobileDeepLink('whatsapp', 'tok-2');

    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';
    resetServerConfigForTests();
    const fromFormattedForm = buildMobileDeepLink('whatsapp', 'tok-2');

    expect(fromPrefixedForm).toBe(fromFormattedForm);
    expect(fromPrefixedForm).toBe('https://wa.me/15551234567?text=start-tok-2');
  });

  it('the wa.me builder throws with context when TWILIO_WHATSAPP_NUMBER is unset', () => {
    // Reachable in mock mode: whatsappEnvReady() returns true on
    // MOCK_EXTERNAL_APIS=true without the var being set, so the env gate does
    // not guarantee it. Previously a bare `!` made this a TypeError raised
    // AFTER the enrollment row committed; runChannelStart now builds the link
    // before the write, so this must fail loudly and namefully.
    delete process.env.TWILIO_WHATSAPP_NUMBER;
    resetServerConfigForTests();

    expect(() => buildMobileDeepLink('whatsapp', 'tok-4')).toThrow(
      /TWILIO_WHATSAPP_NUMBER is unset/,
    );
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
