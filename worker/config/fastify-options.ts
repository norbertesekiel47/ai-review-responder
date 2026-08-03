import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import { redactSensitivePathsAndQueries } from '@/lib/shared/sentry-scrub';

/**
 * Ingress server limits. Fastify's defaults leave requestTimeout at 0
 * (disabled) and no explicit body cap — a slow-loris or slow-body client
 * could exhaust the single Railway worker's connections and block
 * Stripe/Zernio webhooks. Values are owner-selected (prod-hardening spec):
 * 30s request / 60s keep-alive / 10s connect, 5 MB body (headroom for batch
 * Zernio payloads; webhooks are otherwise small).
 *
 * `productionConfigRequired` is the already-made decision, not an env string:
 * the caller resolves the deployment lane (`requiresProductionConfig()`) and
 * passes the answer in, so this module stays free of `process.env`.
 *
 * The logger block also owns URL redaction for the whole ingress server. A
 * route-level `logLevel: 'silent'` applies only AFTER the exact route resolves,
 * so it cannot reach an unmatched 404 like /ingress/unsubscribe/<token>/extra —
 * only global config can, and it must, or the raw Unsubscribe token reaches the
 * logs (invariant #5).
 *
 * Fastify writes a request URL into three shapes, and the ones production
 * actually emits are the error ones: `incoming request` and the default 404
 * message are level 30, BELOW the prod `warn` threshold, while
 * FST_ERR_REP_ALREADY_SENT is 40 and the default 5xx handler is 50. Two
 * mechanisms cover all three — `serializers.req` for `req.url`, and pino's
 * `redact` for `msg` and the serialized error. The rule itself is
 * `redactSensitivePathsAndQueries`, shared with the Sentry scrubber.
 */
export function buildFastifyOptions(productionConfigRequired: boolean): FastifyServerOptions {
  return {
    logger: {
      level: productionConfigRequired ? 'warn' : 'info',
      // The message and the serialized error. FST_ERR_REP_ALREADY_SENT
      // interpolates request.url into its message (fastify/lib/reply.js) and
      // logs `{ err }` with NO string argument, and pino derives `msg` from the
      // raw error — so neither is reachable from a log-method hook over string
      // arguments. Redacting here instead is what makes this the right seam:
      // pino applies it AFTER serialization, so it censors the cause-flattened
      // `message`/`stack` that `stdSerializers.err` produces while leaving that
      // serializer, and every other field it emits (type, code, statusCode,
      // aggregateErrors), completely untouched.
      redact: {
        paths: ['msg', 'err.message', 'err.stack'],
        censor: (value: unknown) =>
          typeof value === 'string' ? redactSensitivePathsAndQueries(value) : value,
      },
      serializers: {
        // The request object on the `incoming request` line, which Fastify emits
        // before onRequest and before any route resolves, copying request.url
        // verbatim. Field-for-field identical to Fastify's own serializer
        // (fastify/lib/logger-pino.js) apart from the redacted url: this is a
        // redaction change and must not narrow ingress diagnostics for the other
        // providers (Stripe, Resend, Twilio, Telegram, Zernio).
        req: (request: FastifyRequest) => {
          // Node only yields an array here for a repeated header, which it
          // otherwise joins itself; matching that keeps the field a string.
          const acceptVersion = request.headers['accept-version'];
          return {
            method: request.method,
            url: redactSensitivePathsAndQueries(request.url),
            version: Array.isArray(acceptVersion) ? acceptVersion.join(', ') : acceptVersion,
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    requestTimeout: 30_000,
    keepAliveTimeout: 60_000,
    connectionTimeout: 10_000,
    bodyLimit: 5 * 1024 * 1024,
  };
}
