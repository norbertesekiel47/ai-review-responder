// RFC 8058 one-click unsubscribe ingress (#644; plan §1.4–§1.7, spec §9.1–§9.5).
//
// The Railway half of the opt-out path: it exchanges an Unsubscribe token for a
// `scope='global'` Suppression ledger row, and redirects a human GET to the
// landing page. Unlike every other handler in this folder there is NO signature,
// NO rawBody and NO `claimInboundEvent` — idempotency comes from the redemption
// core's claim-first ordering plus `redeemed_at`, so a provider re-POST is a 200
// no-op by construction rather than by a dedup table.
//
// Two contracts govern everything below and neither is negotiable:
//   * 2xx ONLY after the transaction commits (§9.1). A 2xx on an uncommitted
//     write is a lost opt-out the provider believes it delivered — the worst and
//     quietest failure in this system.
//   * The raw token never reaches a log, a Sentry event, or Postgres
//     (invariant #5). Worker log redaction is ENUMERATED rather than structural
//     (deviations D7), so this module sanitizes before it logs rather than
//     trusting the sink.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sql } from '../../src/lib/db/server';
import { createWorkerLogger, toError } from '../../src/lib/shared/logger';
import { reportCaughtError } from '../../src/lib/shared/report-caught-error';
import { redactSensitivePathsAndQueries } from '../../src/lib/shared/sentry-scrub';
import { readReplicaIdentity, replicaIdentityFields } from '../config/replica-identity';
import {
  isWellFormedUnsubscribeToken,
  redeemUnsubscribeToken,
} from '../../src/lib/solicitation/unsubscribe';

const LOG_PREFIX = '[ingress/unsubscribe]';
const ENDPOINT = 'ingress/unsubscribe';
const REDACTED = '[REDACTED]';

const logger = createWorkerLogger(LOG_PREFIX);

const UNSUBSCRIBE_ROUTE_PATH = '/ingress/unsubscribe/:token';

const UNSUBSCRIBE_ROUTE_OPTS = {
  // §9.2 forbids throttling a statutory opt-out. The exemption is read from the
  // RESOLVED route config, so an unmatched path under this prefix can never
  // inherit it (see worker/ingress/rate-limit.ts).
  config: { skipIngressRateLimit: true },
  // Fastify writes `incoming request` BEFORE onRequest and before the handler,
  // copying the raw URL — and therefore the raw token — verbatim. Defence in
  // depth only: this applies after the exact route resolves, so the global
  // request serializer in worker/config/fastify-options.ts is what covers the
  // unmatched-404 case this can never reach.
  logLevel: 'silent',
  // §1.4b. RFC 8058 §3.1 bodies are `List-Unsubscribe=One-Click`, ~30 bytes; the
  // app-wide default is 5 MB. Exempt from the limiter is not exempt from bounds.
  bodyLimit: 1024,
} as const;

interface UnsubscribeRouteParams {
  token: string;
}

type UnsubscribeRequest = FastifyRequest<{ Params: UnsubscribeRouteParams }>;

/** Which half of the adapter failed — a Sentry tag, never free text. */
type FailureStage = 'redeem' | 'redirect';

/**
 * Both routes and their shared options live here rather than at the composition
 * root because those options ARE the security contract (limiter exemption,
 * silenced request log, 1 KB body cap). One owner means a test can exercise the
 * real registration instead of a copy that can drift from it.
 */
export function registerUnsubscribeRoutes(app: FastifyInstance): void {
  app.post<{ Params: UnsubscribeRouteParams }>(
    UNSUBSCRIBE_ROUTE_PATH,
    UNSUBSCRIBE_ROUTE_OPTS,
    handleUnsubscribePost,
  );
  app.get<{ Params: UnsubscribeRouteParams }>(
    UNSUBSCRIBE_ROUTE_PATH,
    UNSUBSCRIBE_ROUTE_OPTS,
    handleUnsubscribeGet,
  );
}

/**
 * The machine path: RFC 8058 §3.1's one-click POST. The body is parsed by the
 * app-wide urlencoded parser and deliberately ignored — the token is the only
 * input, and it comes from the path.
 */
