import { describe, it, expect, beforeEach } from 'vitest';
import { assertTelegramEnvReady } from '../telegram-env';

// flagOff() is covered beside the module it lives in
// (src/app/api/_shared/channels/__tests__/flag-off.test.ts). Importing it here
// made this file one of only two `src/lib → src/app` imports in the repo — the
// dependency direction this branch exists to remove.
describe('telegram-env', () => {
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
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
