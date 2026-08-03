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
import { registerUnsubscribeRoutes } from '../../unsubscribe';

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

  // Siblings for the limiter matrix: one other ingress provider (which must stay
  // throttled) and one non-ingress route (which the hook must never touch).
  app.post('/ingress/resend', async () => ({ received: true }));
  app.get('/api/health', async () => ({ status: 'ok' }));

  return {
    app,
    fastifyLogLines: () => raw.map((line) => JSON.parse(line) as CapturedLogLine),
    rawFastifyLog: () => raw.join('\n'),
    close: () => app.close(),
  };
}
