import { createHash, createHmac } from 'node:crypto';
import type { TransactionSql } from 'postgres';
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

  it('a forged token is rejected without opening a database connection', async () => {
    const {
      findRedeemableUnsubscribeToken,
      hasLiveGlobalSuppressionForToken,
      mintUnsubscribeRawToken,
      redeemUnsubscribeToken,
    } = await freshUnsubscribe();
    const { nonce } = tokenHalves(mintUnsubscribeRawToken());
    const forged = `${nonce}.${'A'.repeat(43)}`;

    // Throws on ANY use — a call or even a property read fails the test rather
    // than passing it. The admission gate is what lets both opt-out surfaces
    // stay unrate-limited without an unbounded public path to Postgres, so
    // "no query was issued" is too weak: no connection may be reached for.
    const refuseToBeUsed = () => {
      throw new Error('the database must not be touched for a forged token');
    };
    const executor = new Proxy(() => undefined, {
      apply: refuseToBeUsed,
      get: refuseToBeUsed,
    }) as unknown as TransactionSql;

    // Every entry point, not just the mutating one.
    await expect(findRedeemableUnsubscribeToken(executor, forged)).resolves.toBeNull();
    await expect(hasLiveGlobalSuppressionForToken(executor, forged)).resolves.toBe(false);
    await expect(
      redeemUnsubscribeToken(executor, { rawToken: forged, source: 'unsubscribe_one_click' }),
    ).resolves.toEqual({
      status: 'unknown_token',
      // Empty rather than a digest: this branch is reachable for input the gate
      // rejected on LENGTH, so hashing it would restore the unbounded work the
      // bound exists to prevent — and a never-minted token has nothing to
      // correlate with anyway.
      tokenHashPrefix: '',
    });
  });

  it('reports no token hash prefix for input the gate rejected on length', async () => {
    const { redeemUnsubscribeToken } = await freshUnsubscribe();
    const refuse = () => {
      throw new Error('the database must not be touched for a forged token');
    };
    const executor = new Proxy(() => undefined, {
      apply: refuse,
      get: refuse,
    }) as unknown as TransactionSql;

    const outcome = await redeemUnsubscribeToken(executor, {
      rawToken: 'x'.repeat(2_000_000),
      source: 'unsubscribe_link',
    });

    expect(outcome).toEqual({ status: 'unknown_token', tokenHashPrefix: '' });
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

describe('unsubscribe signing key rollover', () => {
  // The rotation this exists for: `token_hash` is an UNKEYED SHA-256, so rotating
  // SESSION_COOKIE_SECRET leaves every already-delivered token's row perfectly
  // redeemable while the token itself fails the gate BEFORE lookup. CAN-SPAM
  // §7704(a)(3) requires the link operate ≥30 days, and the same secret protects
  // session and offboarding domains where a compromise forces a rotation nobody
  // gets to decline.
  const OUTGOING_SECRET = 'previous-session-cookie-secret-at-least-32-chars';
  const INCOMING_SECRET = 'incoming-session-cookie-secret-at-least-32-chars';

  /** Mint under `secret` alone — i.e. before the rollover deploy. */
  async function mintUnder(secret: string): Promise<string> {
    vi.stubEnv('SESSION_COOKIE_SECRET', secret);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', '');
    const { mintUnsubscribeRawToken } = await freshUnsubscribe();
    return mintUnsubscribeRawToken();
  }

  /** The state after the rollover deploy: new key current, old key accepted. */
  async function afterRollover() {
    vi.stubEnv('SESSION_COOKIE_SECRET', INCOMING_SECRET);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', OUTGOING_SECRET);
    return freshUnsubscribe();
  }

  /** The state after the previous key is retired at the end of the window. */
  async function afterRetirement() {
    vi.stubEnv('SESSION_COOKIE_SECRET', INCOMING_SECRET);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', '');
    return freshUnsubscribe();
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('a token minted under the previous key still passes the gate', async () => {
    const delivered = await mintUnder(OUTGOING_SECRET);
    const { isWellFormedUnsubscribeToken } = await afterRollover();

    expect(isWellFormedUnsubscribeToken(delivered)).toBe(true);
  });

  it('a token minted under the previous key fails once that key is cleared', async () => {
    const delivered = await mintUnder(OUTGOING_SECRET);
    const { isWellFormedUnsubscribeToken } = await afterRetirement();

    // Clearing the previous key is the deliberate end of the rollover window, so
    // this MUST fail — an outgoing key that kept verifying forever would make the
    // rotation cosmetic.
    expect(isWellFormedUnsubscribeToken(delivered)).toBe(false);
  });

  it('a token minted under the current key passes with and without a previous key', async () => {
    const fresh = await mintUnder(INCOMING_SECRET);

    // Whether a previous key is configured is invisible to a current-key token —
    // the previous key is only ever consulted after the current one misses.
    const rolling = await afterRollover();
    expect(rolling.isWellFormedUnsubscribeToken(fresh)).toBe(true);

    const retired = await afterRetirement();
    expect(retired.isWellFormedUnsubscribeToken(fresh)).toBe(true);
  });

  it('minting always uses the current key, never the previous one', async () => {
    const { mintUnsubscribeRawToken } = await afterRollover();
    const minted = mintUnsubscribeRawToken();

    // Verifiable under the incoming key alone — so it will survive the moment the
    // outgoing key is retired, rather than expiring with it.
    const retired = await afterRetirement();
    expect(retired.isWellFormedUnsubscribeToken(minted)).toBe(true);
  });

  it('a forged token fails against both keys without opening a database connection', async () => {
    const delivered = await mintUnder(OUTGOING_SECRET);
    const { nonce } = tokenHalves(delivered);
    const forged = `${nonce}.${'A'.repeat(43)}`;
    const { findRedeemableUnsubscribeToken, isWellFormedUnsubscribeToken, redeemUnsubscribeToken } =
      await afterRollover();

    expect(isWellFormedUnsubscribeToken(forged)).toBe(false);

    // Two configured keys means two HMAC compares — and still ZERO database work.
    // Throws on ANY use, including a property read.
    const refuseToBeUsed = () => {
      throw new Error('the database must not be touched for a forged token');
    };
    const executor = new Proxy(() => undefined, {
      apply: refuseToBeUsed,
      get: refuseToBeUsed,
    }) as unknown as TransactionSql;

    await expect(findRedeemableUnsubscribeToken(executor, forged)).resolves.toBeNull();
    await expect(
      redeemUnsubscribeToken(executor, { rawToken: forged, source: 'unsubscribe_one_click' }),
    ).resolves.toEqual({ status: 'unknown_token', tokenHashPrefix: '' });
  });

  it('a receipt minted under the previous key still verifies', async () => {
    const tokenHash = createHash('sha256').update('a-raw-unsubscribe-token').digest('hex');
    vi.stubEnv('SESSION_COOKIE_SECRET', OUTGOING_SECRET);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', '');
    const before = await freshUnsubscribe();
    const receipt = before.mintUnsubscribeReceipt(tokenHash, Date.now());

    const { verifyUnsubscribeReceipt } = await afterRollover();
    expect(verifyUnsubscribeReceipt(tokenHash, receipt)).toBe(true);

    const retired = await afterRetirement();
    expect(retired.verifyUnsubscribeReceipt(tokenHash, receipt)).toBe(false);
  });

  // The default deployment state — the new var ships empty everywhere — so this
  // is what proves the change is inert until someone deliberately rotates.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('a %s previous key changes nothing about current key behaviour', async (_label, previous) => {
    vi.stubEnv('SESSION_COOKIE_SECRET', INCOMING_SECRET);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', previous);
    const { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();

    const minted = mintUnsubscribeRawToken();
    expect(isWellFormedUnsubscribeToken(minted)).toBe(true);
    expect(isWellFormedUnsubscribeToken(`${tokenHalves(minted).nonce}.${'A'.repeat(43)}`)).toBe(
      false,
    );
    // Still total over hostile input, and still throws on nothing but config.
    expect(() => isWellFormedUnsubscribeToken('x'.repeat(100_000))).not.toThrow();
  });

  it('still throws when the CURRENT secret is missing, previous key or not', async () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', OUTGOING_SECRET);
    const { isWellFormedUnsubscribeToken } = await freshUnsubscribe();

    // The previous key is a rollover affordance, never a way to keep running
    // without the real one — reclassifying every opt-out as malformed is exactly
    // the silent statutory failure the throw exists to prevent.
    expect(() => isWellFormedUnsubscribeToken('AAAAAAAAAAAAAAAAAAAAAA.BBBB')).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
  });

  it('a previous key too short to be an HMAC key fails loudly instead of being skipped', async () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', INCOMING_SECRET);
    vi.stubEnv('SESSION_COOKIE_SECRET_PREVIOUS', 'too-short');
    const { isWellFormedUnsubscribeToken, mintUnsubscribeRawToken } = await freshUnsubscribe();

    // A rollover typo must not silently degrade to current-key-only — that would
    // leave every delivered link failing the gate while the deploy looked healthy.
    // Minting is unaffected (it never reads the previous key), so the failure
    // surfaces precisely where the outgoing key would have been needed.
    const minted = mintUnsubscribeRawToken();
    expect(() => isWellFormedUnsubscribeToken(minted)).not.toThrow();
    expect(() => isWellFormedUnsubscribeToken(`${tokenHalves(minted).nonce}.${'A'.repeat(43)}`))
      .toThrow(/SESSION_COOKIE_SECRET_PREVIOUS.*at least 32 bytes/);
  });
});

