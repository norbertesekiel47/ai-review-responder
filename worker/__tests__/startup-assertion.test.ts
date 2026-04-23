import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertChannelsSmsEnv } from '../startup-assert';

const REQUIRED = [
  'WORKER_PUBLIC_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_VERIFY_SERVICE_SID',
];

describe('assertChannelsSmsEnv', () => {
  beforeEach(() => {
    for (const k of REQUIRED) delete process.env[k];
    delete process.env.CHANNELS_SMS_ENABLED;
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  it('no-op when CHANNELS_SMS_ENABLED is off', () => {
    process.env.CHANNELS_SMS_ENABLED = 'false';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('no-op when CHANNELS_SMS_ENABLED is unset', () => {
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('no-op in MOCK_EXTERNAL_APIS mode even with vars missing', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });

  it('throws with full list of missing vars when SMS enabled and none set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    try {
      assertChannelsSmsEnv();
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      for (const k of REQUIRED) expect(msg).toContain(k);
    }
  });

  it('throws naming only the missing var when 4 of 5 are set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    process.env.WORKER_PUBLIC_URL = 'https://x';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 't';
    process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG';
    // TWILIO_VERIFY_SERVICE_SID missing
    expect(() => assertChannelsSmsEnv()).toThrow(/TWILIO_VERIFY_SERVICE_SID/);
    expect(() => assertChannelsSmsEnv()).not.toThrow(/WORKER_PUBLIC_URL/);
  });

  it('treats whitespace-only env var as missing', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    for (const k of REQUIRED) process.env[k] = 'x';
    process.env.WORKER_PUBLIC_URL = '   ';
    expect(() => assertChannelsSmsEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('passes when all five vars are set', () => {
    process.env.CHANNELS_SMS_ENABLED = 'true';
    for (const k of REQUIRED) process.env[k] = 'x';
    expect(() => assertChannelsSmsEnv()).not.toThrow();
  });
});

import { assertChannelsTelegramEnv } from '../startup-assert';

describe('assertChannelsTelegramEnv', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is a no-op when flag is off', () => {
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('is a no-op when MOCK_EXTERNAL_APIS=true even with flag on', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('throws with all missing vars when flag is on and env is empty', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('passes when flag is on and all required vars are set', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-at-least-32-bytes-long-XXXXXXXXXXXXX';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });
});

import { assertChannelsWhatsAppEnv } from '../startup-assert';

describe('assertChannelsWhatsAppEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = [
    'CHANNELS_WHATSAPP_ENABLED', 'MOCK_EXTERNAL_APIS',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER',
    'WHATSAPP_APPROVAL_TEMPLATE_SID', 'WHATSAPP_APPROVAL_URL_BASE',
    'WORKER_PUBLIC_URL', 'NEXT_PUBLIC_APP_URL',
  ];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('is a no-op when flag is off', () => {
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });

  it('is a no-op in MOCK_EXTERNAL_APIS=true', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });

  it('throws when required env vars are missing', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/missing required env vars/);
  });

  it('throws if TWILIO_WHATSAPP_NUMBER is not whatsapp:+<digits>', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = '+15551234567';  // missing 'whatsapp:' prefix
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/TWILIO_WHATSAPP_NUMBER/);
  });

  it('throws if WHATSAPP_APPROVAL_URL_BASE does not equal NEXT_PUBLIC_APP_URL + "/approve/"', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://OTHER.example.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/WHATSAPP_APPROVAL_URL_BASE/);
  });

  it('passes with all vars set correctly', () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
    process.env.WHATSAPP_APPROVAL_TEMPLATE_SID = 'HX';
    process.env.WHATSAPP_APPROVAL_URL_BASE = 'https://app.repworth.com/approve/';
    process.env.WORKER_PUBLIC_URL = 'https://worker';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });
});