export async function handleUnsubscribePost(
  request: UnsubscribeRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawToken = request.params.token;
  try {
    // The §1.4a admission gate FIRST. A forged string costs one HMAC compare and
    // opens no connection at all — that is what lets this route stay unrate-
    // limited without leaving an unbounded public path to Postgres. It throws
    // when SESSION_COOKIE_SECRET is missing, which the catch below turns into a
    // loud 503 rather than a silent reclassification of every genuine opt-out.
    if (!isWellFormedUnsubscribeToken(rawToken)) {
      replyUnknownToken(reply);
      return;
    }

    // postgres.js resolves `begin` only after COMMIT is acknowledged, so nothing
    // in this function may answer from inside the callback (§9.1).
    const redemption = await sql.begin((tx) =>
      redeemUnsubscribeToken(tx, { rawToken, source: 'unsubscribe_one_click' }),
    );

    if (redemption.status === 'unknown_token') {
      replyUnknownToken(reply);
      return;
    }

    // §9.5. The field is `hash_prefix`, NOT `token_hash_prefix`: createWorkerLogger
    // routes object args through the analytics blocked-key sanitizer, which drops
    // any key containing "token", so the correlating value would silently vanish.
    logger.log('Unsubscribe redemption', {
      outcome: redemption.status,
      hash_prefix: redemption.tokenHashPrefix,
    });
    reply.status(200).send({ received: true });
  } catch (err) {
    failClosed(reply, err, rawToken, 'redeem');
  }
}

/**
 * The human path: a recipient who clicked the link in a mail client that follows
 * it as a GET. Writes nothing and deliberately does NOT gate the token — unknown,
 * malformed and already-redeemed must all reach the SAME neutral page (§5.4), and
 * 503-ing a forged token here would be the one answer that distinguishes them.
 */
export function handleUnsubscribeGet(request: UnsubscribeRequest, reply: FastifyReply): void {
  const rawToken = request.params.token;
  try {
    reply.redirect(landingPageUrl(rawToken), 302);
  } catch (err) {
    failClosed(reply, err, rawToken, 'redirect');
  }
}

function landingPageUrl(rawToken: string): string {
  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL is unset — the unsubscribe landing page is unreachable');
  }
  // encodeURIComponent is load-bearing: Fastify decodes the path parameter, so a
  // token delivered as `a%2Fb` arrives as `a/b` and would otherwise be re-emitted
  // as a TWO-segment path that 404s instead of reaching the neutral page.
  return `${appUrl.replace(/\/+$/, '')}/u/${encodeURIComponent(rawToken)}`;
}

function replyUnknownToken(reply: FastifyReply): void {
  recordUnknownUnsubscribeToken();
  // 503, not 404: a token minted after this transaction's snapshot surfaces as
  // unknown, and only a retryable status keeps that mint race recoverable (§1.7).
  // It preserves the POSSIBILITY of recovery; it does not guarantee it.
  reply.status(503).send({ error: 'unavailable' });
}

/**
 * The adapter reports and answers for itself rather than rethrowing. Fastify's
 * default error handler logs through a serializer that has historically carried
 * the raw URL, and the enumerated redaction in fastify-options.ts is a contract
 * rather than a complete defence (D7) — so the safest move is never to hand this
 * error to the framework at all.
 */
function failClosed(
  reply: FastifyReply,
  err: unknown,
  rawToken: string,
  stage: FailureStage,
): void {
  const sanitized = sanitizeErrorInPlace(toError(err), rawToken);
  // reportCaughtError owns the guarded Sentry capture plus one structured line;
  // the error rides under the logger's own error slot, never a custom key.
  reportCaughtError(ENDPOINT, sanitized, { outcome: 'failed', stage });
  reply.status(503).send({ error: 'unavailable' });
}

/**
 * Strips the raw token out of an error before either sink sees it. Two passes,
 * because neither alone is enough: the shared URL rule covers the URL-shaped
 * spellings (including percent-encoded prefixes), and the literal containment
 * pass covers every other shape a message or stack could embed it in.
 *
 * Mutating rather than wrapping is deliberate — a `cause` chain would be
 * serialized by Sentry's linked-errors integration with the ORIGINAL text, and a
 * freshly constructed Error would throw away the frames that make the failure
 * diagnosable.
 */
function sanitizeErrorInPlace(error: Error, rawToken: string): Error {
  error.message = sanitizeText(error.message, rawToken);
  if (typeof error.stack === 'string') {
    error.stack = sanitizeText(error.stack, rawToken);
  }
  return error;
}