describe('redemptionConfirmsSuppression', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_COOKIE_SECRET', TEST_SECRET);
  });

  // The success/failure partition must be asked for BY NAME, never derived from
  // the union's order or from `status !== 'unknown_token'` — which reads as a
  // reasonable success test and is wrong for exactly the one outcome that
  // matters. Adding a fifth outcome without answering this question is a tsc
  // error (the mapping is a total Record), not something this test has to catch.
  it.each([
    ['redeemed', true],
    ['already_suppressed', true],
    // A spent token whose suppression the audited Correction path removed. If
    // this ever flips to true, a recipient who is NOT suppressed is told they
    // are — the false-success class #644 exists to eliminate.
    ['already_redeemed_not_suppressed', false],
    ['unknown_token', false],
  ] as const)('%s may back an unsubscribed claim: %s', async (status, expected) => {
    const { redemptionConfirmsSuppression } = await freshUnsubscribe();

    expect(redemptionConfirmsSuppression({ status, tokenHashPrefix: 'abc123abc123' })).toBe(
      expected,
    );
  });

  it('rejects the naive not-unknown success test on the outcome that matters', async () => {
    const { redemptionConfirmsSuppression } = await freshUnsubscribe();
    const outcome = {
      status: 'already_redeemed_not_suppressed',
      tokenHashPrefix: 'abc123abc123',
    } as const;

    expect(outcome.status).not.toBe('unknown_token');
    expect(redemptionConfirmsSuppression(outcome)).toBe(false);
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
