import { describe, it, expect, beforeEach } from 'vitest';
import { verifyTelegramSecret } from '../telegram-verify';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

// verifyTelegramSecret now reads TELEGRAM_WEBHOOK_SECRET via the memoized
// getWorkerConfig(); each test mutates the env BEFORE the call, so the memo must
// be cleared after the mutation (Stage-3 convention #6). setSecret() sets/deletes
// the env AND clears the memo so the next verifyTelegramSecret() re-parses — every
// assertion below is unchanged.
function setSecret(value: string | undefined): void {
  if (value === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = value;
  resetWorkerConfigForTests();
}

describe('verifyTelegramSecret', () => {
  beforeEach(() => {
    setSecret(undefined);
  });

  it('returns false when TELEGRAM_WEBHOOK_SECRET is not set', () => {
    expect(verifyTelegramSecret('anything')).toBe(false);
  });

  it('returns false when header is undefined', () => {
    setSecret('secret-123');
    expect(verifyTelegramSecret(undefined)).toBe(false);
  });

  it('returns true when header matches exactly', () => {
    setSecret('secret-123');
    expect(verifyTelegramSecret('secret-123')).toBe(true);
  });

  it('returns false when header differs', () => {
    setSecret('secret-123');
    expect(verifyTelegramSecret('secret-456')).toBe(false);
  });

  it('returns false when lengths differ (no early-exit leak)', () => {
    setSecret('secret-123');
    expect(verifyTelegramSecret('secret-1234567890')).toBe(false);
  });
});
