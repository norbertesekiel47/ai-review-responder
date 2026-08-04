import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { getServerConfig } from '@/lib/config/server';
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
 * SIGNING-KEY ROLLOVER. `token_hash` is an UNKEYED SHA-256, so rotating
 * SESSION_COOKIE_SECRET never corrupts the lookup — it makes every
 * already-delivered link fail the gate BEFORE lookup while its row stays
 * perfectly redeemable. CAN-SPAM §7704(a)(3) requires the link operate ≥30 days,
 * and this secret also protects unrelated session and offboarding domains where a
 * compromise forces an emergency rotation you do not get to decline. So
 * verification accepts CURRENT-plus-PREVIOUS (`SESSION_COOKIE_SECRET_PREVIOUS`);
 * minting always uses the current key alone. Rollover procedure and the ≥30-day
 * retention window: .claude/reference/env-vars.md. Do not make the gate fail open.
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
  // Always the CURRENT key. A token minted under the outgoing key would outlive
  // the rollover window that exists to retire it.
  return `${nonce}.${signNonce(getSessionCookieSecret(), nonce)}`;
}

/**
 * The admission gate. Constant-time, stateless, ZERO database work — every entry
 * point calls this FIRST, so a forged or random string is rejected by one HMAC
 * compare without a connection ever being opened.
 *
 * Total over hostile input: any string returns a boolean. It does throw when
 * SESSION_COOKIE_SECRET is unset, and that is intentional — a misconfiguration
 * that silently reclassified every real opt-out as malformed would be a silent
 * statutory failure, so it has to surface. A configured-but-too-short
 * SESSION_COOKIE_SECRET_PREVIOUS throws for the same reason.
 */
