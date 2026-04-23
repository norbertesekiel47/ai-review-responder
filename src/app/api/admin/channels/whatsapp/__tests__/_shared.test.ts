import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';

describe('isWhatsAppEnabled', () => {
  it('returns false when env unset', () => {
    delete process.env.CHANNELS_WHATSAPP_ENABLED;
    expect(isWhatsAppEnabled()).toBe(false);
  });
  it('returns true when env is "true"', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    expect(isWhatsAppEnabled()).toBe(true);
  });
});

describe('flagOff', () => {
  it('returns 404 not_found', async () => {
    const res = flagOff();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });
});

describe('assertWhatsAppEnvReady', () => {
  const KEYS = [
    'MOCK_EXTERNAL_APIS',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
    'WHATSAPP_APPROVAL_TEMPLATE_SID',
    'WHATSAPP_APPROVAL_URL_BASE',
  ];
  const snap: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  });

  it('returns null when MOCK_EXTERNAL_APIS=true', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(assertWhatsAppEnvReady()).toBe(null);
  });
  it('returns 503 NextResponse when env missing', async () => {
    const res = assertWhatsAppEnvReady()!;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe('whatsapp_env_not_ready');
    expect(body.missing).toEqual(
      expect.arrayContaining([
        'TWILIO_WHATSAPP_NUMBER',
        'WHATSAPP_APPROVAL_TEMPLATE_SID',
        'WHATSAPP_APPROVAL_URL_BASE',
      ]),
    );
  });
  it('returns null when all env set', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    expect(assertWhatsAppEnvReady()).toBe(null);
  });
});
