import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertWhatsAppEnvReady, whatsappEnvReady, missingWhatsAppEnv } from '../whatsapp-env';
import { flagOff } from '@/app/api/_shared/channels/flag-off';

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

const ALL = {
  TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_WHATSAPP_NUMBER: 'whatsapp:+15551230000',
  WHATSAPP_APPROVAL_TEMPLATE_SID: 'HX', WHATSAPP_APPROVAL_URL_BASE: 'http://localhost/approve/',
};

describe('whatsappEnvReady / missingWhatsAppEnv', () => {
  beforeEach(() => {
    delete process.env.MOCK_EXTERNAL_APIS;
    for (const k of Object.keys(ALL)) delete process.env[k];
  });

  it('reports all five vars missing when none set', () => {
    expect(missingWhatsAppEnv().sort()).toEqual(Object.keys(ALL).sort());
    expect(whatsappEnvReady()).toBe(false);
  });

  it('treats WHATSAPP_APPROVAL_URL_BASE as required (the var the old 4-var checks dropped)', () => {
    for (const [k, v] of Object.entries(ALL)) process.env[k] = v;
    delete process.env.WHATSAPP_APPROVAL_URL_BASE;
    expect(missingWhatsAppEnv()).toEqual(['WHATSAPP_APPROVAL_URL_BASE']);
    expect(whatsappEnvReady()).toBe(false);
  });

  it('is ready when all five present', () => {
    for (const [k, v] of Object.entries(ALL)) process.env[k] = v;
    expect(whatsappEnvReady()).toBe(true);
  });

  it('MOCK_EXTERNAL_APIS bypasses the check', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(whatsappEnvReady()).toBe(true);
  });
});
