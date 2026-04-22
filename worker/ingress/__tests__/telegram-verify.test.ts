import { describe, it, expect, beforeEach } from 'vitest';
import { verifyTelegramSecret } from '../telegram-verify';

describe('verifyTelegramSecret', () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('returns false when TELEGRAM_WEBHOOK_SECRET is not set', () => {
    expect(verifyTelegramSecret('anything')).toBe(false);
  });

  it('returns false when header is undefined', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret(undefined)).toBe(false);
  });

  it('returns true when header matches exactly', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-123')).toBe(true);
  });

  it('returns false when header differs', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-456')).toBe(false);
  });

  it('returns false when lengths differ (no early-exit leak)', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-1234567890')).toBe(false);
  });
});
