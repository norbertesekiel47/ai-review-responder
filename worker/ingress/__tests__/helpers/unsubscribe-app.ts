// Shared harness for the #644 unsubscribe ingress suites.
//
// Everything here drives a REAL (non-listening) Fastify instance through
// `app.inject()`, wired exactly the way `worker/index.ts` wires it: the global
// options from `buildFastifyOptions`, the ingress content-type parsers, the
// ingress rate-limit hook, then the routes. A unit test of a string predicate
// would have passed while production failed — which is precisely how the
// `/%69ngress/…` limiter bypass shipped — so the tests pay for a real router.

import Fastify, { type FastifyInstance } from 'fastify';
import { registerIngressContentTypeParsers } from '../../../config/content-type-parsers';
import { buildFastifyOptions } from '../../../config/fastify-options';
import { registerIngressRateLimitHook } from '../../rate-limit';
import { handleResendWebhook } from '../../resend';
import { registerUnsubscribeRoutes } from '../../unsubscribe';

/**
 * Every non-unsubscribe ingress path `worker/index.ts` registers, spelled the
 * same way. The limiter hook is general policy for all five providers and D11
 * records that its predecessor was bypassable on every one of them, so "every
 * other ingress path" has to mean these — not one convenience stub, which is
 * what it used to mean. `unsubscribe-rate-limit.test.ts` pins this list against
 * `worker/index.ts` so it cannot drift silently.
 *
 * `/ingress/resend` carries the REAL handler: it fails signature verification
 * and answers 401 before touching the database, which is enough to prove the
 * hook runs ahead of a genuine provider handler rather than only ahead of a
 * closure this file wrote. The other four are stubs — the hook is `onRequest`,
 * so it fires before routing reaches any handler body, and importing four more
 * provider modules would buy nothing for this property.
 */
export const SIBLING_INGRESS_PATHS = [
  '/ingress/stripe',
  '/ingress/telegram',
  '/ingress/twilio/whatsapp-inbound',
  '/ingress/twilio/whatsapp-status',
  '/ingress/zernio',
] as const;

export const REAL_HANDLER_INGRESS_PATH = '/ingress/resend';

export interface CapturedLogLine {
  level?: number;
  msg?: string;
  req?: Record<string, unknown>;
  err?: Record<string, unknown>;
}

export interface UnsubscribeTestApp {
  app: FastifyInstance;
  /** Every line the Fastify (pino) logger wrote, parsed. */
  fastifyLogLines: () => CapturedLogLine[];
  /** The raw log text, for whole-output "must not contain" assertions. */
  rawFastifyLog: () => string;
  close: () => Promise<void>;
}

/**
 * `productionConfigRequired` is REQUIRED, never defaulted: the two log levels
 * see disjoint sets of lines (`incoming request` and the 404 message are level
 * 30; the 5xx handler and the double-send warning are 50/40). A harness pinned
 * to one lane can only ever prove half the redaction — the T1a Critical.
 */
export function buildUnsubscribeTestApp(input: {
  productionConfigRequired: boolean;
}): UnsubscribeTestApp {
  const raw: string[] = [];
  const options = buildFastifyOptions(input.productionConfigRequired);
  const loggerOptions = options.logger;
  if (typeof loggerOptions !== 'object' || loggerOptions === null) {
    throw new Error('buildFastifyOptions must configure an object logger');
  }

  const app = Fastify({
    ...options,
    logger: {
      ...loggerOptions,
      stream: {
        write: (line: string) => {
          raw.push(line);
        },
      },
    },
  });

  registerIngressContentTypeParsers(app);
  registerIngressRateLimitHook(app);
  registerUnsubscribeRoutes(app);

  // Siblings for the limiter matrix: every other ingress path the worker
  // registers (all must stay throttled) and one non-ingress route (which the
  // hook must never touch).
  app.post(REAL_HANDLER_INGRESS_PATH, handleResendWebhook);
  for (const siblingPath of SIBLING_INGRESS_PATHS) {
    app.post(siblingPath, async () => ({ received: true }));
  }
  app.get('/api/health', async () => ({ status: 'ok' }));

  return {
    app,
    fastifyLogLines: () => raw.map((line) => JSON.parse(line) as CapturedLogLine),
    rawFastifyLog: () => raw.join('\n'),
    close: () => app.close(),
  };
}
