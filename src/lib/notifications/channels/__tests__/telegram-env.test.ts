import { describe, it, expect, beforeEach } from 'vitest';
import { assertTelegramEnvReady } from '../telegram-env';
import { flagOff } from '@/app/api/_shared/channels/flag-off';

describe('admin telegram _shared', () => {
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  it('flagOff returns 404', async () => {
    const res = flagOff();
    expect(res.status).toBe(404);
  });

  it('assertTelegramEnvReady returns null in mock mode', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(assertTelegramEnvReady()).toBeNull();
  });

  it('assertTelegramEnvReady returns 503 when env missing', () => {
    const res = assertTelegramEnvReady();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it('assertTelegramEnvReady returns null when env complete', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(assertTelegramEnvReady()).toBeNull();
  });
});