export function isWellFormedUnsubscribeToken(rawToken: string): boolean {
  if (rawToken.length > MAX_SIGNED_INPUT_LENGTH) return false;
  if (!TOKEN_SHAPE_RE.test(rawToken)) return false;

  const separator = rawToken.indexOf('.');
  const nonce = rawToken.slice(0, separator);
  return macMatchesUnderAnySigningKey(
    (secret) => signNonce(secret, nonce),
    rawToken.slice(separator + 1),
  );
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
    // A configured-but-malformed SESSION_COOKIE_SECRET_PREVIOUS is a rollover
    // typo, and it throws per-request in the gate above. Asserting it here turns
    // that into a crash-loop the deploy surfaces immediately, instead of a 503 on
    // every opt-out — the same reasoning that put the current key in this gate.
    getPreviousSessionCookieSecret();
  } catch (err) {
    const { deployment_lane: lane, lane_source: source } = deploymentLaneFields();
    throw new Error(
      `[startup] Unsubscribe redemption requires a valid SESSION_COOKIE_SECRET (and a valid `
        + `SESSION_COOKIE_SECRET_PREVIOUS when one is set) (${source ?? 'lane'}=${lane}): `
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
 *
 * Takes the RAW token and derives the digest internally. Both functions used to
 * take the hash, which meant the mint site (`src/app/api/u/[token]/route.ts`)
 * and the verify site (`src/app/(public)/u/[token]/page.tsx`) each re-spelled
 * `hashUnsubscribeToken(...)` — and since mint and verify are symmetric and both
 * parameters were `string`, a ONE-SIDED slip produced no type error and no
 * runtime error. It produced receipts that silently stop verifying, sending a
 * recipient who *did* successfully unsubscribe to the Neutral page telling them
 * the link is not active — a false negative on the exact statutory claim §1.8
 * exists to make honest. The digest is this module's storage representation;
 * callers have no business holding it.
 */
export function mintUnsubscribeReceipt(rawToken: string, issuedAtMs: number): string {
  const tokenHash = hashUnsubscribeToken(rawToken);
  return `${issuedAtMs}.${signReceipt(getSessionCookieSecret(), tokenHash, issuedAtMs)}`;
}

/**
 * Total over hostile input, same contract as the token gate above. Takes the RAW
 * token for the same reason as the minter — the two are symmetric and must not be
 * able to disagree about what they are keyed on.
 */
export function verifyUnsubscribeReceipt(rawToken: string, receipt: string): boolean {
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

  // Hashed only after the cheap structural checks above, so a malformed receipt
  // costs no digest.
  const tokenHash = hashUnsubscribeToken(rawToken);

  // Current-plus-previous, same as the token gate. Lower stakes at a 10-minute
  // TTL, but a rollover must not blank the success page for a receipt that was
  // in flight across the deploy, and consistency here costs nothing.
  return macMatchesUnderAnySigningKey(
    (secret) => signReceipt(secret, tokenHash, issuedAtMs),
    receipt.slice(separator + 1),
  );
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
 * removed the suppression since.
 *
 * Which of these may face the recipient as success is NOT encoded in this
 * union's order — ask `redemptionConfirmsSuppression`.
 */
export type UnsubscribeRedemption =
  | { status: 'redeemed'; tokenHashPrefix: string }
  | { status: 'already_suppressed'; tokenHashPrefix: string }
  | { status: 'already_redeemed_not_suppressed'; tokenHashPrefix: string }
  | { status: 'unknown_token'; tokenHashPrefix: string };

/**
 * Derived from the union above, which stays the single owner of the outcome set.
 * Module-private on purpose: its only job is to make the record below total, and
 * no caller names it. A future consumer should write `UnsubscribeRedemption['status']`
 * rather than re-export this — the union is the exported owner, and one public
 * name for the outcome set is enough.
 */
type UnsubscribeRedemptionStatus = UnsubscribeRedemption['status'];

/**
 * Total by construction: `Record<UnsubscribeRedemptionStatus, …>` makes adding a
 * fifth outcome without deciding this question a COMPILE error, and makes the
 * answer independent of the union's order.
 */
const STATUS_CONFIRMS_SUPPRESSION: Readonly<Record<UnsubscribeRedemptionStatus, boolean>> = {
  // We just wrote the row, in this transaction.
  redeemed: true,
  // The spent branch read the live ledger and found the recipient's global row.
  already_suppressed: true,
  // DELIBERATELY FALSE. The token is spent but the audited Correction path
  // removed the suppression, so no global row exists to be truthful about.
  // Telling this recipient "you are unsubscribed" is precisely the false-success
  // class this ticket exists to eliminate.
  already_redeemed_not_suppressed: false,
  unknown_token: false,
};

/**
 * Whether this outcome may back a "you have been unsubscribed" CLAIM — the only
 * sanctioned way to ask that question.
 *
 * SCOPE, stated precisely because an earlier wording over-reached and one of its
 * two named callers did not keep it: this predicate governs whether a surface may
 * TELL A RECIPIENT a suppression exists — minting a Success receipt, rendering
 * the §5.5 success copy. Any code deciding that MUST call this rather than test
 * statuses itself, because `status !== 'unknown_token'` reads as a reasonable
 * success test and is wrong for exactly the one outcome that matters
 * (`already_redeemed_not_suppressed`).
 *
 * It does NOT govern the RFC 8058 ingress's HTTP mapping, and that surface is
 * right not to use it. A provider POST asks "did you receive and handle this?",
 * not "is this recipient suppressed?" — so all three non-`unknown_token` outcomes
 * are 200 there, deliberately. Answering 503 for
 * `already_redeemed_not_suppressed` would make the provider retry forever a token
 * that by design will never re-suppress. The asymmetry is intentional and both
 * halves are correct: the machine needs "handled", the recipient must never be
 * told they are suppressed when no global row exists.
 *
 * True means a `scope='global'` Suppression ledger row existed for this handle
 * when the redemption committed. It is NOT a promise that one exists *now* —
 * §1.8's success page re-reads the ledger at render time via
 * `hasLiveGlobalSuppressionForToken`.
 */
export function redemptionConfirmsSuppression(outcome: UnsubscribeRedemption): boolean {
  return STATUS_CONFIRMS_SUPPRESSION[outcome.status];
}

// The only loggable form of a token (invariant #5, §9.5): enough digest to
// correlate a provider retry with its first attempt, far too little to be worth
// anything to whoever reads the log.
const TOKEN_HASH_LOG_PREFIX_LENGTH = 12;

function logPrefix(tokenHash: string): string {
  return tokenHash.slice(0, TOKEN_HASH_LOG_PREFIX_LENGTH);
}

/**
 * The loggable form of a raw token, for callers that hold the raw value rather
 * than a redemption outcome (the ingress failure line). Exported as the
 * operation, not the length: an adapter needs "give me the safe prefix", never
 * "how long is it" — so the digest and its width keep exactly one owner here.
 */
export function unsubscribeTokenLogPrefix(rawToken: string): string {
  return logPrefix(hashUnsubscribeToken(rawToken));
}

interface ClaimedTokenRow {
  account_id: string | null;
  normalized_handle: string;
  channel: string;
}

/** The redemption target a token resolves to, plus the claim state. */
interface UnsubscribeTokenTarget {
  redeemedAt: Date | null;
  normalizedHandle: string;
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
 *
 * ⚠️ CALLER OBLIGATIONS — contracts, not preferences, and **NOTHING ENFORCES
 * THEM**. Not the type system, not CI, not the test suite: `TransactionSql` is
 * the same type whatever isolation level opened it. Prose is the only guard,
 * which is why it is stated this bluntly. **The safe way to call this is
 * `sql.begin((tx) => redeemUnsubscribeToken(tx, …))` with the callback body
 * containing nothing else.** Both shipped callers do exactly that
 * (`worker/ingress/unsubscribe.ts`, `src/app/api/u/[token]/route.ts`); copy one
 * of them rather than composing something new.
 *
 *  1. `tx` MUST be a READ COMMITTED transaction, which is what a plain
 *     `sql.begin()` gives you. Do NOT call this inside a REPEATABLE READ
 *     transaction — and note that **this domain already builds one**:
 *     `src/lib/solicitation/batch-view.ts` opens a REPEATABLE READ snapshot for
 *     its read-only view, so it is the nearest thing to hand and it is the wrong
 *     thing. Under REPEATABLE READ the claim raises a 40001 serialization
 *     failure instead of blocking on the row lock, which breaks this function's
 *     "domain outcomes are returned, not thrown" contract; and because the
 *     snapshot is pinned at the transaction's FIRST statement, a caller that read
 *     anything beforehand gets `unknown_token` for a token that WAS redeemed —
 *     an "invalid link" shown to someone who successfully opted out, with no
 *     error anywhere.
 *  2. The claim takes a ROW LOCK the caller's transaction holds until it
 *     commits. No remote call — provider HTTP, Sentry, analytics flush — may sit
 *     between this call and the commit (production.md: never hold a lock across
 *     a remote call). Commit, then do the remote work.
 *
 * WHY THE BOUNDARY IS STILL THE CALLER'S, and what would remove obligation 1
 * entirely: taking `db: Sql` and owning `sql.begin()` here would make the wrong
 * isolation level unrepresentable (invariant #15 is satisfied either way — the
 * executor stays an explicit parameter). That is the better shape and it is a
 * known, deliberate follow-up, not an oversight. It was not taken in this pass
 * because it is an interface change across both surfaces plus the ingress
 * single-flight, and there is no third caller today to force it. A runtime
 * isolation assertion was also considered and rejected: the only zero-extra-
 * round-trip hook is a `current_setting('transaction_isolation')` column on a
 * RETURNING/SELECT, and both are absent on exactly the no-row path where
 * obligation 1's failure lands — so it would cost a query per redemption on a
 * statutory hot path to detect the case it cannot see.
 */
export async function redeemUnsubscribeToken(
  tx: TransactionSql,
  input: { rawToken: string; source: UnsubscribeRedemptionSource },
): Promise<UnsubscribeRedemption> {
  if (!isWellFormedUnsubscribeToken(input.rawToken)) {
    // Indistinguishable from a genuine miss, with ZERO database work — and no
    // hashing either. Reachable for ANY gate rejection: wrong length, wrong
    // shape, or wrong MAC. (An earlier wording said "precisely when the gate
    // rejected on length", which is false — `aaa.bbb` reaches here already
    // length-bounded — and invited the conclusion that hashing would be safe.)
    //
    // No digest is taken because there is nothing to correlate: a token that was
    // never minted has no prior attempt and no row. That reason holds for all
    // three rejections. The length bound still matters independently — it is what
    // keeps a megabyte of junk to one length compare on an unauthenticated,
    // unrate-limited route — so do not add hashing here for any of them.
    return { status: 'unknown_token', tokenHashPrefix: '' };
  }

  const tokenHash = hashUnsubscribeToken(input.rawToken);
  const tokenHashPrefix = logPrefix(tokenHash);

  const [claimed] = await tx<ClaimedTokenRow[]>`
    UPDATE solicitation_unsubscribe_tokens
       SET redeemed_at = NOW()
     WHERE token_hash = ${tokenHash} AND redeemed_at IS NULL
     RETURNING account_id, normalized_handle, channel
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
  const target = await loadTokenTarget(tx, tokenHash);
  if (target === undefined || target.redeemedAt === null) {
    return { status: 'unknown_token', tokenHashPrefix };
  }

  // Spent — which proves only that it was once redeemed, not that a suppression
  // exists NOW. Ask the ledger; there is NO write on this path either way, so a
  // Correction path removal stands.
  return {
    status: (await hasLiveGlobalSuppression(tx, target))
      ? 'already_suppressed'
      : 'already_redeemed_not_suppressed',
    tokenHashPrefix,
  };
}

/**
 * §1.8's render-time check: does the recipient's own global opt-out stand RIGHT
 * NOW for this token's handle? The success page must ask this rather than trust
 * a receipt, because the audited Correction path (§8.2) can remove the row
 * between the redemption and the render.
 *
 * Read-only, and deliberately indifferent to `redeemed_at`: on the success page
 * the token is spent by definition, which is exactly why
 * `findRedeemableUnsubscribeToken` cannot answer this. `false` for an unknown
 * token, so an unmintable claim is never rendered.
 */
export async function hasLiveGlobalSuppressionForToken(
  db: SqlExecutor,
  rawToken: string,
): Promise<boolean> {
  if (!isWellFormedUnsubscribeToken(rawToken)) return false;

  const target = await loadTokenTarget(db, hashUnsubscribeToken(rawToken));
  if (target === undefined) return false;
  return hasLiveGlobalSuppression(db, target);
}

/** Resolves a token to its redemption target. One owner of this read. */
async function loadTokenTarget(
  db: SqlExecutor,
  tokenHash: string,
): Promise<UnsubscribeTokenTarget | undefined> {
  const [row] = await db<
    { redeemed_at: Date | null; normalized_handle: string; channel: string }[]
  >`
    SELECT redeemed_at, normalized_handle, channel
    FROM solicitation_unsubscribe_tokens
    WHERE token_hash = ${tokenHash}
  `;
  if (row === undefined) return undefined;
  return {
    redeemedAt: row.redeemed_at,
    normalizedHandle: row.normalized_handle,
    channel: row.channel,
  };
}

/**
 * THE single owner of "does the recipient's own global opt-out stand?" — asked
 * by the spent branch above and by §1.8's render-time check, which must never
 * disagree. A second hand-maintained copy of a compliance predicate is how the
 * two answers drift apart.
 *
 * Deliberately NOT `suppressionMatchSql`: that fragment answers the send-time
 * gate question ("may we contact this handle FOR THIS ACCOUNT?") and matches
 * `global` OR that account's `account`-scoped row. The §5.5 success sentence
 * asserts something stronger — that the recipient is opted out of every business
 * using RepWorth — so an owner's do-not-contact row would satisfy that fragment
 * while making the sentence false. Distinct question, distinct query.
 */
async function hasLiveGlobalSuppression(
  db: SqlExecutor,
  target: Pick<UnsubscribeTokenTarget, 'channel' | 'normalizedHandle'>,
): Promise<boolean> {
  const [ledger] = await db<{ suppressed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM solicitation_suppressions
      WHERE channel = ${target.channel}
        AND normalized_handle = ${target.normalizedHandle}
        AND scope = 'global'
    ) AS suppressed
  `;
  // The (unreachable) missing row defaults to false — the conservative
  // direction: never claim an opt-out we cannot evidence.
  return ledger?.suppressed === true;
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

/**
 * The OUTGOING signing key mid-rollover, or `undefined` when none is configured.
 *
 * Unset/empty is the steady state, so it is NOT an error — but a key that IS set
 * and too short to be an HMAC-SHA256 key is a rollover typo, and it throws rather
 * than being skipped: silently ignoring it would leave every already-delivered
 * link failing the gate while the deploy looked healthy, which is the exact
 * silent statutory failure this whole mechanism exists to prevent.
 *
 * Validation mirrors `getSessionCookieSecret` byte-for-byte, including treating
 * a whitespace-only value as present-and-invalid. It lives here rather than
 * beside its sibling in src/lib/shared/session-cookie-secret.ts only because the
 * unsubscribe domain is the sole consumer of key rollover today; when a second
 * domain adopts it, promote this function there so the pair keeps one owner.
 */
function getPreviousSessionCookieSecret(): string | undefined {
  const secret = getServerConfig().SESSION_COOKIE_SECRET_PREVIOUS;
  if (!secret) return undefined;
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_COOKIE_SECRET_PREVIOUS must be at least 32 bytes (256-bit HMAC key)');
  }
  return secret;
}

/**
 * Verifies a MAC against the current signing key, then — only on a miss, and only
 * when one is configured — against the previous one. Callers pass a signer rather
 * than a precomputed MAC so neither context string is ever re-spelled here.
 *
 * The current key is read FIRST and unconditionally, so a missing
 * SESSION_COOKIE_SECRET still throws: the previous key is a rollover affordance,
 * never a way to keep running without the real one.
 */
function macMatchesUnderAnySigningKey(
  sign: (secret: string) => string,
  candidate: string,
): boolean {
  if (macMatches(sign(getSessionCookieSecret()), candidate)) return true;

  const previous = getPreviousSessionCookieSecret();
  if (previous === undefined) return false;
  return macMatches(sign(previous), candidate);
}

function signNonce(secret: string, nonce: string): string {
  return createHmac('sha256', secret)
    .update(`${UNSUBSCRIBE_TOKEN_CONTEXT}:${nonce}`)
    .digest('base64url');
}

function signReceipt(secret: string, tokenHash: string, issuedAtMs: number): string {
  return createHmac('sha256', secret)
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