function sanitizeText(text: string, rawToken: string): string {
  const redacted = redactSensitivePathsAndQueries(text);
  if (rawToken.length === 0) return redacted;
  return redacted.split(rawToken).join(REDACTED);
}

// ── bounded observability for unknown tokens ────────────────────────────────
// Plan §1.6. The route is deliberately unauthenticated and unrate-limited, so
// *per-request* observability is itself an amplification vector. An unknown token
// is EXPECTED traffic on a public endpoint, not an exception: worker Sentry has
// no error sampling and no dedup, so reporting scanner traffic there is unbounded
// event volume, and one log line per request would drown the very mint-race
// signal the line exists to surface.
//
// So unknown tokens are COUNTED — never reported, never logged per request. One
// aggregated warning per window per process, and that bound holds regardless of
// traffic volume. Every line carries the replica identity, which is what makes
// the series summable: a cross-deployment overlap during a zero-downtime deploy
// produces two tagged series that add up rather than one that under-reports.
//
// The window is a RATE signal and feeds no correctness decision. A partial window
// is flushed by the graceful-shutdown sequence in worker/index.ts; an ungraceful
// crash loses at most 60s of counts, which is acceptable precisely because
// nothing depends on it — unlike an opt-out, which never is.
//
// This lives beside the handler rather than in its own file only because the
// ticket's declared edit surface enumerates files; the injectable factory below
// is what the tests drive, so determinism does not depend on the file boundary.

export const UNKNOWN_TOKEN_WINDOW_MS = 60_000;

const WINDOW_EVENT = 'unsubscribe_unknown_token_window';

/**
 * Injected so tests are deterministic without reaching into global timers.
 * `schedule` returns its own cancel function — the shape the graceful-shutdown
 * watchdog already uses — so no caller ever handles a platform timer handle.
 */
export interface UnknownTokenWindowClock {
  now: () => number;
  schedule: (onExpiry: () => void, ms: number) => () => void;
}

export interface UnknownTokenReporterDeps {
  windowMs: number;
  clock: UnknownTokenWindowClock;
  warn: (message: string, fields: Record<string, unknown>) => void;
  identityFields: () => Record<string, string>;
}

export interface UnknownTokenReporter {
  /** Count one unknown token. Never logs, never reports, never throws. */
  record: () => void;
  /** Flush a partial window and cancel the pending timer. Idempotent. */
  stop: () => void;
}

export function createUnknownTokenReporter(deps: UnknownTokenReporterDeps): UnknownTokenReporter {
  let count = 0;
  let windowStartMs = 0;
  let cancelTimer: (() => void) | null = null;

  function emit(): void {
    if (count === 0) return;
    const observed = count;
    // Reset BEFORE the sink call so a throwing logger cannot double-count the
    // same window into the next flush.
    count = 0;
    deps.warn('Unknown unsubscribe tokens in window', {
      event: WINDOW_EVENT,
      count: observed,
      window_start: new Date(windowStartMs).toISOString(),
      window_end: new Date(deps.clock.now()).toISOString(),
      ...deps.identityFields(),
    });
  }

  return {
    record: () => {
      count += 1;
      // A window is opened by the FIRST unknown token and is never re-armed while
      // open, so no volume of traffic can produce a second line inside it — and no
      // timer runs at all while the endpoint is quiet.
      if (cancelTimer !== null) return;
      windowStartMs = deps.clock.now();
      cancelTimer = deps.clock.schedule(() => {
        cancelTimer = null;
        emit();
      }, deps.windowMs);
    },
    stop: () => {
      cancelTimer?.();
      cancelTimer = null;
      emit();
    },
  };
}

const processReporter = createUnknownTokenReporter({
  windowMs: UNKNOWN_TOKEN_WINDOW_MS,
  clock: {
    now: () => Date.now(),
    schedule: (onExpiry, ms) => {
      const timer = setTimeout(onExpiry, ms);
      // Unref'd: a pending telemetry window must never be why the process lives on.
      timer.unref();
      return () => clearTimeout(timer);
    },
  },
  warn: (message, fields) => logger.warn(message, fields),
  identityFields: () => replicaIdentityFields(readReplicaIdentity()),
});

export const recordUnknownUnsubscribeToken = processReporter.record;
export const stopUnknownUnsubscribeTokenWindow = processReporter.stop;
