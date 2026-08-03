import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-session-cookie-secret-at-least-32-chars';
const TEN_MINUTES_MS = 10 * 60 * 1000;

// unsubscribe.ts → session-cookie-secret.ts reads SESSION_COOKIE_SECRET through
// the memoized getServerConfig(). Stub the secret, reset modules, then import
// dynamically so the memo re-parses the per-test value — the convention
// src/lib/account-offboarding/__tests__/tokens.test.ts established.
async function freshUnsubscribe() {
  vi.resetModules();
  return import('../unsubscribe');
}

function tokenHalves(rawToken: string): { nonce: string; mac: string } {
  const separator = rawToken.indexOf('.');
  return { nonce: rawToken.slice(0, separator), mac: rawToken.slice(separator + 1) };
}

describe('unsubscribe token', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_COOKIE_SECRET', TEST_SECRET);
  });

  it('hashes the raw token with SHA-256 and never returns or stores the raw value', async () => {
    const { hashUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();
    const rawToken = mintUnsubscribeRawToken();
    const tokenHash = hashUnsubscribeToken(rawToken);

    expect(tokenHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // Neither half of the raw token may survive into the digest, which is the
    // only value Postgres ever sees (invariant #5).
    const { nonce, mac } = tokenHalves(rawToken);
    expect(tokenHash).not.toContain(nonce);
    expect(tokenHash).not.toContain(mac);
  });

  it('a well formed token passes the hmac gate', async () => {
    const { isWellFormedUnsubscribeToken } = await freshUnsubscribe();
    // Built by hand from the documented wire format rather than from the minter,
    // so this pins `<nonce>.<base64url HMAC-SHA256(secret, context:nonce)>`
    // independently of how the minter happens to produce it.
    const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
    const mac = createHmac('sha256', TEST_SECRET)
      .update(`repworth:solicitation-unsubscribe-token:v1:${nonce}`)
      .digest('base64url');

    expect(isWellFormedUnsubscribeToken(`${nonce}.${mac}`)).toBe(true);
  });

  it('the minted raw token round trips through the hmac gate', async () => {
    const { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();
    const rawToken = mintUnsubscribeRawToken();

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedUnsubscribeToken(rawToken)).toBe(true);
    expect(mintUnsubscribeRawToken()).not.toBe(rawToken);
  });

  it('rejects forged and malformed tokens without throwing', async () => {
    const { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();
    const { nonce, mac } = tokenHalves(mintUnsubscribeRawToken());
    const tamperedNonce = `${nonce.slice(0, -1)}${nonce.endsWith('x') ? 'y' : 'x'}`;

    const rejected = [
      '',
      '.',
      nonce,
      `${nonce}.`,
      `.${mac}`,
      `${nonce}.${mac}.${mac}`,
      `${nonce}.${mac.slice(0, -1)}`,
      `${tamperedNonce}.${mac}`,
      `${nonce}.${'A'.repeat(mac.length)}`,
      'not base64url!.$$$',
      `${nonce}.${mac}\n`,
      `${nonce}/${mac}`,
      'x'.repeat(100_000),
      `${'x'.repeat(100_000)}.${mac}`,
    ];

    for (const candidate of rejected) {
      expect(() => isWellFormedUnsubscribeToken(candidate)).not.toThrow();
      expect(isWellFormedUnsubscribeToken(candidate)).toBe(false);
    }
  });

  it('fails loudly rather than rejecting every token when the signing secret is missing', async () => {
    // Force it falsy explicitly — unstubAllEnvs() restores the ambient value,
    // which CI sets.
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    const { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();

    expect(() => mintUnsubscribeRawToken()).toThrow(/SESSION_COOKIE_SECRET/);
    // A correctly SHAPED token must not read as forged when the secret is
    // missing: "every opt-out is malformed" is a silent statutory failure, so
    // the misconfiguration has to surface instead.
    expect(() => isWellFormedUnsubscribeToken('AAAAAAAAAAAAAAAAAAAAAA.BBBB')).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
  });
});

describe('unsubscribe receipt', () => {
  const tokenHash = createHash('sha256').update('a-raw-unsubscribe-token').digest('hex');
  const otherTokenHash = createHash('sha256').update('a-different-raw-token').digest('hex');

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_COOKIE_SECRET', TEST_SECRET);
  });

  it('mints and verifies a receipt in the documented wire format', async () => {
    const { mintUnsubscribeReceipt, verifyUnsubscribeReceipt } = await freshUnsubscribe();
    const issuedAtMs = Date.now();
    const receipt = mintUnsubscribeReceipt(tokenHash, issuedAtMs);

    expect(receipt).toBe(
      `${issuedAtMs}.${createHmac('sha256', TEST_SECRET)
        .update(`repworth:unsubscribe-receipt:v1:${tokenHash}:${issuedAtMs}`)
        .digest('base64url')}`,
    );
    expect(verifyUnsubscribeReceipt(tokenHash, receipt)).toBe(true);
  });

  it('rejects a receipt minted for a different token hash', async () => {
    const { mintUnsubscribeReceipt, verifyUnsubscribeReceipt } = await freshUnsubscribe();
    const receipt = mintUnsubscribeReceipt(otherTokenHash, Date.now());

    expect(verifyUnsubscribeReceipt(tokenHash, receipt)).toBe(false);
  });

  it('enforces the ten minute receipt TTL', async () => {
    const { mintUnsubscribeReceipt, verifyUnsubscribeReceipt } = await freshUnsubscribe();
    const now = Date.now();

    const justInside = mintUnsubscribeReceipt(tokenHash, now - (TEN_MINUTES_MS - 1_000));
    const justOutside = mintUnsubscribeReceipt(tokenHash, now - (TEN_MINUTES_MS + 1_000));

    expect(verifyUnsubscribeReceipt(tokenHash, justInside)).toBe(true);
    expect(verifyUnsubscribeReceipt(tokenHash, justOutside)).toBe(false);
  });

  it('rejects malformed receipts without throwing', async () => {
    const { mintUnsubscribeReceipt, verifyUnsubscribeReceipt } = await freshUnsubscribe();
    const issuedAtMs = Date.now();
    const { mac } = tokenHalves(mintUnsubscribeReceipt(tokenHash, issuedAtMs));

    const rejected = [
      '',
      '.',
      `${issuedAtMs}`,
      `${issuedAtMs}.`,
      `.${mac}`,
      `abc.${mac}`,
      `1e3.${mac}`,
      ` ${issuedAtMs}.${mac}`,
      `-${issuedAtMs}.${mac}`,
      `${Number.MAX_SAFE_INTEGER}0.${mac}`,
      `${issuedAtMs}.${mac.slice(0, -1)}`,
      'x'.repeat(100_000),
    ];

    for (const candidate of rejected) {
      expect(() => verifyUnsubscribeReceipt(tokenHash, candidate)).not.toThrow();
      expect(verifyUnsubscribeReceipt(tokenHash, candidate)).toBe(false);
    }
  });
});
