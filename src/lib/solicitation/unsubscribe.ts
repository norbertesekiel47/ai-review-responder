import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { deploymentLaneFields, requiresProductionConfig } from '@/lib/config/deployment-lane';
import { isMockMode } from '@/lib/shared/mock-mode';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';
import {
  recordSuppression,
  SUPPRESSION_CHANNELS,
  type SuppressionChannel,
  type SuppressionSource,
} from './suppression';

/**
 * Unsubscribe token primitives (#644; plan §1.4a + §1.8). Pure and stateless —
 * no database work lives here, deliberately: the admission gate below is what
 * lets both opt-out surfaces stay unrate-limited (spec §9.2 forbids throttling a
 * statutory opt-out) without leaving an unbounded public path to Postgres.
 *
 * HMAC precedent: src/lib/account-offboarding/tokens.ts — same secret, same
 * versioned-context-string convention, same "only the SHA-256 hash is ever
 * persisted" posture (invariant #5). Node's own crypto throughout (invariant #10).
 *
 * Rotating SESSION_COOKIE_SECRET invalidates every already-delivered unsubscribe
 * link. That is an accepted document-only constraint, not an oversight — see
 * docs/superpowers/plans/feat-644-unsubscribe-opt-out-deviations.md D1. Do not
 * add a previous-secret fallback, and do not make the gate fail open.
 */

// Distinct from the receipt context so a MAC minted for one domain can never
// verify in the other.
const UNSUBSCRIBE_TOKEN_CONTEXT = 'repworth:solicitation-unsubscribe-token:v1';
const UNSUBSCRIBE_RECEIPT_CONTEXT = 'repworth:unsubscribe-receipt:v1';

// 16 bytes = 128 bits. The nonce only has to be unique — the MAC, not the nonce,
// is what makes a token unforgeable — and 128 bits makes a collision across
// every token this system will ever mint negligible.
const NONCE_BYTES = 16;

const RECEIPT_TTL_MS = 10 * 60 * 1000;

// Minted shapes are 66 chars (22-char nonce + '.' + 43-char MAC) and 57 chars
// (13-digit epoch ms + '.' + 43-char MAC). Bounding the input first means a
// megabyte of junk costs one length compare instead of an HMAC over it.
const MAX_SIGNED_INPUT_LENGTH = 128;

// Both halves are base64url so the whole token is URL-safe without escaping.
// `.` is outside the class, so exactly one separator can match.
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Invariant #5/#10. Exported for #630's minting so one function owns the digest. */
export function hashUnsubscribeToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mints `<nonce>.<HMAC-SHA256(secret, nonce)>`. #630 MUST call this rather than
 * rolling its own random string, or every delivered link fails the gate below.
 * Exporting the minter — not just a description of the format — is what makes
 * that constraint unbreakable.
 */
export function mintUnsubscribeRawToken(): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return `${nonce}.${signNonce(nonce)}`;
}

/**
 * The admission gate. Constant-time, stateless, ZERO database work — every entry
 * point calls this FIRST, so a forged or random string is rejected by one HMAC
 * compare without a connection ever being opened.
 *
 * Total over hostile input: any string returns a boolean. It does throw when
 * SESSION_COOKIE_SECRET is unset, and that is intentional — a misconfiguration
 * that silently reclassified every real opt-out as malformed would be a silent
 * statutory failure, so it has to surface.
 */
export function isWellFormedUnsubscribeToken(rawToken: string): boolean {
  if (rawToken.length > MAX_SIGNED_INPUT_LENGTH) return false;
  if (!TOKEN_SHAPE_RE.test(rawToken)) return false;

  const separator = rawToken.indexOf('.');
  const nonce = rawToken.slice(0, separator);
  return macMatches(signNonce(nonce), rawToken.slice(separator + 1));
}

/**
 * Boot gate for the secret the admission gate above depends on (deviations D4).
 *
 * Without it a worker boots perfectly clean, then throws inside
 * `isWellFormedUnsubscribeToken` for EVERY well-formed token, 503s each one, and
 * the provider retries forever — a statutory opt-out silently lost, with no boot
 * signal and no symptom distinguishable from a genuine unknown token (§5.4 makes
 * 503 the correct answer there too). `assertAccountOffboardingEnv` does not cover
 * this: it returns early unless ACCOUNT_OFFBOARDING_ENABLED='true', which is off.
 *
 * The token module owns its own secret-configured assertion rather than
 * `worker/config/startup-assert.ts`, following
 * `assertKeepMyDataTokenSecretConfigured` — callers never learn WHICH secret this
 * needs. Deployed-lane-and-non-mock gating mirrors `assertAlertSinkEnv`, so dev,
 * CI and tests stay unaffected.
 */
export function assertUnsubscribeTokenSecretConfigured(): void {
  if (!requiresProductionConfig()) return;
  if (isMockMode()) return;
  try {
    getSessionCookieSecret();
  } catch (err) {
    const { deployment_lane: lane, lane_source: source } = deploymentLaneFields();
    throw new Error(
      `[startup] Unsubscribe redemption requires SESSION_COOKIE_SECRET (${source ?? 'lane'}=${lane}): `
        + `${err instanceof Error ? err.message : String(err)} — without it every well-formed `
        + `opt-out fails as an unknown token, which CAN-SPAM §7704(a)(3) does not permit`,
    );
  }
}

/**
 * Server-minted evidence that a suppression existed when the redemption
 * committed, carried through the POST→redirect→GET hop without a cookie.
 *
 * NOT an authorisation token: it authorises nothing and grants no access. It
 * gates only whether the success view MAY be shown (plan §1.8); whether the
 * claim is actually true comes from a live ledger read at render time.
 */
export function mintUnsubscribeReceipt(tokenHash: string, issuedAtMs: number): string {
  return `${issuedAtMs}.${signReceipt(tokenHash, issuedAtMs)}`;
}

/** Total over hostile input, same contract as the token gate above. */
export function verifyUnsubscribeReceipt(tokenHash: string, receipt: string): boolean {
  if (receipt.length > MAX_SIGNED_INPUT_LENGTH) return false;

  const separator = receipt.indexOf('.');
  if (separator === -1) return false;

  const issuedAtRaw = receipt.slice(0, separator);
  // Digits only: Number() would otherwise accept '', ' 12', '1e3' and '0x10'.
  if (!/^\d+$/.test(issuedAtRaw)) return false;

  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAtMs)) return false;
  // Only the upper bound is enforced. A future-dated receipt can only come from
  // our own mint under a fast clock, and rejecting one would break the common
  // case — verifying moments after minting, on a different host.
  if (Date.now() - issuedAtMs > RECEIPT_TTL_MS) return false;

  return macMatches(signReceipt(tokenHash, issuedAtMs), receipt.slice(separator + 1));
}

// ── redemption ──────────────────────────────────────────────────────────────
// The stateless primitives above are the admission gate; everything below is
// the redemption core (#644 T1b; plan §1.3). Invariant #15: the executor is
// always an explicit parameter — this module never imports @/lib/db/server.

type SqlExecutor = Sql | TransactionSql;

/** The two recipient-authored sources (§3.1), derived rather than re-spelled. */
export type UnsubscribeRedemptionSource = Extract<
  SuppressionSource,
  'unsubscribe_one_click' | 'unsubscribe_link'
>;

/**
 * The four closed outcomes of a redemption. `already_redeemed_not_suppressed`
 * is deliberately distinct from `already_suppressed`: a spent token proves only
 * that it was ONCE redeemed, and the audited Correction path (§8.2) can have
 * removed the suppression since. Only the first two may claim success to the
 * recipient.
 */
export type UnsubscribeRedemption =
  | { status: 'redeemed'; tokenHashPrefix: string }
  | { status: 'already_suppressed'; tokenHashPrefix: string }
  | { status: 'already_redeemed_not_suppressed'; tokenHashPrefix: string }
  | { status: 'unknown_token'; tokenHashPrefix: string };

// The only loggable form of a token (invariant #5, §9.5): enough digest to
// correlate a provider retry with its first attempt, far too little to be worth
// anything to whoever reads the log.
const TOKEN_HASH_LOG_PREFIX_LENGTH = 12;

function logPrefix(tokenHash: string): string {
  return tokenHash.slice(0, TOKEN_HASH_LOG_PREFIX_LENGTH);
}

interface ClaimedTokenRow {
  account_id: string | null;
  business_id: string | null;
  normalized_handle: string;
  channel: string;
}

/**
 * §5.4's enumeration rule, enforced STRUCTURALLY rather than by remembering to
 * render the same page: unknown, malformed and already-redeemed are all one
 * `null`, so the landing page has nothing to distinguish them WITH. Read-only.
 *
 * Cross-account fail-closed: the business name resolves only when the business
 * belongs to the account that minted the token. A purge-scrubbed token has a
 * NULL `account_id`, so the join cannot match and the caller falls back to
 * generic copy — §5.5 permits naming exactly one business, the sender.
 */
export async function findRedeemableUnsubscribeToken(
  db: SqlExecutor,
  rawToken: string,
): Promise<{ businessName: string | null } | null> {
  // The admission gate FIRST, so a forged string costs one HMAC compare and no
  // connection at all (§1.4a). That is what lets this surface stay unrate-
  // limited, per §9.2, without an unbounded public path to Postgres.
  if (!isWellFormedUnsubscribeToken(rawToken)) return null;

  const [row] = await db<{ business_name: string | null }[]>`
    SELECT b.name AS business_name
    FROM solicitation_unsubscribe_tokens t
    LEFT JOIN businesses b
      ON b.id = t.business_id
     AND b.account_id = t.account_id
    WHERE t.token_hash = ${hashUnsubscribeToken(rawToken)}
      AND t.redeemed_at IS NULL
  `;
  if (row === undefined) return null;
  return { businessName: row.business_name };
}

/**
 * Exchanges an Unsubscribe token for a `scope='global'` Suppression ledger row.
 * Throws on infra failure; the four domain outcomes are RETURNED, because none
 * of them is exceptional on a public endpoint.
 *
 * CLAIM FIRST, THEN SUPPRESS (§1.3) — the ordering is load-bearing, not
 * stylistic. Suppressing first would let a replayed spent link silently undo an
 * audited Correction path removal, and would let a concurrent offboarding purge
 * produce a ledger row carrying stale non-null provenance where §5.2 requires
 * NULL. The claim is therefore the only write-ordering primitive, and it returns
 * the provenance it just locked.
 *
 * No ABBA deadlock: `recordSuppression` only inserts into the ledger, and this
 * holds the token row lock before that insert — consistently in one direction.
 */
export async function redeemUnsubscribeToken(
  tx: TransactionSql,
  input: { rawToken: string; source: UnsubscribeRedemptionSource },
): Promise<UnsubscribeRedemption> {
  if (!isWellFormedUnsubscribeToken(input.rawToken)) {
    // Indistinguishable from a genuine miss, with ZERO database work.
    return {
      status: 'unknown_token',
      tokenHashPrefix: logPrefix(hashUnsubscribeToken(input.rawToken)),
    };
  }

  const tokenHash = hashUnsubscribeToken(input.rawToken);
  const tokenHashPrefix = logPrefix(tokenHash);

  const [claimed] = await tx<ClaimedTokenRow[]>`
    UPDATE solicitation_unsubscribe_tokens
       SET redeemed_at = NOW()
     WHERE token_hash = ${tokenHash} AND redeemed_at IS NULL
     RETURNING account_id, business_id, normalized_handle, channel
  `;

  if (claimed !== undefined) {
    // The RETURNED values, never anything read before the claim: if the purge
    // committed its scrub first they are already NULL, and the ledger row then
    // correctly carries account_id = NULL.
    await recordSuppression(tx, {
      scope: 'global',
      channel: toSuppressionChannel(claimed.channel),
      normalizedHandle: claimed.normalized_handle,
      accountId: claimed.account_id,
      source: input.source,
    });
    // recordSuppression returns null when an existing row won first-write-wins.
    // That MUST NOT gate the outcome or the stamp — the claim already made it,
    // and a handle a complaint had already suppressed would otherwise leave this
    // token redeemable forever.
    return { status: 'redeemed', tokenHashPrefix };
  }

  // Nothing claimed. Disambiguate on `redeemed_at`, NEVER on bare existence: at
  // Read Committed this read takes a FRESH snapshot, so a token minted after the
  // UPDATE's snapshot surfaces here UNREDEEMED. Calling that success would be
  // exactly the mint-race lost opt-out this path exists to prevent; reporting it
  // as unknown lets the caller fail retryably instead.
  const [existing] = await tx<
    { redeemed_at: Date | null; normalized_handle: string; channel: string }[]
  >`
    SELECT redeemed_at, normalized_handle, channel
    FROM solicitation_unsubscribe_tokens
    WHERE token_hash = ${tokenHash}
  `;
  if (existing === undefined || existing.redeemed_at === null) {
    return { status: 'unknown_token', tokenHashPrefix };
  }

  // Spent — which proves only that it was once redeemed, not that a suppression
  // exists NOW. Ask the ledger. Deliberately not `suppressionMatchSql`: that
  // fragment answers the send-time gate question (global OR this account's own
  // row), while the success sentence asserts the recipient's own GLOBAL opt-out
  // still stands — an account-scoped row would satisfy the former and falsify
  // the latter. Either way there is NO write here, so a Correction path removal
  // stands.
  const [ledger] = await tx<{ suppressed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM solicitation_suppressions
      WHERE channel = ${existing.channel}
        AND normalized_handle = ${existing.normalized_handle}
        AND scope = 'global'
    ) AS suppressed
  `;
  return {
    // Defaulting the (unreachable) undefined row to the neutral outcome keeps
    // the conservative direction: never claim success we cannot evidence.
    status: ledger?.suppressed === true ? 'already_suppressed' : 'already_redeemed_not_suppressed',
    tokenHashPrefix,
  };
}

/**
 * The token table and the ledger carry independent channel CHECKs. Narrowing
 * here fails fast and legibly if they ever drift, rather than letting redemption
 * reach the ledger's CHECK with a value that table cannot express.
 */
function toSuppressionChannel(value: string): SuppressionChannel {
  const channel = SUPPRESSION_CHANNELS.find((candidate) => candidate === value);
  if (channel === undefined) {
    throw new Error(`unsubscribe token carries an unsupported channel: ${value}`);
  }
  return channel;
}

function signNonce(nonce: string): string {
  return createHmac('sha256', getSessionCookieSecret())
    .update(`${UNSUBSCRIBE_TOKEN_CONTEXT}:${nonce}`)
    .digest('base64url');
}

function signReceipt(tokenHash: string, issuedAtMs: number): string {
  return createHmac('sha256', getSessionCookieSecret())
    .update(`${UNSUBSCRIBE_RECEIPT_CONTEXT}:${tokenHash}:${issuedAtMs}`)
    .digest('base64url');
}

function macMatches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  // timingSafeEqual throws on unequal lengths. Comparing them first leaks
  // nothing secret: the MAC width is fixed and public.
  if (expectedBytes.length !== candidateBytes.length) return false;
  return timingSafeEqual(expectedBytes, candidateBytes);
}
